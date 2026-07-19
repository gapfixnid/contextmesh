import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import type {
  CodeEdgeKind,
  CodeEdgeRecord,
  CodeEcosystem,
  CodeLanguage,
  CodeNodeKind,
  CodeNodeRecord,
  IndexedSourceFile,
  UnresolvedReferenceRecord,
} from "../../contracts.js";
import { clampText, sha256 } from "../../utils.js";
import type { LanguageAdapter, OverlayPrecisionProvider, PrecisionOverlayBatch, ProjectDescriptor, SyntaxGraphBatch, SyntaxProvider } from "../providers.js";
import { GoTypesProvider } from "./go-precision.js";

type CoreLanguage = Extract<CodeLanguage, "go" | "rust" | "java" | "csharp">;

interface LanguageSpec {
  language: CoreLanguage;
  ecosystem: CodeEcosystem;
  extension: string;
  provider: string;
  manifests: string[];
  declarations: Array<{ pattern: RegExp; kind: CodeNodeKind; nameGroup: number; nativeKind: string }>;
  importPattern: RegExp;
  callPattern: RegExp;
  callNameGroup: number;
  callExcludes: Set<string>;
}

const COMMON_CALL_EXCLUDES = new Set(["if", "for", "while", "switch", "catch", "return", "new", "sizeof", "typeof", "match"]);

