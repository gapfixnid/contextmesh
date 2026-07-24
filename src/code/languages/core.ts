import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { Language, Parser, type Node as SyntaxNode, type Tree } from "web-tree-sitter";

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
import type { LanguageAdapter, LanguageInvalidationInput, LanguageInvalidationPlan, OverlayPrecisionProvider, ProjectDescriptor, SyntaxGraphBatch, SyntaxProvider } from "../providers.js";
import { GoTypesProvider } from "./go-precision.js";
import { RustAnalyzerProvider } from "./rust-precision.js";

type CoreLanguage = Extract<CodeLanguage, "go" | "rust" | "java" | "csharp">;
type TreeSitterCoreLanguage = Extract<CoreLanguage, "go" | "rust">;

const require = createRequire(import.meta.url);
const TREE_SITTER_GRAMMARS = {
  go: { packageName: "tree-sitter-go", wasm: "tree-sitter-go.wasm", version: "0.25.0" },
  rust: { packageName: "tree-sitter-rust", wasm: "tree-sitter-rust.wasm", version: "0.24.0" },
} as const;
let treeSitterRuntimePromise: Promise<void> | null = null;
const treeSitterLanguagePromises = new Map<TreeSitterCoreLanguage, Promise<Language>>();

async function treeSitterLanguage(language: TreeSitterCoreLanguage): Promise<Language> {
  if (!treeSitterRuntimePromise) {
    treeSitterRuntimePromise = (async () => {
      const runtimeDirectory = path.dirname(require.resolve("web-tree-sitter"));
      await Parser.init({ locateFile: (file: string) => path.join(runtimeDirectory, file) });
    })();
  }
  await treeSitterRuntimePromise;
  let loaded = treeSitterLanguagePromises.get(language);
  if (!loaded) {
    const grammar = TREE_SITTER_GRAMMARS[language];
    loaded = Language.load(path.join(path.dirname(require.resolve(`${grammar.packageName}/package.json`)), grammar.wasm));
    treeSitterLanguagePromises.set(language, loaded);
  }
  return loaded;
}

function declarationSyntaxNode(
  tree: Tree,
  language: TreeSitterCoreLanguage,
  nameByte: number,
): SyntaxNode | null {
  const accepted = language === "go"
    ? new Set(["function_declaration", "method_declaration", "type_spec", "var_spec", "const_spec"])
    : new Set(["function_item", "struct_item", "trait_item", "enum_item", "type_item"]);
  let node = tree.rootNode.namedDescendantForIndex(nameByte);
  while (node && !accepted.has(node.type)) node = node.parent;
  if (!node || node.isError || node.isMissing) return null;
  if (language === "go" && node.hasError) return null;
  return node;
}

function syntaxNodes(root: SyntaxNode, type: string): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.type === type) result.push(node);
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return result;
}

interface TreeSitterDeclaration {
  name: string;
  kind: CodeNodeKind;
  nativeKind: string;
  isExported: boolean;
  startIndex: number;
  endIndex: number;
  nameStartIndex: number;
  nameEndIndex: number;
  startByte: number;
  endByte: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
}

function treeSitterDeclarations(
  source: string,
  tree: Tree,
  language: TreeSitterCoreLanguage,
): TreeSitterDeclaration[] {
  const nodeTypes = language === "go"
    ? ["function_declaration", "method_declaration", "type_spec", "var_spec", "const_spec"]
    : ["function_item", "struct_item", "trait_item", "enum_item", "type_item"];
  const declarations: TreeSitterDeclaration[] = [];
  for (const node of tree.rootNode.descendantsOfType(nodeTypes)) {
    if (node.isError || node.isMissing || language === "go" && node.hasError) continue;
    const nameNode = node.childForFieldName("name");
    if (!nameNode || nameNode.isError || nameNode.isMissing) continue;
    let kind: CodeNodeKind;
    if (language === "go") {
      if (node.type === "function_declaration") kind = "function";
      else if (node.type === "method_declaration") kind = "method";
      else if (node.type === "type_spec") {
        const declaredType = node.childForFieldName("type")?.type;
        kind = declaredType === "struct_type" ? "class" : declaredType === "interface_type" ? "interface" : "type_alias";
      } else kind = "variable";
    } else {
      kind = node.type === "function_item" ? "function"
        : node.type === "struct_item" ? "class"
          : node.type === "trait_item" ? "interface"
            : node.type === "enum_item" ? "enum" : "type_alias";
    }
    declarations.push({
      name: nameNode.text,
      kind,
      nativeKind: node.type,
      isExported: language === "go" ? /^[A-Z]/.test(nameNode.text) : node.namedChildren.some((child) => child.type === "visibility_modifier"),
      startIndex: node.startIndex,
      endIndex: node.endIndex,
      nameStartIndex: nameNode.startIndex,
      nameEndIndex: nameNode.endIndex,
      startByte: byteOffset(source, node.startIndex),
      endByte: byteOffset(source, node.endIndex),
      startLine: node.startPosition.row + 1,
      startColumn: node.startPosition.column + 1,
      endLine: node.endPosition.row + 1,
      endColumn: node.endPosition.column + 1,
      text: node.text,
    });
  }
  return declarations.sort((left, right) => left.startByte - right.startByte || left.name.localeCompare(right.name));
}

