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
import type { LanguageAdapter, OverlayPrecisionProvider, PrecisionOverlayBatch, ProjectDescriptor, SyntaxGraphBatch, SyntaxProvider } from "../providers.js";

export const PYTHON_PROVIDER_VERSIONS = {
  runtime: "contextmesh-graph-kernel@0.5.0",
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

function evidence(source: CodeEvidence["source"], confidence: number, node?: KernelSpan, provider = "contextmesh_graph_kernel", providerVersion = "0.5.0"): CodeEvidence[] {
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
  readonly version = "0.5.0";

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
            if (target) addEdge(sourceId, target, "EXTENDS", 0.65, "candidate", base.span);
            else addUnresolved(entry.file, sourceId, "EXTENDS", base.rawName, base.span, 0.5);
      }
      for (const callable of entry.facts.calls) {
          const sourceId = callable.ownerStartByte === null ? entry.moduleId : declarationIdsByPosition.get(`${entry.file.id}:${callable.ownerStartByte}`) ?? entry.moduleId;
          if (callable.simpleIdentifier) {
            const matches = declarationsByName.get(callable.rawName) ?? [];
            const target = matches.length === 1 ? matches[0] : undefined;
            if (target && nodes.get(target)?.language === "python") addEdge(sourceId, target, "CALLS", 0.8, "candidate", callable.span);
            else addUnresolved(entry.file, sourceId, "CALLS", callable.rawName, callable.span, 0.5, matches);
          } else addUnresolved(entry.file, sourceId, "CALLS", callable.rawName, callable.span, 0.5);
      }
    }
    return { files, nodes: [...nodes.values()], edges: [...edges.values()], unresolvedReferences: [...unresolved.values()], diagnostics: [...input.project.diagnostics, ...kernel.diagnostics, `GRAPH_KERNEL_MODE: ${kernel.mode}`], providerMetrics: { filesParsed: kernel.filesParsed, mode: kernel.mode, kernelRssBytes: kernel.kernelRssBytes, providerVersion: kernel.providerVersion } };
  }
}