const SPECS: Record<CoreLanguage, LanguageSpec> = {
  go: {
    language: "go", ecosystem: "go", extension: ".go", provider: "contextmesh_go_syntax", manifests: ["go.mod", "go.work"],
    declarations: [
      { pattern: /^\s*func\s+(?:\([^)]*\)\s*)?([\p{L}_][\p{L}\p{N}_]*)\s*\(/gmu, kind: "function", nameGroup: 1, nativeKind: "function_declaration" },
      { pattern: /^\s*type\s+([\p{L}_][\p{L}\p{N}_]*)\s+struct\b/gmu, kind: "class", nameGroup: 1, nativeKind: "type_struct" },
      { pattern: /^\s*type\s+([\p{L}_][\p{L}\p{N}_]*)\s+interface\b/gmu, kind: "interface", nameGroup: 1, nativeKind: "type_interface" },
      { pattern: /^\s*(?:var|const)\s+([\p{L}_][\p{L}\p{N}_]*)\b/gmu, kind: "variable", nameGroup: 1, nativeKind: "value_spec" },
    ],
    importPattern: /(?:^|\n)\s*(?:import\s+(?:[\p{L}_][\p{L}\p{N}_]*\s+)?"([^"]+)"|(?:[\p{L}_][\p{L}\p{N}_]*\s+)?"([^"]+)")/gmu,
    callPattern: /\b([\p{L}_][\p{L}\p{N}_]*)\s*\(/gu, callNameGroup: 1,
    callExcludes: new Set([...COMMON_CALL_EXCLUDES, "func", "make", "append", "len", "cap", "close", "delete", "panic", "recover"]),
  },
  rust: {
    language: "rust", ecosystem: "cargo", extension: ".rs", provider: "contextmesh_rust_syntax", manifests: ["Cargo.toml", "Cargo.lock"],
    declarations: [
      { pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([\p{L}_][\p{L}\p{N}_]*)\s*(?:<[^>]*>)?\s*\(/gmu, kind: "function", nameGroup: 1, nativeKind: "function_item" },
      { pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([\p{L}_][\p{L}\p{N}_]*)\b/gmu, kind: "class", nameGroup: 1, nativeKind: "struct_item" },
      { pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([\p{L}_][\p{L}\p{N}_]*)\b/gmu, kind: "interface", nameGroup: 1, nativeKind: "trait_item" },
      { pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([\p{L}_][\p{L}\p{N}_]*)\b/gmu, kind: "enum", nameGroup: 1, nativeKind: "enum_item" },
      { pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([\p{L}_][\p{L}\p{N}_]*)\b/gmu, kind: "type_alias", nameGroup: 1, nativeKind: "type_item" },
    ],
    importPattern: /^\s*(?:pub\s+)?use\s+([^;]+);/gmu,
    callPattern: /\b([\p{L}_][\p{L}\p{N}_]*)\s*(?:::<[^>]*>)?\s*\(/gu, callNameGroup: 1,
    callExcludes: new Set([...COMMON_CALL_EXCLUDES, "fn", "Some", "Ok", "Err", "vec"]),
  },
  java: {
    language: "java", ecosystem: "maven", extension: ".java", provider: "contextmesh_java_syntax_prototype", manifests: ["pom.xml", "build.gradle", "build.gradle.kts"],
    declarations: [
      { pattern: /\bclass\s+([\p{L}_$][\p{L}\p{N}_$]*)\b/gu, kind: "class", nameGroup: 1, nativeKind: "class_declaration" },
      { pattern: /\binterface\s+([\p{L}_$][\p{L}\p{N}_$]*)\b/gu, kind: "interface", nameGroup: 1, nativeKind: "interface_declaration" },
      { pattern: /\benum\s+([\p{L}_$][\p{L}\p{N}_$]*)\b/gu, kind: "enum", nameGroup: 1, nativeKind: "enum_declaration" },
      { pattern: /^\s*(?:@[\w.]+\s+)*(?:(?:public|protected|private|static|final|abstract|synchronized|native|default)\s+)*(?:[\w.$<>?,[\]]+\s+)+([\p{L}_$][\p{L}\p{N}_$]*)\s*\([^;{}]*\)\s*(?:throws\s+[^{]+)?\{/gmu, kind: "method", nameGroup: 1, nativeKind: "method_declaration" },
    ],
    importPattern: /^\s*import\s+(?:static\s+)?([^;]+);/gmu,
    callPattern: /\b([\p{L}_$][\p{L}\p{N}_$]*)\s*\(/gu, callNameGroup: 1,
    callExcludes: new Set([...COMMON_CALL_EXCLUDES, "super", "this", "synchronized"]),
  },
  csharp: {
    language: "csharp", ecosystem: "nuget", extension: ".cs", provider: "contextmesh_csharp_syntax_prototype", manifests: [],
    declarations: [
      { pattern: /\bclass\s+([\p{L}_][\p{L}\p{N}_]*)\b/gu, kind: "class", nameGroup: 1, nativeKind: "class_declaration" },
      { pattern: /\binterface\s+([\p{L}_][\p{L}\p{N}_]*)\b/gu, kind: "interface", nameGroup: 1, nativeKind: "interface_declaration" },
      { pattern: /\benum\s+([\p{L}_][\p{L}\p{N}_]*)\b/gu, kind: "enum", nameGroup: 1, nativeKind: "enum_declaration" },
      { pattern: /^\s*(?:(?:public|protected|private|internal|static|virtual|override|abstract|async|sealed|extern|unsafe|new|partial)\s+)*(?:[\w.<>?,[\]]+\s+)+([\p{L}_][\p{L}\p{N}_]*)\s*\([^;{}]*\)\s*(?:where\s+[^{]+)?\{/gmu, kind: "method", nameGroup: 1, nativeKind: "method_declaration" },
    ],
    importPattern: /^\s*(?:global\s+)?using\s+(?:[\p{L}_][\p{L}\p{N}_]*\s*=\s*)?([^;]+);/gmu,
    callPattern: /\b([\p{L}_][\p{L}\p{N}_]*)\s*\(/gu, callNameGroup: 1,
    callExcludes: new Set([...COMMON_CALL_EXCLUDES, "base", "this", "lock", "using"]),
  },
};

function byteOffset(source: string, index: number): number { return Buffer.byteLength(source.slice(0, index), "utf8"); }

function location(source: string, index: number): { line: number; column: number } {
  const prefix = source.slice(0, index);
  const line = prefix.split("\n").length;
  const last = prefix.lastIndexOf("\n");
  return { line, column: index - last };
}

function maskTrivia(source: string): string {
  let output = "";
  let index = 0;
  let state: "code" | "line" | "block" | "single" | "double" | "backtick" = "code";
  while (index < source.length) {
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (state === "code" && current === "/" && next === "/") { state = "line"; output += "  "; index += 2; continue; }
    if (state === "code" && current === "/" && next === "*") { state = "block"; output += "  "; index += 2; continue; }
    if (state === "line") { output += current === "\n" ? "\n" : " "; if (current === "\n") state = "code"; index += 1; continue; }
    if (state === "block") { output += current === "\n" ? "\n" : " "; if (current === "*" && next === "/") { output += " "; index += 2; state = "code"; } else index += 1; continue; }
    if (state === "code" && (current === "'" || current === '"' || current === "`")) { state = current === "'" ? "single" : current === '"' ? "double" : "backtick"; output += " "; index += 1; continue; }
    if (state !== "code") { output += current === "\n" ? "\n" : " "; if (current === "\\" && state !== "backtick") { output += " "; index += 2; continue; } if ((state === "single" && current === "'") || (state === "double" && current === '"') || (state === "backtick" && current === "`")) state = "code"; index += 1; continue; }
    output += current; index += 1;
  }
  return output;
}

function hasDelimiterError(source: string): boolean {
  const masked = maskTrivia(source);
  const stack: string[] = [];
  const closing: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (const character of masked) {
    if (character === "(" || character === "[" || character === "{") stack.push(character);
    else if (character in closing && stack.pop() !== closing[character]) return true;
  }
  return stack.length > 0;
}

function manifestDigest(rootPath: string, spec: LanguageSpec): string {
  const names = [...spec.manifests];
  if (spec.language === "csharp") {
    try { names.push(...readdirSync(rootPath).filter((name) => name.toLocaleLowerCase("en-US").endsWith(".csproj"))); } catch { /* diagnostic is emitted by the shared scanner */ }
  }
  return sha256(JSON.stringify(names.sort().map((name) => {
    const file = path.join(rootPath, name);
    return [name, existsSync(file) ? sha256(readFileSync(file)) : null];
  })));
}

function moduleName(spec: LanguageSpec, relativePath: string, source: string): string {
  if (spec.language === "go") return source.match(/^\s*package\s+([\w]+)/m)?.[1] ?? path.basename(relativePath, spec.extension);
  if (spec.language === "java") return source.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1] ?? path.dirname(relativePath).replaceAll("/", ".");
  if (spec.language === "csharp") return source.match(/^\s*namespace\s+([\w.]+)/m)?.[1] ?? path.dirname(relativePath).replaceAll("/", ".");
  return path.basename(relativePath, spec.extension);
}

class CoreSyntaxProvider implements SyntaxProvider {
  readonly id: string;
  readonly version = "0.5.0";
  constructor(private readonly spec: LanguageSpec) { this.id = spec.provider; }

  async extract(input: Parameters<SyntaxProvider["extract"]>[0]): Promise<SyntaxGraphBatch> {
    const selected = input.files.filter((file) => file.language === this.spec.language);
    const files: IndexedSourceFile[] = [];
    const nodes = new Map<string, CodeNodeRecord>();
    const edges = new Map<string, CodeEdgeRecord>();
    const unresolved: UnresolvedReferenceRecord[] = [];
    const declarations = new Map<string, string[]>();
    const modulesByPath = new Map<string, string>();
    const modulesByName = new Map<string, string[]>();
    const declarationRanges = new Map<string, Array<{ start: number; end: number; id: string }>>();
    const evidence = (confidence: number) => [{ provider: this.id, providerVersion: this.version, source: "syntax" as const, confidence }];
    const edgeKey = (sourceId: string, targetId: string, kind: CodeEdgeKind) => `${sourceId}\0${targetId}\0${kind}`;

    for (const scanned of selected) {
      const fileId = sha256(`${input.workspace.id}\0${scanned.pathKey}`);
      const partial = hasDelimiterError(scanned.content);
      const file: IndexedSourceFile = { ...scanned, id: fileId, workspaceId: input.workspace.id, ecosystem: this.spec.ecosystem, sourceRoot: "", adapterConfigHash: input.project.configHash, parseStatus: partial ? "partial" : "ok", diagnosticCount: partial ? 1 : 0, generation: input.generation };
      files.push(file);
      const moduleKey = `${scanned.pathKey}:module`;
      const moduleId = sha256(`${input.workspace.id}\0${this.spec.language}\0${moduleKey}`);
      modulesByPath.set(scanned.pathKey, moduleId);
      const name = moduleName(this.spec, scanned.relativePath, scanned.content);
      nodes.set(moduleId, { id: moduleId, workspaceId: input.workspace.id, fileId, kind: "module", name, qualifiedName: scanned.relativePath, localKey: moduleKey, signature: `module ${name}`, doc: "", isExported: true, startByte: 0, endByte: Buffer.byteLength(scanned.content), startLine: 1, startColumn: 1, endLine: scanned.content.split(/\r?\n/).length, endColumn: 1, contentHash: scanned.contentHash, generation: input.generation, metadata: {}, language: this.spec.language, ecosystem: this.spec.ecosystem, nativeKind: "module", analysisLevel: "syntax" });
      const sameName = modulesByName.get(name) ?? []; sameName.push(moduleId); sameName.sort(); modulesByName.set(name, sameName);
    }

    for (const scanned of selected) {
      const moduleId = modulesByPath.get(scanned.pathKey)!;
      const file = files.find((item) => item.pathKey === scanned.pathKey)!;
      const masked = maskTrivia(scanned.content);
      const ranges: Array<{ start: number; end: number; id: string }> = [];
      for (const declaration of this.spec.declarations) {
        declaration.pattern.lastIndex = 0;
        for (const match of masked.matchAll(declaration.pattern)) {
          const name = match[declaration.nameGroup];
          if (!name || match.index === undefined) continue;
          const nameOffset = match.index + match[0].indexOf(name);
          const end = match.index + match[0].length;
          const startLocation = location(scanned.content, match.index);
          const endLocation = location(scanned.content, end);
          const localKey = `${scanned.pathKey}:${declaration.kind}:${name}:${byteOffset(scanned.content, nameOffset)}`;
          const id = sha256(`${input.workspace.id}\0${this.spec.language}\0${localKey}\0${sha256(match[0])}`);
          nodes.set(id, { id, workspaceId: input.workspace.id, fileId: file.id, kind: declaration.kind, name, qualifiedName: `${scanned.relativePath}#${name}`, localKey, signature: clampText(scanned.content.slice(match.index, end).replace(/\s+/g, " ").trim(), 1000), doc: "", isExported: this.spec.language === "go" ? /^[A-Z]/.test(name) : /\bpublic\b/.test(match[0]) || this.spec.language === "rust" && /\bpub\b/.test(match[0]), startByte: byteOffset(scanned.content, match.index), endByte: byteOffset(scanned.content, end), startLine: startLocation.line, startColumn: startLocation.column, endLine: endLocation.line, endColumn: endLocation.column, contentHash: sha256(match[0]), generation: input.generation, metadata: { stableLocator: localKey }, language: this.spec.language, ecosystem: this.spec.ecosystem, nativeKind: declaration.nativeKind, analysisLevel: "syntax" });
          const sameName = declarations.get(name) ?? []; sameName.push(id); sameName.sort(); declarations.set(name, sameName);
          ranges.push({ start: match.index, end, id });
          const key = edgeKey(moduleId, id, "CONTAINS");
          edges.set(key, { workspaceId: input.workspace.id, sourceId: moduleId, targetId: id, kind: "CONTAINS", confidence: 1, resolutionKind: "exact", generation: input.generation, metadata: {}, status: "resolved", evidence: evidence(1) });
        }
      }
      declarationRanges.set(scanned.pathKey, ranges.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)));
    }

    for (const scanned of selected) {
      const moduleId = modulesByPath.get(scanned.pathKey)!;
      const file = files.find((item) => item.pathKey === scanned.pathKey)!;
      const masked = maskTrivia(scanned.content);
      this.spec.importPattern.lastIndex = 0;
      for (const match of scanned.content.matchAll(this.spec.importPattern)) {
        const specifier = [...match].slice(1).find((item) => typeof item === "string" && item.trim().length > 0)?.trim().replace(/^['"]|['"]$/g, "");
        if (!specifier || /^\s*(?:package|namespace)\b/.test(specifier)) continue;
        const localName = specifier.replace(/::\{.*$/, "").split(/[./:]/).filter(Boolean).at(-1) ?? specifier;
        const localTargets = modulesByName.get(localName) ?? [];
        let targetId = localTargets.length === 1 ? localTargets[0] : undefined;
        if (!targetId && this.spec.language === "java") {
          const named = declarations.get(localName) ?? [];
          if (named.length === 1) targetId = named[0];
        }
        if (!targetId) {
          const canonical = specifier.replace(/\s+as\s+\w+$/, "").replace(/::\*$/, "");
          const localKey = `external:${this.spec.ecosystem}:${canonical.toLocaleLowerCase("en-US")}`;
          targetId = sha256(`${input.workspace.id}\0${localKey}`);
          if (!nodes.has(targetId)) nodes.set(targetId, { id: targetId, workspaceId: input.workspace.id, fileId: null,
            kind: "external_module", name: canonical, qualifiedName: canonical, localKey, signature: `external module ${canonical}`,
            doc: "", isExported: true, startByte: 0, endByte: 0, startLine: 1, startColumn: 1, endLine: 1, endColumn: 1,
            contentHash: sha256(canonical), generation: input.generation, metadata: {}, language: this.spec.language,
            ecosystem: this.spec.ecosystem, nativeKind: "external_module", analysisLevel: "syntax" });
        }
        if (targetId !== moduleId) {
          const edge = { workspaceId: input.workspace.id, sourceId: moduleId, targetId, kind: "IMPORTS" as const,
            confidence: 0.9, resolutionKind: localTargets.includes(targetId) ? "import" as const : "exact" as const,
            generation: input.generation, metadata: { specifier }, status: "resolved" as const, evidence: evidence(0.9) };
          edges.set(edgeKey(moduleId, targetId, "IMPORTS"), edge);
        }
      }
      this.spec.callPattern.lastIndex = 0;
      for (const match of masked.matchAll(this.spec.callPattern)) {
        const name = match[this.spec.callNameGroup];
        if (!name || match.index === undefined || this.spec.callExcludes.has(name)) continue;
        if ((declarationRanges.get(scanned.pathKey) ?? []).some((item) => match.index! >= item.start && match.index! < item.end)) continue;
        const targets = declarations.get(name) ?? [];
        const owner = [...(declarationRanges.get(scanned.pathKey) ?? [])].reverse().find((item) => item.start < match.index!)?.id ?? moduleId;
        const position = location(scanned.content, match.index);
        if (targets.length === 1 && targets[0]) {
          const target = targets[0];
          const key = edgeKey(owner, target, "CALLS");
          edges.set(key, { workspaceId: input.workspace.id, sourceId: owner, targetId: target, kind: "CALLS", confidence: 0.65, resolutionKind: "heuristic", generation: input.generation, metadata: { rawName: name }, status: "candidate", evidence: evidence(0.65) });
        } else {
          unresolved.push({ workspaceId: input.workspace.id, fileId: file.id, sourceNodeId: owner, kind: "CALLS", rawName: name, qualifier: null, line: position.line, column: position.column, candidates: targets, generation: input.generation, confidence: 0.4, evidence: evidence(0.4) });
        }
      }
    }
    return { files, nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)), edges: [...edges.values()].sort((a, b) => edgeKey(a.sourceId, a.targetId, a.kind).localeCompare(edgeKey(b.sourceId, b.targetId, b.kind))), unresolvedReferences: unresolved.sort((a, b) => a.fileId.localeCompare(b.fileId) || a.line - b.line || a.column - b.column), diagnostics: files.filter((file) => file.parseStatus === "partial").map((file) => `PROVIDER_PARSE_PARTIAL: ${file.relativePath}`), providerMetrics: { filesParsed: selected.length, mode: input.mode ?? "incremental" } };
  }
}

export class CoreLanguageAdapter implements LanguageAdapter {
  readonly ecosystem: CodeEcosystem;
  readonly extensions: readonly string[];
  constructor(readonly languageId: CoreLanguage) { this.ecosystem = SPECS[languageId].ecosystem; this.extensions = [SPECS[languageId].extension]; }
  discoverProject(rootPath: string): ProjectDescriptor { const spec = SPECS[this.languageId]; return { language: spec.language, ecosystem: spec.ecosystem, sourceRoots: [""], configHash: sha256(`${spec.provider}\0${this.languageId}\0${manifestDigest(rootPath, spec)}`), diagnostics: [], runtime: { rootPath } }; }
  createSyntaxProvider(): SyntaxProvider { return new CoreSyntaxProvider(SPECS[this.languageId]); }
  createOverlayPrecisionProvider(project: ProjectDescriptor): OverlayPrecisionProvider | undefined {
    if (this.languageId === "go") return new GoTypesProvider(project);
    if (this.languageId === "rust") return {
      id: "rust_analyzer", version: "optional", capability: "typed",
      available: async () => ({ available: false, diagnostic: "rust-analyzer overlay is optional and not configured" }),
      analyze: async (_batch: SyntaxGraphBatch, baseGeneration: number): Promise<PrecisionOverlayBatch> => ({
        language: "rust", provider: "rust_analyzer", providerVersion: "optional", capability: "typed",
        baseGeneration, edges: [], eligibleEdges: 0, diagnostics: ["rust-analyzer overlay is not configured"], partial: true,
      }),
    };
    return undefined;
  }
}

export const CORE_LANGUAGE_IDS = ["go", "rust", "java", "csharp"] as const;