interface TreeSitterReference {
  name: string;
  index: number;
  startByte: number;
  endByte: number;
  line: number;
  column: number;
  ownerStartByte: number | null;
}

function treeSitterCalls(source: string, tree: Tree, language: TreeSitterCoreLanguage): TreeSitterReference[] {
  const references: TreeSitterReference[] = [];
  for (const call of syntaxNodes(tree.rootNode, "call_expression")) {
    const callable = call.childForFieldName("function");
    if (!callable) continue;
    const direct = callable.childForFieldName("field") ?? callable.childForFieldName("name");
    const identifiers = callable.descendantsOfType(["identifier", "field_identifier", "type_identifier"]);
    const nameNode = direct ?? (identifiers.at(-1) ?? (["identifier", "field_identifier", "type_identifier"].includes(callable.type) ? callable : null));
    if (!nameNode) continue;
    const callableTypes = language === "go"
      ? new Set(["function_declaration", "method_declaration"])
      : new Set(["function_item"]);
    let owner = call.parent;
    while (owner && !callableTypes.has(owner.type)) owner = owner.parent;
    references.push({
      name: nameNode.text,
      index: nameNode.startIndex,
      startByte: byteOffset(source, nameNode.startIndex),
      endByte: byteOffset(source, nameNode.endIndex),
      line: nameNode.startPosition.row + 1,
      column: nameNode.startPosition.column + 1,
      ownerStartByte: owner ? byteOffset(source, owner.startIndex) : null,
    });
  }
  return references;
}