function pythonMask(source: string): string {
  return source.replace(/#[^\r\n]*/g, (value) => " ".repeat(value.length))
    .replace(/'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g,
      (value) => value.replace(/[^\r\n]/g, " "));
}

class PythonResolvedProvider implements OverlayPrecisionProvider {
  readonly id = "contextmesh_python_resolver";
  readonly version = "0.5.0";
  readonly capability = "resolved" as const;

  async available(): Promise<{ available: boolean }> { return { available: true }; }

  async analyze(batch: SyntaxGraphBatch, baseGeneration: number): Promise<PrecisionOverlayBatch> {
    const pythonNodes = batch.nodes.filter((node) => node.language === "python");
    const nodesByFile = new Map<string, CodeNodeRecord[]>();
    const nodesById = new Map(pythonNodes.map((node) => [node.id, node]));
    const containerByNodeId = new Map(
      batch.edges.filter((edge) => edge.kind === "CONTAINS").map((edge) => [edge.targetId, edge.sourceId]),
    );
    const moduleByFile = new Map<string, CodeNodeRecord>();
    const modulesByName = new Map<string, CodeNodeRecord[]>();
    for (const node of pythonNodes) {
      if (!node.fileId) continue;
      const values = nodesByFile.get(node.fileId) ?? []; values.push(node); nodesByFile.set(node.fileId, values);
      if (node.kind === "module") {
        moduleByFile.set(node.fileId, node);
        const modules = modulesByName.get(node.name) ?? []; modules.push(node); modulesByName.set(node.name, modules);
      }
    }
    for (const values of nodesByFile.values()) values.sort((a, b) => a.startByte - b.startByte || a.id.localeCompare(b.id));
    const nodeByModuleAndName = (moduleName: string, name: string): CodeNodeRecord[] =>
      (modulesByName.get(moduleName) ?? []).flatMap((module) => (nodesByFile.get(module.fileId!) ?? []).filter((node) =>
        node.name === name && node.kind !== "module" && containerByNodeId.get(node.id) === module.id));
    type ImportBinding = { module: string; symbol: string | null };
    const aliasesByFile = new Map<string, Map<string, ImportBinding>>();
    const absoluteImportModule = (file: SyntaxGraphBatch["files"][number], module: CodeNodeRecord, rawModule: string): string => {
      const leading = rawModule.match(/^\.+/)?.[0].length ?? 0;
      if (leading === 0) return rawModule;
      const baseParts = module.name.split(".");
      if (!file.relativePath.endsWith("/__init__.py")) baseParts.pop();
      return [
        ...baseParts.slice(0, Math.max(0, baseParts.length - leading + 1)),
        rawModule.slice(leading),
      ].filter(Boolean).join(".");
    };
    for (const file of batch.files.filter((item) => item.language === "python")) {
      const module = moduleByFile.get(file.id);
      if (!module) continue;
      const aliases = new Map<string, ImportBinding>();
      for (const imported of pythonFromImports(file.content)) {
        const importedModule = absoluteImportModule(file, module, imported.module);
        for (const part of imported.names.split(",")) {
          const item = part.trim().match(/^([\w]+)(?:\s+as\s+([\w]+))?/);
          if (item?.[1]) aliases.set(item[2] ?? item[1], { module: importedModule, symbol: item[1] });
        }
      }
      for (const match of file.content.matchAll(/^import\s+([\w.]+)(?:\s+as\s+([\w]+))?/gm)) {
        if (match[1]) aliases.set(match[2] ?? match[1].split(".")[0]!, { module: match[1], symbol: null });
      }
      aliasesByFile.set(file.id, aliases);
    }
    const resolveModuleSymbol = (
      moduleName: string,
      name: string,
      visited = new Set<string>(),
      depth = 0,
    ): CodeNodeRecord[] => {
      const key = `${moduleName}\0${name}`;
      if (depth > 8 || visited.has(key)) return [];
      const nextVisited = new Set(visited).add(key);
      const targets = [...nodeByModuleAndName(moduleName, name)];
      for (const module of modulesByName.get(moduleName) ?? []) {
        if (!module.fileId) continue;
        const binding = aliasesByFile.get(module.fileId)?.get(name);
        if (binding?.symbol) targets.push(...resolveModuleSymbol(
          binding.module,
          binding.symbol,
          nextVisited,
          depth + 1,
        ));
      }
      return [...new Map(targets.map((target) => [target.id, target])).values()];
    };
    const visibleLocalTargets = (module: CodeNodeRecord, owner: CodeNodeRecord, name: string): CodeNodeRecord[] => {
      const visibleContainers = new Set([module.id, owner.id]);
      let current: CodeNodeRecord | undefined = owner;
      const visited = new Set<string>();
      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        const containerId = containerByNodeId.get(current.id);
        if (!containerId) break;
        const container = nodesById.get(containerId);
        if (!container) break;
        if (container.kind === "function" || container.kind === "method") visibleContainers.add(container.id);
        current = container;
      }
      return (nodesByFile.get(module.fileId!) ?? []).filter((node) =>
        node.name === name && node.kind !== "module" && visibleContainers.has(containerByNodeId.get(node.id) ?? ""));
    };
    const evidence = (confidence: number, details: Record<string, unknown>) => [{ provider: this.id, providerVersion: this.version, source: "resolver" as const, confidence, details }];
    const overlays = new Map<string, PrecisionOverlayBatch["edges"][number]>();
    const key = (edge: Pick<PrecisionOverlayBatch["edges"][number], "sourceId" | "targetId" | "kind">) => `${edge.sourceId}\0${edge.targetId}\0${edge.kind}`;
    const parameterNames = (signature: string): Set<string> => {
      const raw = signature.match(/^(?:async\s+)?def\s+\w+\s*\(([^)]*)\)/)?.[1] ?? "";
      return new Set(raw.split(",").map((item) => item.trim())
        .map((item) => item.replace(/^\*{1,2}/, "").split(/[=:]/, 1)[0]?.trim() ?? "")
        .filter((item) => /^\w+$/.test(item)));
    };
    const isLocallyShadowed = (
      file: SyntaxGraphBatch["files"][number],
      owner: CodeNodeRecord,
      name: string,
    ): boolean => {
      if (owner.kind !== "function" && owner.kind !== "method") return false;
      if (parameterNames(owner.signature).has(name)) return true;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const content = Buffer.from(file.content, "utf8");
      const directScope = Buffer.from(content.subarray(owner.startByte, owner.endByte));
      for (const child of (nodesByFile.get(file.id) ?? []).filter((node) =>
        containerByNodeId.get(node.id) === owner.id &&
        (node.kind === "function" || node.kind === "method" || node.kind === "class"))) {
        const start = Math.max(0, child.startByte - owner.startByte);
        const end = Math.min(directScope.length, child.endByte - owner.startByte);
        for (let index = start; index < end; index += 1) {
          if (directScope[index] !== 10 && directScope[index] !== 13) directScope[index] = 32;
        }
      }
      const scope = directScope.toString("utf8");
      const globals = new Set([...scope.matchAll(/^\s*global\s+([^#\r\n]+)/gm)]
        .flatMap((match) => (match[1] ?? "").split(",").map((item) => item.trim())));
      if (globals.has(name)) return false;
      if ((nodesByFile.get(file.id) ?? []).some((node) =>
        node.name === name && containerByNodeId.get(node.id) === owner.id)) return true;
      const bindingPatterns = [
        new RegExp(`(?:^|\\n)\\s*${escaped}\\s*(?::[^=\\n]+)?(?:[+\\-*/%@&|^]?=|:=)`, "m"),
        new RegExp(`\\b(?:async\\s+)?for\\s+${escaped}\\s+in\\b`, "m"),
        new RegExp(`\\bwith\\b[^\\n]*\\bas\\s+${escaped}\\b`, "m"),
        new RegExp(`\\bexcept\\b[^\\n]*\\bas\\s+${escaped}\\b`, "m"),
        new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?(?:def|class)\\s+${escaped}\\b`, "m"),
        new RegExp(`\\bdel\\s+${escaped}\\b`, "m"),
      ];
      if (bindingPatterns.some((pattern) => pattern.test(scope))) return true;
      for (const match of scope.matchAll(/^\s*import\s+([^#\r\n]+)/gm)) {
        if ((match[1] ?? "").split(",").some((item) => {
          const imported = item.trim().match(/^([\w.]+)(?:\s+as\s+(\w+))?/);
          return imported ? (imported[2] ?? imported[1]!.split(".")[0]) === name : false;
        })) return true;
      }
      for (const imported of pythonFromImports(scope)) {
        if (imported.names.split(",").some((item) => {
          const imported = item.trim().match(/^(\w+)(?:\s+as\s+(\w+))?/);
          return imported ? (imported[2] ?? imported[1]) === name : false;
        })) return true;
      }
      return false;
    };
    const resolveQualifiedImport = (
      aliases: Map<string, ImportBinding>,
      qualifier: string,
      name: string,
    ): CodeNodeRecord[] => {
      const [head, ...tail] = qualifier.split(".");
      const imported = head ? aliases.get(head) : undefined;
      if (!imported) return [];
      if (imported.symbol) {
        const importedSubmodule = `${imported.module}.${imported.symbol}`;
        if (modulesByName.has(importedSubmodule)) {
          return resolveModuleSymbol([importedSubmodule, ...tail].join("."), name);
        }
        return tail.length === 0 ? resolveModuleSymbol(imported.module, imported.symbol) : [];
      }
      const suffix = tail.join(".");
      const targetModule = suffix && imported.module !== suffix && !imported.module.endsWith(`.${suffix}`)
        ? `${imported.module}.${suffix}`
        : imported.module;
      return resolveModuleSymbol(targetModule, name);
    };
    let eligibleEdges = 0;

    for (const file of batch.files.filter((item) => item.language === "python")) {
      const module = moduleByFile.get(file.id);
      if (!module) continue;
      const aliases = aliasesByFile.get(file.id) ?? new Map<string, ImportBinding>();
      const masked = maskPythonImportStatements(pythonMask(file.content));
      for (const match of masked.matchAll(/\b((?:\w+\.)*\w+)\s*\(/g)) {
        if (match.index === undefined || !match[1]) continue;
        const calleeParts = match[1].split(".");
        const name = calleeParts.at(-1)!;
        if (["if", "for", "while", "def", "class", "return", "with", "lambda", "print", "super"].includes(name)) continue;
        const prefix = masked.slice(Math.max(0, match.index - 12), match.index);
        if (/\b(?:def|class)\s*$/.test(prefix)) continue;
        eligibleEdges += 1;
        const byte = Buffer.byteLength(file.content.slice(0, match.index), "utf8");
        const owner = (nodesByFile.get(file.id) ?? []).filter((node) => (node.kind === "function" || node.kind === "method") && node.startByte <= byte && node.endByte >= byte)
          .sort((a, b) => (a.endByte - a.startByte) - (b.endByte - b.startByte))[0] ?? module;
        const qualifier = calleeParts.length > 1 ? calleeParts.slice(0, -1).join(".") : null;
        const nestedTargets = !qualifier && (owner.kind === "function" || owner.kind === "method")
          ? (nodesByFile.get(file.id) ?? []).filter((node) =>
            node.name === name && containerByNodeId.get(node.id) === owner.id && node.startByte <= byte)
          : [];
        if (nestedTargets.length === 1 && nestedTargets[0]) {
          const target = nestedTargets[0];
          const resolved = { sourceId: owner.id, targetId: target.id, kind: "CALLS" as const, status: "resolved" as const,
            confidence: 0.95, resolutionKind: "local" as const,
            evidence: evidence(0.95, { rawName: name, binding: "nested_local" }) };
          overlays.set(key(resolved), resolved);
          continue;
        }
        if (!qualifier && isLocallyShadowed(file, owner, name)) {
          for (const candidate of batch.edges.filter((edge) => edge.kind === "CALLS" && edge.sourceId === owner.id && edge.status === "candidate" && nodesById.get(edge.targetId)?.name === name)) {
            const rejected = { sourceId: candidate.sourceId, targetId: candidate.targetId, kind: candidate.kind, status: "rejected" as const,
              confidence: 0.99, resolutionKind: candidate.resolutionKind,
              evidence: evidence(0.99, { reason: "local_binding_shadows_import", rawName: name }) };
            overlays.set(key(rejected), rejected);
          }
          continue;
        }
        let targets: CodeNodeRecord[] = [];
        if (qualifier) {
          targets = resolveQualifiedImport(aliases, qualifier, name);
        } else if (!qualifier && aliases.has(name)) {
          const imported = aliases.get(name)!;
          targets = resolveModuleSymbol(imported.module, imported.symbol ?? name);
        } else if (!qualifier) {
          targets = visibleLocalTargets(module, owner, name);
        }
        const uniqueTargets = [...new Map(targets.map((target) => [target.id, target])).values()];
        if (uniqueTargets.length !== 1 || !uniqueTargets[0]) continue;
        const target = uniqueTargets[0];
        const resolved = { sourceId: owner.id, targetId: target.id, kind: "CALLS" as const, status: "resolved" as const,
          confidence: 0.95, resolutionKind: target.fileId === file.id ? "local" as const : "import" as const,
          evidence: evidence(0.95, { rawName: qualifier ? `${qualifier}.${name}` : name }) };
        overlays.set(key(resolved), resolved);
        for (const candidate of batch.edges.filter((edge) => edge.kind === "CALLS" && edge.sourceId === owner.id &&
          edge.status === "candidate" && edge.targetId !== target.id && edge.evidence?.some((item) =>
            item.source === "syntax" && item.sourceSpan?.startByte === byte))) {
          const rejected = { sourceId: candidate.sourceId, targetId: candidate.targetId, kind: candidate.kind, status: "rejected" as const,
            confidence: 0.95, resolutionKind: candidate.resolutionKind,
            evidence: evidence(0.95, { reason: "resolver_selected_different_target", selectedTargetId: target.id }) };
          overlays.set(key(rejected), rejected);
        }
      }
      for (const match of masked.matchAll(/^\s*class\s+(\w+)\s*\(([^)]*)\)/gm)) {
        const owner = (nodesByFile.get(file.id) ?? []).find((node) => node.kind === "class" && node.name === match[1]);
        if (!owner) continue;
        for (const rawBase of (match[2] ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
          eligibleEdges += 1;
          const parts = rawBase.split(".");
          const name = parts.at(-1)!;
          const qualifier = parts.length > 1 ? parts.slice(0, -1).join(".") : null;
          const imported = qualifier ? resolveQualifiedImport(aliases, qualifier, name)
            : aliases.has(name)
              ? resolveModuleSymbol(aliases.get(name)!.module, aliases.get(name)!.symbol ?? name)
              : [];
          const local = (nodesByFile.get(file.id) ?? []).filter((node) =>
            (node.kind === "class" || node.kind === "interface") && node.name === name &&
            containerByNodeId.get(node.id) === module.id && node.startByte < owner.startByte);
          const targets = imported.length > 0 ? imported : local;
          const uniqueTargets = [...new Map(targets.map((target) => [target.id, target])).values()];
          if (uniqueTargets.length !== 1 || !uniqueTargets[0]) continue;
          const resolved = { sourceId: owner.id, targetId: uniqueTargets[0].id, kind: "EXTENDS" as const, status: "resolved" as const,
            confidence: 0.95, resolutionKind: uniqueTargets[0].fileId === file.id ? "local" as const : "import" as const,
            evidence: evidence(0.95, { rawName: rawBase }) };
          overlays.set(key(resolved), resolved);
        }
      }
    }
    return { language: "python", provider: this.id, providerVersion: this.version, capability: this.capability,
      baseGeneration, edges: [...overlays.values()].sort((a, b) => key(a).localeCompare(key(b))), eligibleEdges, diagnostics: [] };
  }
}

export class PythonLanguageAdapter implements LanguageAdapter {
  readonly languageId = "python";
  readonly ecosystem = "pypi";
  readonly extensions = [".py"] as const;
  discoverProject(rootPath: string): ProjectDescriptor { return discoverPythonProject(rootPath); }
  createSyntaxProvider(): SyntaxProvider { return new PythonSyntaxProvider(); }
  createOverlayPrecisionProvider(): OverlayPrecisionProvider | undefined {
    return process.env.CONTEXTMESH_PYTHON_PRECISION_DISABLE === "1" ? undefined : new PythonResolvedProvider();
  }
}

function pythonFromImports(source: string): Array<{ module: string; names: string }> {
  return [...source.matchAll(/^\s*from\s+([.\w]+)\s+import\s+(?:\(([\s\S]*?)\)|([^#\r\n]+))/gm)]
    .map((match) => ({
      module: match[1] ?? "",
      names: (match[2] ?? match[3] ?? "").replace(/#[^\r\n]*/g, " "),
    }));
}

function maskPythonImportStatements(source: string): string {
  const mask = (value: string): string => value.replace(/[^\r\n]/g, " ");
  return source
    .replace(/^\s*from\s+[.\w]+\s+import\s+(?:\([\s\S]*?\)|[^#\r\n]*)/gm, mask)
    .replace(/^\s*import\s+[^#\r\n]*/gm, mask);
}
