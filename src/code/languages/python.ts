import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { parse as parseToml } from "smol-toml";
import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";

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
import type { LanguageAdapter, ProjectDescriptor, SyntaxGraphBatch, SyntaxProvider } from "../providers.js";

export const PYTHON_PROVIDER_VERSIONS = {
  runtime: "web-tree-sitter@0.26.11",
  grammar: "tree-sitter-python@0.25.0",
  manifest: "smol-toml@1.7.0",
} as const;

const require = createRequire(import.meta.url);
let parserPromise: Promise<Parser> | null = null;

async function pythonParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      const runtimeDirectory = path.dirname(require.resolve("web-tree-sitter"));
      await Parser.init({ locateFile: (file: string) => path.join(runtimeDirectory, file) });
      const grammarDirectory = path.dirname(require.resolve("tree-sitter-python/package.json"));
      const language = await Language.load(path.join(grammarDirectory, "tree-sitter-python.wasm"));
      return new Parser().setLanguage(language);
    })();
  }
  return parserPromise;
}

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

function evidence(source: CodeEvidence["source"], confidence: number, node?: SyntaxNode): CodeEvidence[] {
  return [{
    provider: "tree_sitter_python",
    providerVersion: "0.25.0",
    source,
    confidence,
    ...(node ? { sourceSpan: {
      startByte: node.startIndex,
      endByte: node.endIndex,
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
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

function importedName(node: SyntaxNode): { name: string; alias: string | null } | null {
  if (node.type === "aliased_import") {
    const name = node.childForFieldName("name")?.text.trim();
    if (!name) return null;
    return { name, alias: node.childForFieldName("alias")?.text.trim() ?? null };
  }
  const name = node.text.trim();
  return name ? { name, alias: null } : null;
}

class PythonSyntaxProvider implements SyntaxProvider {
  readonly id = "tree_sitter_python";
  readonly version = "0.25.0";

  async extract(input: Parameters<SyntaxProvider["extract"]>[0]): Promise<SyntaxGraphBatch> {
    const parser = await pythonParser();
    const files: IndexedSourceFile[] = [];
    const nodes = new Map<string, CodeNodeRecord>();
    const edges = new Map<string, CodeEdgeRecord>();
    const unresolved = new Map<string, UnresolvedReferenceRecord>();
    const moduleIds = new Map<string, string[]>();
    const declarationsByName = new Map<string, string[]>();
    const declarationIdsByPosition = new Map<string, string>();
    const declarationOrdinals = new Map<string, number>();
    const packageDirectories = ((input.project.runtime as PythonProjectRuntime | undefined)?.packageDirectories ?? []);
    const trees: Array<{ scanned: (typeof input.files)[number]; file: IndexedSourceFile; moduleId: string; tree: ReturnType<Parser["parse"]> }> = [];
    const edgeKey = (edge: CodeEdgeRecord): string => `${edge.sourceId}\0${edge.targetId}\0${edge.kind}`;

    for (const scanned of input.files.filter((file) => file.language === "python")) {
      const root = sourceRootFor(scanned, input.project.sourceRoots);
      const fileId = sha256(`${input.workspace.id}\0${scanned.pathKey}`);
      const tree = parser.parse(scanned.content);
      const hasError = tree?.rootNode.hasError ?? true;
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
      trees.push({ scanned, file, moduleId, tree });
    }

    const addEdge = (sourceId: string, targetId: string, kind: CodeEdgeKind, confidence: number, status: "candidate" | "resolved", node?: SyntaxNode, details: Record<string, unknown> = {}): void => {
      if (kind === "IMPORTS" && sourceId === targetId) return;
      const record: CodeEdgeRecord = {
        workspaceId: input.workspace.id, sourceId, targetId, kind, confidence,
        resolutionKind: status === "candidate" ? "heuristic" : kind === "IMPORTS" ? "import" : "local",
        generation: input.generation, metadata: details, status, evidence: evidence("syntax", confidence, node),
      };
      edges.set(edgeKey(record), record);
    };
    const addUnresolved = (file: IndexedSourceFile, sourceNodeId: string, kind: string, rawName: string, node: SyntaxNode, confidence = 0.5, candidates: string[] = []): void => {
      const item: UnresolvedReferenceRecord = {
        workspaceId: input.workspace.id, fileId: file.id, sourceNodeId, kind, rawName: clampText(rawName, 200),
        qualifier: null, line: node.startPosition.row + 1, column: node.startPosition.column + 1,
        candidates: [...new Set(candidates)].sort((left, right) => left.localeCompare(right)),
        generation: input.generation, confidence, evidence: evidence("syntax", confidence, node),
      };
      unresolved.set(`${file.id}\0${sourceNodeId}\0${kind}\0${rawName}\0${item.line}\0${item.column}`, item);
    };

    const declarationPass = (entry: (typeof trees)[number]): void => {
      if (!entry.tree) return;
      const visit = (node: SyntaxNode, containerId: string, names: string[], containerKind: CodeNodeKind): void => {
        if (node.type === "decorated_definition") {
          const definition = node.namedChildren.at(-1);
          if (definition) visit(definition, containerId, names, containerKind);
          return;
        }
        let activeId = containerId;
        let activeNames = names;
        let activeKind = containerKind;
        const actual = node;
        const functionLike = actual.type === "function_definition";
        const classLike = actual.type === "class_definition";
        if (functionLike || classLike) {
          const nameNode = actual.childForFieldName("name");
          if (nameNode) {
            const name = nameNode.text;
            const kind: CodeNodeKind = classLike ? "class" : containerKind === "class" ? "method" : "function";
            const symbolPath = [...names, name].join(".");
            const content = actual.text;
            const signature = clampText(content.split(/:\s*(?:#.*)?\r?\n/, 1)[0] ?? content, 1000);
            const locatorKey = `${entry.file.pathKey}:${kind}:${symbolPath}`;
            const ordinal = (declarationOrdinals.get(locatorKey) ?? 0) + 1;
            declarationOrdinals.set(locatorKey, ordinal);
            const declarationHash = sha256(signature.trim().replace(/\s+/g, " "));
            const localKey = `${locatorKey}:${ordinal}:${declarationHash.slice(0, 16)}`;
            const id = sha256(`${input.workspace.id}\0python\0${locatorKey}\0${ordinal}\0${declarationHash}`);
            nodes.set(id, {
              id, workspaceId: input.workspace.id, fileId: entry.file.id, kind, name,
              qualifiedName: `${entry.file.relativePath}#${symbolPath}`, localKey,
              signature, doc: "",
              isExported: !name.startsWith("_"), startByte: actual.startIndex, endByte: actual.endIndex,
              startLine: actual.startPosition.row + 1, startColumn: actual.startPosition.column + 1,
              endLine: actual.endPosition.row + 1, endColumn: actual.endPosition.column + 1,
              contentHash: sha256(content), generation: input.generation,
              metadata: { async: actual.namedChildren.some((child) => child.type === "async"), stableLocator: locatorKey, declarationHash, ordinal },
              language: "python", ecosystem: "pypi", nativeKind: actual.type, analysisLevel: "syntax",
            });
            const matches = declarationsByName.get(name) ?? [];
            matches.push(id); declarationsByName.set(name, matches);
            declarationIdsByPosition.set(`${entry.file.id}:${actual.startIndex}`, id);
            addEdge(containerId, id, "CONTAINS", 1, "resolved", actual);
            activeId = id; activeNames = [...names, name]; activeKind = kind;
          }
        }
        for (const child of node.namedChildren) visit(child, activeId, activeNames, activeKind);
      };
      visit(entry.tree.rootNode, entry.moduleId, [], "module");
    };
    trees.forEach(declarationPass);

    for (const entry of trees) {
      if (!entry.tree) continue;
      const currentModule = moduleName(entry.scanned.relativePath, entry.file.sourceRoot ?? "", packageDirectories);
      const visit = (node: SyntaxNode, callerId: string): void => {
        if (node.type === "decorated_definition") {
          const definition = node.namedChildren.at(-1);
          if (definition) visit(definition, callerId);
          return;
        }
        const definition = node.type === "function_definition" || node.type === "class_definition" ? node : null;
        const nextCaller = definition ? (declarationIdsByPosition.get(`${entry.file.id}:${definition.startIndex}`) ?? callerId) : callerId;
        if (node.type === "import_statement" || node.type === "import_from_statement") {
          const fromImport = node.type === "import_from_statement";
          const moduleNode = fromImport ? node.namedChildren[0] : null;
          const rawModule = fromImport ? (moduleNode?.text.trim() ?? "") : "";
          const importNodes = fromImport ? node.namedChildren.slice(1) : node.namedChildren;
          const names = importNodes.map(importedName).filter((item): item is NonNullable<typeof item> => item !== null);
          const leading = rawModule.match(/^\.+/)?.[0].length ?? 0;
          const baseParts = currentModule.split(".");
          if (!entry.scanned.relativePath.endsWith("/__init__.py")) baseParts.pop();
          const absoluteModule = leading > 0
            ? [...baseParts.slice(0, Math.max(0, baseParts.length - leading + 1)), rawModule.slice(leading)].filter(Boolean).join(".")
            : rawModule;
          const specs = fromImport ? (names.length ? names : [{ name: "", alias: null }]) : names;
          if (specs.length === 0) addUnresolved(entry.file, entry.moduleId, "IMPORTS", node.text, node, 0.5);
          for (const imported of specs) {
            const specifier = fromImport ? `${rawModule} import ${imported.name}` : imported.name;
            const candidates = fromImport && rawModule.replace(/^\.+/, "") === ""
              ? [`${absoluteModule}.${imported.name}`.replace(/^\./, "")]
              : [absoluteModule || imported.name];
            const targets = [...new Set(candidates.flatMap((candidate) => moduleIds.get(candidate) ?? []))]
              .sort((left, right) => left.localeCompare(right));
            const target = targets.length === 1 ? targets[0] : undefined;
            if (target && target !== entry.moduleId) {
              addEdge(entry.moduleId, target, "IMPORTS", 0.95, "resolved", node, { specifier, alias: imported.alias });
              continue;
            }
            if (targets.length > 0) {
              addUnresolved(entry.file, entry.moduleId, "IMPORTS", specifier, node, 0.5, targets);
              continue;
            }
            if (leading > 0) {
              addUnresolved(entry.file, entry.moduleId, "IMPORTS", specifier, node, 0.5);
              continue;
            }
            const packageName = (absoluteModule || imported.name).split(".")[0];
            if (!packageName) {
              addUnresolved(entry.file, entry.moduleId, "IMPORTS", specifier || node.text, node, 0.5);
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
            addEdge(entry.moduleId, id, "IMPORTS", 0.95, "resolved", node, { specifier, alias: imported.alias });
          }
        }
        if (node.type === "class_definition") {
          const superclasses = node.childForFieldName("superclasses");
          for (const base of superclasses?.namedChildren ?? []) {
            const matches = declarationsByName.get(base.text) ?? [];
            const target = matches.length === 1 ? matches[0] : undefined;
            if (target) addEdge(nextCaller, target, "EXTENDS", 0.9, "resolved", base);
            else addUnresolved(entry.file, nextCaller, "EXTENDS", base.text, base, 0.5);
          }
        }
        if (node.type === "call") {
          const callable = node.childForFieldName("function");
          if (callable?.type === "identifier") {
            const matches = declarationsByName.get(callable.text) ?? [];
            const target = matches.length === 1 ? matches[0] : undefined;
            if (target && nodes.get(target)?.language === "python") addEdge(nextCaller, target, "CALLS", 0.8, "candidate", callable);
            else addUnresolved(entry.file, nextCaller, "CALLS", callable.text, callable, 0.5);
          } else if (callable) addUnresolved(entry.file, nextCaller, "CALLS", callable.text, callable, 0.5);
        }
        for (const child of node.namedChildren) visit(child, nextCaller);
      };
      visit(entry.tree.rootNode, entry.moduleId);
      entry.tree.delete();
    }
    return { files, nodes: [...nodes.values()], edges: [...edges.values()], unresolvedReferences: [...unresolved.values()], diagnostics: input.project.diagnostics };
  }
}

export class PythonLanguageAdapter implements LanguageAdapter {
  readonly languageId = "python";
  readonly ecosystem = "pypi";
  readonly extensions = [".py"] as const;
  discoverProject(rootPath: string): ProjectDescriptor { return discoverPythonProject(rootPath); }
  createSyntaxProvider(): SyntaxProvider { return new PythonSyntaxProvider(); }
}