function treeSitterImports(tree: Tree, language: TreeSitterCoreLanguage): string[] {
  if (language === "go") {
    return tree.rootNode.descendantsOfType("import_spec")
      .map((node) => node.childForFieldName("path")?.text.replace(/^['"`]|['"`]$/g, "") ?? "")
      .filter(Boolean);
  }
  return tree.rootNode.descendantsOfType("use_declaration")
    .map((node) => node.text.replace(/^\s*(?:pub\s+)?use\s+/, "").replace(/;\s*$/, "").trim())
    .filter(Boolean);
}

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

function hasLanguageSyntaxError(spec: LanguageSpec, source: string): boolean {
  if (hasDelimiterError(source)) return true;
  if (spec.language !== "rust") return false;
  const masked = maskTrivia(source);
  return /\blet\s+(?:mut\s+)?(?:[:=;]|$)/m.test(masked)
    || /\b(?:fn|struct|enum|trait|type)\s*(?:[({=;]|$)/m.test(masked);
}

function declarationBodyEnd(masked: string, startIndex: number, headerEndIndex: number): number {
  const open = masked.indexOf("{", Math.max(startIndex, headerEndIndex - 1));
  if (open < 0) return headerEndIndex;
  let depth = 0;
  for (let index = open; index < masked.length; index += 1) {
    if (masked[index] === "{") depth += 1;
    else if (masked[index] === "}" && --depth === 0) return index + 1;
  }
  return headerEndIndex;
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
  readonly version: string;
  constructor(private readonly spec: LanguageSpec) {
    this.id = spec.provider;
    this.version = spec.language === "go" || spec.language === "rust"
      ? `${TREE_SITTER_GRAMMARS[spec.language].packageName}@${TREE_SITTER_GRAMMARS[spec.language].version}`
      : "0.6.0";
  }

  async extract(input: Parameters<SyntaxProvider["extract"]>[0]): Promise<SyntaxGraphBatch> {
    const selected = input.files.filter((file) => file.language === this.spec.language);
    const parserLanguage = this.spec.language === "go" || this.spec.language === "rust" ? this.spec.language : null;
    const syntaxTrees = new Map<string, Tree>();
    if (parserLanguage) {
      const language = await treeSitterLanguage(parserLanguage);
      const parser = new Parser();
      try {
        parser.setLanguage(language);
        for (const scanned of selected) {
          const tree = parser.parse(scanned.content);
          if (!tree) throw new Error(`TREE_SITTER_PARSE_FAILED: ${scanned.relativePath}`);
          syntaxTrees.set(scanned.pathKey, tree);
        }
      } finally {
        parser.delete();
      }
    }
    try {
    const files: IndexedSourceFile[] = [];
    const nodes = new Map<string, CodeNodeRecord>();
    const edges = new Map<string, CodeEdgeRecord>();
    const unresolved: UnresolvedReferenceRecord[] = [];
    const declarations = new Map<string, string[]>();
    const modulesByPath = new Map<string, string>();
    const modulesByName = new Map<string, string[]>();
    const declarationRanges = new Map<string, Array<{ start: number; end: number; startByte: number; id: string; kind: CodeNodeKind }>>();
    const declarationNameRanges = new Map<string, Array<{ start: number; end: number }>>();
    const evidence = (confidence: number, sourceSpan?: { startByte: number; endByte: number; line: number; column: number }) => [{
      provider: this.id, providerVersion: this.version, source: "syntax" as const, confidence,
      ...(sourceSpan ? { sourceSpan } : {}),
    }];
    const edgeKey = (sourceId: string, targetId: string, kind: CodeEdgeKind) => `${sourceId}\0${targetId}\0${kind}`;

    for (const scanned of selected) {
      const fileId = sha256(`${input.workspace.id}\0${scanned.pathKey}`);
      const partial = syntaxTrees.get(scanned.pathKey)?.rootNode.hasError ?? hasLanguageSyntaxError(this.spec, scanned.content);
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
      const ranges: Array<{ start: number; end: number; startByte: number; id: string; kind: CodeNodeKind }> = [];
      const nameRanges: Array<{ start: number; end: number }> = [];
      const parsedDeclarations: TreeSitterDeclaration[] = [];
      const syntaxTree = syntaxTrees.get(scanned.pathKey);
      if (syntaxTree && parserLanguage) {
        parsedDeclarations.push(...treeSitterDeclarations(scanned.content, syntaxTree, parserLanguage));
        // Tree-sitter can reduce a damaged Rust item to ERROR. Keep a bounded
        // declaration-only recovery path while the parser remains authoritative
        // for file status and all structurally recognized items.
        if (parserLanguage === "rust" && syntaxTree.rootNode.hasError) {
          const recognized = new Set(parsedDeclarations.map((item) => `${item.kind}\0${item.name}\0${item.nameStartIndex}`));
          for (const declaration of this.spec.declarations) {
            declaration.pattern.lastIndex = 0;
            for (const match of masked.matchAll(declaration.pattern)) {
              const name = match[declaration.nameGroup];
              if (!name || match.index === undefined) continue;
              const nameStartIndex = match.index + match[0].indexOf(name);
              const nameByte = byteOffset(scanned.content, nameStartIndex);
              if (declarationSyntaxNode(syntaxTree, parserLanguage, nameByte)) continue;
              let damaged = syntaxTree.rootNode.namedDescendantForIndex(nameByte);
              while (damaged && !damaged.isError) damaged = damaged.parent;
              if (!damaged) continue;
              const key = `${declaration.kind}\0${name}\0${nameStartIndex}`;
              if (recognized.has(key)) continue;
              const endIndex = match.index + match[0].length;
              const start = location(scanned.content, match.index);
              const end = location(scanned.content, endIndex);
              parsedDeclarations.push({
                name, kind: declaration.kind, nativeKind: "ERROR_recovered_declaration", isExported: /\bpub\b/.test(match[0]),
                startIndex: match.index, endIndex, nameStartIndex, nameEndIndex: nameStartIndex + name.length,
                startByte: byteOffset(scanned.content, match.index), endByte: byteOffset(scanned.content, endIndex),
                startLine: start.line, startColumn: start.column, endLine: end.line, endColumn: end.column, text: match[0],
              });
            }
          }
        }
      } else {
        for (const declaration of this.spec.declarations) {
          declaration.pattern.lastIndex = 0;
          for (const match of masked.matchAll(declaration.pattern)) {
            const name = match[declaration.nameGroup];
            if (!name || match.index === undefined) continue;
            const nameStartIndex = match.index + match[0].indexOf(name);
            const headerEndIndex = match.index + match[0].length;
            const endIndex = declarationBodyEnd(masked, match.index, headerEndIndex);
            const start = location(scanned.content, match.index);
            const end = location(scanned.content, endIndex);
            parsedDeclarations.push({
              name, kind: declaration.kind, nativeKind: declaration.nativeKind,
              isExported: /\bpublic\b/.test(match[0]), startIndex: match.index, endIndex,
              nameStartIndex, nameEndIndex: nameStartIndex + name.length,
              startByte: byteOffset(scanned.content, match.index), endByte: byteOffset(scanned.content, endIndex),
              startLine: start.line, startColumn: start.column, endLine: end.line, endColumn: end.column,
              text: scanned.content.slice(match.index, endIndex),
            });
          }
        }
      }
      for (const declaration of parsedDeclarations.sort((a, b) => a.startByte - b.startByte || a.name.localeCompare(b.name))) {
        const localKey = `${scanned.pathKey}:${declaration.kind}:${declaration.name}:${byteOffset(scanned.content, declaration.nameStartIndex)}`;
        const signature = clampText(declaration.text.split("{", 1)[0]!.replace(/\s+/g, " ").trim(), 1000);
        const id = sha256(`${input.workspace.id}\0${this.spec.language}\0${localKey}\0${sha256(signature)}`);
        nodes.set(id, { id, workspaceId: input.workspace.id, fileId: file.id, kind: declaration.kind, name: declaration.name,
          qualifiedName: `${scanned.relativePath}#${declaration.name}`, localKey, signature, doc: "", isExported: declaration.isExported,
          startByte: declaration.startByte, endByte: declaration.endByte, startLine: declaration.startLine,
          startColumn: declaration.startColumn, endLine: declaration.endLine, endColumn: declaration.endColumn,
          contentHash: sha256(declaration.text), generation: input.generation, metadata: { stableLocator: localKey },
          language: this.spec.language, ecosystem: this.spec.ecosystem, nativeKind: declaration.nativeKind, analysisLevel: "syntax" });
        const sameName = declarations.get(declaration.name) ?? []; sameName.push(id); sameName.sort(); declarations.set(declaration.name, sameName);
        nameRanges.push({ start: declaration.nameStartIndex, end: declaration.nameEndIndex });
        ranges.push({ start: declaration.startIndex, end: declaration.endIndex, startByte: declaration.startByte,
          id, kind: declaration.kind });
        const key = edgeKey(moduleId, id, "CONTAINS");
        edges.set(key, { workspaceId: input.workspace.id, sourceId: moduleId, targetId: id, kind: "CONTAINS", confidence: 1,
          resolutionKind: "exact", generation: input.generation, metadata: {}, status: "resolved", evidence: evidence(1) });
      }
      declarationRanges.set(scanned.pathKey, ranges.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)));
      declarationNameRanges.set(scanned.pathKey, nameRanges.sort((a, b) => a.start - b.start || a.end - b.end));
    }

    for (const scanned of selected) {
      const moduleId = modulesByPath.get(scanned.pathKey)!;
      const file = files.find((item) => item.pathKey === scanned.pathKey)!;
      const masked = maskTrivia(scanned.content);
      const syntaxTree = syntaxTrees.get(scanned.pathKey);
      const specifiers: string[] = [];
      if (syntaxTree && parserLanguage) specifiers.push(...treeSitterImports(syntaxTree, parserLanguage));
      else {
        this.spec.importPattern.lastIndex = 0;
        for (const match of scanned.content.matchAll(this.spec.importPattern)) {
          const value = [...match].slice(1).find((item) => typeof item === "string" && item.trim().length > 0)?.trim().replace(/^['"]|['"]$/g, "");
          if (value) specifiers.push(value);
        }
      }
      for (const specifier of specifiers) {
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
      const callReferences: TreeSitterReference[] = [];
      if (syntaxTree && parserLanguage) callReferences.push(...treeSitterCalls(scanned.content, syntaxTree, parserLanguage));
      else {
        this.spec.callPattern.lastIndex = 0;
        for (const match of masked.matchAll(this.spec.callPattern)) {
          const name = match[this.spec.callNameGroup];
          if (!name || match.index === undefined) continue;
          const position = location(scanned.content, match.index);
          callReferences.push({
            name, index: match.index, startByte: byteOffset(scanned.content, match.index),
            endByte: byteOffset(scanned.content, match.index + name.length), line: position.line, column: position.column,
            ownerStartByte: null,
          });
        }
      }
      for (const reference of callReferences) {
        const { name } = reference;
        if (this.spec.callExcludes.has(name)) continue;
        if ((declarationNameRanges.get(scanned.pathKey) ?? []).some((item) => reference.index >= item.start && reference.index < item.end)) continue;
        const targets = declarations.get(name) ?? [];
        const ranges = declarationRanges.get(scanned.pathKey) ?? [];
        const structuralOwner = reference.ownerStartByte === null ? undefined
          : ranges.find((item) => item.startByte === reference.ownerStartByte && (item.kind === "function" || item.kind === "method"));
        const owner = structuralOwner?.id ?? ranges
          .filter((item) => (item.kind === "function" || item.kind === "method")
            && item.start <= reference.index && reference.index < item.end)
          .sort((left, right) => (left.end - left.start) - (right.end - right.start) || left.id.localeCompare(right.id))[0]?.id
          ?? moduleId;
        const referenceEvidence = evidence(0.65, {
          startByte: reference.startByte, endByte: reference.endByte, line: reference.line, column: reference.column,
        });
        if (targets.length === 1 && targets[0]) {
          const target = targets[0];
          const key = edgeKey(owner, target, "CALLS");
          edges.set(key, { workspaceId: input.workspace.id, sourceId: owner, targetId: target, kind: "CALLS", confidence: 0.65, resolutionKind: "heuristic", generation: input.generation, metadata: { rawName: name }, status: "candidate", evidence: referenceEvidence });
        } else {
          unresolved.push({ workspaceId: input.workspace.id, fileId: file.id, sourceNodeId: owner, kind: "CALLS", rawName: name, qualifier: null,
            line: reference.line, column: reference.column, candidates: [...targets].sort((left, right) => {
              const leftNode = nodes.get(left);
              const rightNode = nodes.get(right);
              return (leftNode?.qualifiedName ?? left).localeCompare(rightNode?.qualifiedName ?? right) ||
                (leftNode?.startByte ?? 0) - (rightNode?.startByte ?? 0) || left.localeCompare(right);
            }), generation: input.generation, confidence: 0.4,
            evidence: evidence(0.4, { startByte: reference.startByte, endByte: reference.endByte, line: reference.line, column: reference.column }) });
        }
      }
    }
    return { files, nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)), edges: [...edges.values()].sort((a, b) => edgeKey(a.sourceId, a.targetId, a.kind).localeCompare(edgeKey(b.sourceId, b.targetId, b.kind))), unresolvedReferences: unresolved.sort((a, b) => a.fileId.localeCompare(b.fileId) || a.line - b.line || a.column - b.column), diagnostics: files.filter((file) => file.parseStatus === "partial").map((file) => `PROVIDER_PARSE_PARTIAL: ${file.relativePath}`), providerMetrics: { filesParsed: selected.length, mode: input.mode ?? "incremental", providerVersion: this.version } };
    } finally {
      for (const tree of syntaxTrees.values()) tree.delete();
    }
  }
}

export class CoreLanguageAdapter implements LanguageAdapter {
  readonly ecosystem: CodeEcosystem;
  readonly extensions: readonly string[];
  constructor(readonly languageId: CoreLanguage) { this.ecosystem = SPECS[languageId].ecosystem; this.extensions = [SPECS[languageId].extension]; }
  discoverProject(rootPath: string): ProjectDescriptor { const spec = SPECS[this.languageId]; return { language: spec.language, ecosystem: spec.ecosystem, sourceRoots: [""], configHash: sha256(`${spec.provider}\0${this.languageId}\0${manifestDigest(rootPath, spec)}`), diagnostics: [], runtime: { rootPath } }; }
  planInvalidation(input: LanguageInvalidationInput): LanguageInvalidationPlan {
    const extension = SPECS[this.languageId].extension;
    const languageFiles = input.currentFiles.filter((file) => file.language === this.languageId);
    if (input.previousConfigHash !== input.currentConfigHash) {
      return { reparseAll: true, invalidatedPathKeys: languageFiles.map((file) => file.pathKey), reason: "configuration" };
    }
    const sourceChanged = [...input.changedPathKeys, ...input.deletedPathKeys]
      .some((pathKey) => pathKey.toLocaleLowerCase("en-US").endsWith(extension));
    return sourceChanged
      ? { reparseAll: true, invalidatedPathKeys: languageFiles.map((file) => file.pathKey), reason: "source" }
      : { reparseAll: false, invalidatedPathKeys: [], reason: "unchanged" };
  }
  createSyntaxProvider(): SyntaxProvider { return new CoreSyntaxProvider(SPECS[this.languageId]); }
  createOverlayPrecisionProvider(project: ProjectDescriptor): OverlayPrecisionProvider | undefined {
    if (this.languageId === "go") return new GoTypesProvider(project);
    if (this.languageId === "rust") return new RustAnalyzerProvider(project);
    return undefined;
  }
}

export const CORE_LANGUAGE_IDS = ["go", "rust", "java", "csharp"] as const;
