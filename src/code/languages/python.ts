import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

import type {
  CodeEdgeKind,
  CodeEdgeRecord,
  CodeEvidence,
  CodeNodeKind,
  CodeNodeRecord,
  IndexedSourceFile,
  UnresolvedReferenceRecord,
} from "../../contracts.js";
import { clampText, sha256 } from "../../utils.js";
import { extractPythonKernelFacts, type KernelSpan } from "../native-kernel.js";
import type { LanguageAdapter, ProjectDescriptor, SyntaxGraphBatch, SyntaxProvider } from "../providers.js";

export const PYTHON_PROVIDER_VERSIONS = {
  runtime: "contextmesh-graph-kernel@0.4.0",
  portableRuntime: "web-tree-sitter@0.26.11",
  grammar: "tree-sitter-python@0.25.0",
  manifest: "smol-toml@1.7.0",
  protocol: "contextmesh.graph-kernel/v1",
} as const;

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

interface PythonPackageDirectory {
  packagePrefix: string;
  path: string;
}

interface PythonProjectRuntime {
  packageDirectories: PythonPackageDirectory[];
}

function normalizeLayoutPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export function discoverPythonProject(rootPath: string): ProjectDescriptor {
  const diagnostics: string[] = [];
  const roots = new Set<string>([""]);
  const packageDirectories: PythonPackageDirectory[] = [];
  if (existsSync(path.join(rootPath, "src"))) roots.add("src");
  const pyprojectPath = path.join(rootPath, "pyproject.toml");
  let pyprojectHash = sha256("");
  if (existsSync(pyprojectPath)) {
    const source = readFileSync(pyprojectPath, "utf8");
    pyprojectHash = sha256(source);
    try {
      const document = parseToml(source) as Record<string, unknown>;
      const tool = document.tool as Record<string, unknown> | undefined;
      const setuptools = tool?.setuptools as Record<string, unknown> | undefined;
      const packageDir = setuptools?.["package-dir"] as Record<string, unknown> | undefined;
      for (const [packagePrefix, value] of Object.entries(packageDir ?? {})) {
        if (typeof value !== "string") continue;
        const normalizedPath = normalizeLayoutPath(value);
        roots.add(normalizedPath);
        packageDirectories.push({ packagePrefix: packagePrefix.trim().replace(/^\.+|\.+$/g, ""), path: normalizedPath });
      }
      const packages = setuptools?.packages as Record<string, unknown> | undefined;
      const find = packages?.find as Record<string, unknown> | undefined;
      for (const value of stringArray(find?.where)) roots.add(value);
      const unsupported = ["poetry", "pdm", "hatch"].filter((key) => key in (tool ?? {}));
      if (unsupported.length > 0) {
        diagnostics.push(
          `PYTHON_LAYOUT_FALLBACK: unsupported dynamic backend (${unsupported.join(", ")}); using workspace root and src`,
        );
      }
    } catch (error) {
      diagnostics.push(
        `PYTHON_LAYOUT_FALLBACK: cannot parse pyproject.toml; using workspace root and src (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  const sourceRoots = [...roots]
    .map(normalizeLayoutPath)
    .filter((item, index, all) => all.indexOf(item) === index)
    .sort((a, b) => a.localeCompare(b));
  const normalizedPackageDirectories = packageDirectories.sort((left, right) =>
    right.path.length - left.path.length || right.packagePrefix.length - left.packagePrefix.length ||
    left.packagePrefix.localeCompare(right.packagePrefix));
  return {
    language: "python",
    ecosystem: "pypi",
    sourceRoots,
    diagnostics,
    configHash: sha256(JSON.stringify({ ...PYTHON_PROVIDER_VERSIONS, pyprojectHash, sourceRoots, packageDirectories: normalizedPackageDirectories })),
    runtime: { packageDirectories: normalizedPackageDirectories } satisfies PythonProjectRuntime,
  };
}

function evidence(source: CodeEvidence["source"], confidence: number, node?: KernelSpan, provider = "contextmesh_graph_kernel", providerVersion = "0.4.0"): CodeEvidence[] {
  return [{
    provider,
    providerVersion,
    source,
    confidence,
    ...(node ? { sourceSpan: {
      startByte: node.startByte,
      endByte: node.endByte,
      line: node.startLine,
      column: node.startColumn,
    } } : {}),
  }];
}

function sourceRootFor(file: { relativePath: string }, roots: string[]): string {
  return [...roots]
    .sort((a, b) => b.length - a.length)
    .find((root) => root === "" || file.relativePath === root || file.relativePath.startsWith(`${root}/`)) ?? "";
}

function moduleName(relativePath: string, root: string, packageDirectories: PythonPackageDirectory[]): string {
  let name = root ? relativePath.slice(root.length + 1) : relativePath;
  name = name.replace(/\.py$/i, "").replace(/(^|\/)__init__$/i, "").replaceAll("/", ".");
  const mapping = packageDirectories.find((item) => item.path === root);
  const prefix = mapping?.packagePrefix ?? "";
  if (prefix && name) return `${prefix}.${name}`;
  if (prefix) return prefix;
  return name || path.basename(root || relativePath).replace(/\.py$/i, "");
}

class PythonSyntaxProvider implements SyntaxProvider {
  readonly id = "contextmesh_graph_kernel";
  readonly version = "0.4.0";

  async extract(input: Parameters<SyntaxProvider["extract"]>[0]): Promise<SyntaxGraphBatch> {
    const kernel = await extractPythonKernelFacts(input.files.filter((file) => file.language === "python"), undefined, input.mode === "full");
    const files: IndexedSourceFile[] = [];
    const nodes = new Map<string, CodeNodeRecord>();
    const edges = new Map<string, CodeEdgeRecord>();
    const unresolved = new Map<string, UnresolvedReferenceRecord>();
    const moduleIds = new Map<string, string[]>();
    const declarationsByName = new Map<string, string[]>();
    const declarationIdsByPosition = new Map<string, string>();
    const declarationOrdinals = new Map<string, number>();
    const packageDirectories = ((input.project.runtime as PythonProjectRuntime | undefined)?.packageDirectories ?? []);
    const entries: Array<{ scanned: (typeof input.files)[number]; file: IndexedSourceFile; moduleId: string; facts: (typeof kernel.files)[number] }> = [];
    const edgeKey = (edge: CodeEdgeRecord): string => `${edge.sourceId}\0${edge.targetId}\0${edge.kind}`;
    const factsByPath = new Map(kernel.files.map((facts) => [facts.relativePath, facts]));

    for (const scanned of input.files.filter((file) => file.language === "python")) {
      const root = sourceRootFor(scanned, input.project.sourceRoots);
      const fileId = sha256(`${input.workspace.id}\0${scanned.pathKey}`);
      const facts = factsByPath.get(scanned.relativePath);
      if (!facts) throw new Error(`KERNEL_INCOMPLETE_BATCH: ${scanned.relativePath}`);
      const hasError = facts.hasError;
      const file: IndexedSourceFile = {
        ...scanned,
        id: fileId,
        workspaceId: input.workspace.id,
        language: "python",
        ecosystem: "pypi",
        sourceRoot: root,
        adapterConfigHash: input.project.configHash,
        parseStatus: hasError ? "partial" : "ok",
        diagnosticCount: hasError ? 1 : 0,
        generation: input.generation,
      };
      files.push(file);
      const localKey = `${scanned.pathKey}:module`;
      const moduleId = sha256(`${input.workspace.id}\0python\0${localKey}`);
      const name = moduleName(scanned.relativePath, root, packageDirectories);
      const moduleCandidates = moduleIds.get(name) ?? [];
      moduleCandidates.push(moduleId);
      moduleCandidates.sort((left, right) => left.localeCompare(right));
      moduleIds.set(name, moduleCandidates);
      nodes.set(moduleId, {
        id: moduleId, workspaceId: input.workspace.id, fileId, kind: "module", name,
        qualifiedName: scanned.relativePath, localKey, signature: `module ${name}`, doc: "", isExported: true,
        startByte: 0, endByte: Buffer.byteLength(scanned.content), startLine: 1, startColumn: 1,
        endLine: scanned.content.split(/\r?\n/).length, endColumn: 1, contentHash: scanned.contentHash,
        generation: input.generation, metadata: { sourceRoot: root }, language: "python", ecosystem: "pypi",
        nativeKind: "module", analysisLevel: "syntax",
      });
      entries.push({ scanned, file, moduleId, facts });
    }

    const addEdge = (sourceId: string, targetId: string, kind: CodeEdgeKind, confidence: number, status: "candidate" | "resolved", node?: KernelSpan, details: Record<string, unknown> = {}): void => {
      if (kind === "IMPORTS" && sourceId === targetId) return;
      const record: CodeEdgeRecord = {
        workspaceId: input.workspace.id, sourceId, targetId, kind, confidence,
        resolutionKind: status === "candidate" ? "heuristic" : kind === "IMPORTS" ? "import" : "local",
        generation: input.generation, metadata: details, status, evidence: evidence("syntax", confidence, node, "tree_sitter_python", "0.25.0"),
      };
      edges.set(edgeKey(record), record);
    };
    const addUnresolved = (file: IndexedSourceFile, sourceNodeId: string, kind: string, rawName: string, node: KernelSpan, confidence = 0.5, candidates: string[] = []): void => {
      const item: UnresolvedReferenceRecord = {
        workspaceId: input.workspace.id, fileId: file.id, sourceNodeId, kind, rawName: clampText(rawName, 200),
        qualifier: null, line: node.startLine, column: node.startColumn,
        candidates: [...new Set(candidates)].sort((left, right) => left.localeCompare(right)),
        generation: input.generation, confidence, evidence: evidence("syntax", confidence, node, "tree_sitter_python", "0.25.0"),
      };
      unresolved.set(`${file.id}\0${sourceNodeId}\0${kind}\0${rawName}\0${item.line}\0${item.column}`, item);
    };

    for (const entry of entries) for (const declaration of entry.facts.declarations) {
      const kind = declaration.containerKind as CodeNodeKind;
      const locatorKey = `${entry.file.pathKey}:${kind}:${declaration.symbolPath}`;
      const ordinal = (declarationOrdinals.get(locatorKey) ?? 0) + 1;
      declarationOrdinals.set(locatorKey, ordinal);
      const signature = clampText(declaration.signature, 1000);
      const declarationHash = sha256(signature.trim().replace(/\s+/g, " "));
      const localKey = `${locatorKey}:${ordinal}:${declarationHash.slice(0, 16)}`;
      const id = sha256(`${input.workspace.id}\0python\0${locatorKey}\0${ordinal}\0${declarationHash}`);
      const containerId = declaration.containerStartByte === null
        ? entry.moduleId
        : declarationIdsByPosition.get(`${entry.file.id}:${declaration.containerStartByte}`) ?? entry.moduleId;
      nodes.set(id, {
        id, workspaceId: input.workspace.id, fileId: entry.file.id, kind, name: declaration.name,
        qualifiedName: `${entry.file.relativePath}#${declaration.symbolPath}`, localKey, signature, doc: "",
        isExported: !declaration.name.startsWith("_"), startByte: declaration.span.startByte, endByte: declaration.span.endByte,
        startLine: declaration.span.startLine, startColumn: declaration.span.startColumn,
        endLine: declaration.span.endLine, endColumn: declaration.span.endColumn,
        contentHash: sha256(declaration.content), generation: input.generation,
        metadata: { async: declaration.isAsync, stableLocator: locatorKey, declarationHash, ordinal },
        language: "python", ecosystem: "pypi", nativeKind: declaration.nativeKind, analysisLevel: "syntax",
      });
      const matches = declarationsByName.get(declaration.name) ?? [];
      matches.push(id); declarationsByName.set(declaration.name, matches);
      declarationIdsByPosition.set(`${entry.file.id}:${declaration.span.startByte}`, id);
      addEdge(containerId, id, "CONTAINS", 1, "resolved", declaration.span);
    }

    for (const entry of entries) {
      const currentModule = moduleName(entry.scanned.relativePath, entry.file.sourceRoot ?? "", packageDirectories);
      for (const importFact of entry.facts.imports) {
          const { fromImport, rawModule, names } = importFact;
          const leading = rawModule.match(/^\.+/)?.[0].length ?? 0;
          const baseParts = currentModule.split(".");
          if (!entry.scanned.relativePath.endsWith("/__init__.py")) baseParts.pop();
          const absoluteModule = leading > 0
            ? [...baseParts.slice(0, Math.max(0, baseParts.length - leading + 1)), rawModule.slice(leading)].filter(Boolean).join(".")
            : rawModule;
          const specs = fromImport ? (names.length ? names : [{ name: "", alias: null }]) : names;
          if (specs.length === 0) addUnresolved(entry.file, entry.moduleId, "IMPORTS", importFact.rawText, importFact.span, 0.5);
          for (const imported of specs) {
            const specifier = fromImport ? `${rawModule} import ${imported.name}` : imported.name;
            const candidates = fromImport && rawModule.replace(/^\.+/, "") === ""
              ? [`${absoluteModule}.${imported.name}`.replace(/^\./, "")]
              : [absoluteModule || imported.name];
            const targets = [...new Set(candidates.flatMap((candidate) => moduleIds.get(candidate) ?? []))]
              .sort((left, right) => left.localeCompare(right));
            const target = targets.length === 1 ? targets[0] : undefined;
            if (target && target !== entry.moduleId) {
              addEdge(entry.moduleId, target, "IMPORTS", 0.95, "resolved", importFact.span, { specifier, alias: imported.alias });
              continue;
            }
            if (targets.length > 0) {
              addUnresolved(entry.file, entry.moduleId, "IMPORTS", specifier, importFact.span, 0.5, targets);
              continue;
            }
            if (leading > 0) {
              addUnresolved(entry.file, entry.moduleId, "IMPORTS", specifier, importFact.span, 0.5);
              continue;
            }
            const packageName = (absoluteModule || imported.name).split(".")[0];
            if (!packageName) {
              addUnresolved(entry.file, entry.moduleId, "IMPORTS", specifier || importFact.rawText, importFact.span, 0.5);
              continue;
            }
            const localKey = `external:pypi:${packageName.toLocaleLowerCase("en-US")}`;
            const id = sha256(`${input.workspace.id}\0${localKey}`);
            if (!nodes.has(id)) nodes.set(id, {
              id, workspaceId: input.workspace.id, fileId: null, kind: "external_module", name: packageName,
              qualifiedName: packageName, localKey, signature: `external module ${packageName}`, doc: "", isExported: true,
              startByte: 0, endByte: 0, startLine: 1, startColumn: 1, endLine: 1, endColumn: 1,
              contentHash: sha256(packageName), generation: input.generation, metadata: { legacyAlias: `external:${packageName}` },
              language: "python", ecosystem: "pypi", nativeKind: "external_module", analysisLevel: "syntax",
            });
            addEdge(entry.moduleId, id, "IMPORTS", 0.95, "resolved", importFact.span, { specifier, alias: imported.alias });
          }
      }
      for (const base of entry.facts.inheritances) {
            const sourceId = base.ownerStartByte === null ? entry.moduleId : declarationIdsByPosition.get(`${entry.file.id}:${base.ownerStartByte}`) ?? entry.moduleId;
            const matches = declarationsByName.get(base.rawName) ?? [];
            const target = matches.length === 1 ? matches[0] : undefined;
            if (target) addEdge(sourceId, target, "EXTENDS", 0.9, "resolved", base.span);
            else addUnresolved(entry.file, sourceId, "EXTENDS", base.rawName, base.span, 0.5);
      }
      for (const callable of entry.facts.calls) {
          const sourceId = callable.ownerStartByte === null ? entry.moduleId : declarationIdsByPosition.get(`${entry.file.id}:${callable.ownerStartByte}`) ?? entry.moduleId;
          if (callable.simpleIdentifier) {
            const matches = declarationsByName.get(callable.rawName) ?? [];
            const target = matches.length === 1 ? matches[0] : undefined;
            if (target && nodes.get(target)?.language === "python") addEdge(sourceId, target, "CALLS", 0.8, "candidate", callable.span);
            else addUnresolved(entry.file, sourceId, "CALLS", callable.rawName, callable.span, 0.5);
          } else addUnresolved(entry.file, sourceId, "CALLS", callable.rawName, callable.span, 0.5);
      }
    }
    return { files, nodes: [...nodes.values()], edges: [...edges.values()], unresolvedReferences: [...unresolved.values()], diagnostics: [...input.project.diagnostics, ...kernel.diagnostics, `GRAPH_KERNEL_MODE: ${kernel.mode}`], providerMetrics: { filesParsed: kernel.filesParsed, mode: kernel.mode, kernelRssBytes: kernel.kernelRssBytes } };
  }
}

export class PythonLanguageAdapter implements LanguageAdapter {
  readonly languageId = "python";
  readonly ecosystem = "pypi";
  readonly extensions = [".py"] as const;
  discoverProject(rootPath: string): ProjectDescriptor { return discoverPythonProject(rootPath); }
  createSyntaxProvider(): SyntaxProvider { return new PythonSyntaxProvider(); }
}
