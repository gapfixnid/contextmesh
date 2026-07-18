import { readFileSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import ts from "typescript";

import type {
  CodeEdgeKind,
  CodeEdgeRecord,
  CodeNodeKind,
  CodeNodeRecord,
  ExtractedGraph,
  IndexedSourceFile,
  IndexMode,
  UnresolvedReferenceRecord,
  WorkspaceRecord,
  AdapterStats,
  AdapterStateMap,
} from "../contracts.js";
import type {
  CodeSearchResult,
  ContextMeshStorage,
  FreshnessState,
  IndexCommitStats,
} from "../storage/database.js";
import { AsyncMutex } from "../concurrency.js";
import { ContextMeshError } from "../errors.js";
import type { SemanticService } from "../semantic/service.js";
import {
  clampText,
  isPathInside,
  normalizePathKey,
  sha256,
} from "../utils.js";
import {
  hydrateScannedFile,
  scanWorkspaceMetadata,
  type ScannedFile,
  type ScannedFileMetadata,
} from "./scanner.js";
import { PythonLanguageAdapter, PYTHON_PROVIDER_VERSIONS } from "./languages/python.js";
import { TypeScriptLanguageAdapter } from "./languages/typescript.js";
import { GraphIndexCoordinator, mergeGraphBatches, type ProjectDescriptor } from "./providers.js";

export type FreshnessMode = "fast" | "strict";

export interface RequestGenerationState {
  generation: number;
  successFence: number;
  stale: boolean;
}

interface ProcessBaseline {
  generation: number;
  successFence: number;
  configHash: string;
  files: ReadonlyMap<string, { sizeBytes: number; mtimeMs: number }>;
}

interface WorkspaceRuntime {
  readonly indexMutex: AsyncMutex;
  readonly freshnessMutex: AsyncMutex;
  baseline: ProcessBaseline | null;
}

const WORKSPACE_RUNTIMES = new Map<string, WorkspaceRuntime>();

function workspaceRuntime(key: string): WorkspaceRuntime {
  const existing = WORKSPACE_RUNTIMES.get(key);
  if (existing) return existing;
  const created: WorkspaceRuntime = {
    indexMutex: new AsyncMutex(),
    freshnessMutex: new AsyncMutex(),
    baseline: null,
  };
  WORKSPACE_RUNTIMES.set(key, created);
  return created;
}

export interface IndexResult {
  generation: number;
  mode: IndexMode;
  noOp: boolean;
  files: number;
  nodes: number;
  edges: number;
  unresolved: number;
  reinterpretedFiles: number;
  changedFiles: number;
  deletedFiles: number;
  diagnostics: string[];
  adapterStats: AdapterStats[];
}

interface DeclarationDescriptor {
  kind: CodeNodeKind;
  name: string;
  nameNode: ts.Node | null;
}

interface ExtractionState {
  workspace: WorkspaceRecord;
  generation: number;
  compilerOptions: ts.CompilerOptions;
  checker: ts.TypeChecker | null;
  filesByPath: Map<string, IndexedSourceFile>;
  moduleByPath: Map<string, string>;
  nodes: Map<string, CodeNodeRecord>;
  edges: Map<string, CodeEdgeRecord>;
  unresolved: Map<string, UnresolvedReferenceRecord>;
  declarationNodes: Map<ts.Node, string>;
  symbolNodes: Map<ts.Symbol, string>;
  caseSensitivePaths: boolean;
}

interface TypeScriptProviderRuntime {
  diagnostics: string[];
  compiler: CompilerConfiguration;
  relationshipScope?: Set<string>;
  context?: { program: ts.Program; state: ExtractionState; programCreations: number };
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
    return true;
  }
  if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)) {
    return hasExportModifier(node.parent.parent);
  }
  return false;
}

function nodeNameText(name: ts.PropertyName | ts.BindingName | undefined, sourceFile: ts.SourceFile): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return clampText(name.expression.getText(sourceFile), 120);
  return null;
}

function describeDeclaration(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  containerKind: CodeNodeKind,
): DeclarationDescriptor | null {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return { kind: "function", name: node.name.text, nameNode: node.name };
  }
  if (ts.isClassDeclaration(node) && node.name) {
    return { kind: "class", name: node.name.text, nameNode: node.name };
  }
  if (ts.isInterfaceDeclaration(node)) {
    return { kind: "interface", name: node.name.text, nameNode: node.name };
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return { kind: "type_alias", name: node.name.text, nameNode: node.name };
  }
  if (ts.isEnumDeclaration(node)) {
    return { kind: "enum", name: node.name.text, nameNode: node.name };
  }
  if (
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    const name = nodeNameText(node.name, sourceFile);
    return name ? { kind: "method", name, nameNode: node.name } : null;
  }
  if (ts.isConstructorDeclaration(node)) {
    return { kind: "method", name: "constructor", nameNode: null };
  }
  if (
    ts.isPropertyDeclaration(node) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    const name = nodeNameText(node.name, sourceFile);
    return name ? { kind: "method", name, nameNode: node.name } : null;
  }
  if (ts.isVariableDeclaration(node) && (containerKind === "module" || containerKind === "class")) {
    const name = nodeNameText(node.name, sourceFile);
    if (!name) return null;
    if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      return { kind: containerKind === "class" ? "method" : "function", name, nameNode: node.name };
    }
    if (node.initializer && ts.isClassExpression(node.initializer)) {
      return { kind: "class", name, nameNode: node.name };
    }
    return { kind: "variable", name, nameNode: node.name };
  }
  return null;
}

function declarationSignature(
  node: ts.Node,
  descriptor: DeclarationDescriptor,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): string {
  if (descriptor.nameNode) {
    const symbol = checker.getSymbolAtLocation(descriptor.nameNode);
    if (symbol) {
      try {
        const type = checker.getTypeOfSymbolAtLocation(symbol, node);
        const signature = type.getCallSignatures()[0];
        if (signature) return clampText(`${descriptor.name}${checker.signatureToString(signature)}`, 1000);
      } catch {
        // Fall back to source text for symbols TypeScript cannot fully type.
      }
    }
  }
  const text = node.getText(sourceFile).trim();
  const bodyIndex = text.indexOf("{");
  return clampText((bodyIndex >= 0 ? text.slice(0, bodyIndex) : text).replace(/\s+/g, " ").trim(), 1000);
}

function declarationSyntaxSignature(node: ts.Node, sourceFile: ts.SourceFile): string {
  const text = node.getText(sourceFile).trim();
  const bodyIndex = text.indexOf("{");
  return clampText((bodyIndex >= 0 ? text.slice(0, bodyIndex) : text).replace(/\s+/g, " ").trim(), 1000);
}

function declarationDoc(
  descriptor: DeclarationDescriptor,
  checker: ts.TypeChecker,
): string {
  if (!descriptor.nameNode) return "";
  const symbol = checker.getSymbolAtLocation(descriptor.nameNode);
  return symbol ? clampText(ts.displayPartsToString(symbol.getDocumentationComment(checker)), 2000) : "";
}

function edgeKey(edge: Pick<CodeEdgeRecord, "sourceId" | "targetId" | "kind">): string {
  return `${edge.sourceId}\0${edge.targetId}\0${edge.kind}`;
}

function unresolvedKey(reference: UnresolvedReferenceRecord): string {
  return `${reference.fileId}\0${reference.sourceNodeId ?? ""}\0${reference.kind}\0${reference.rawName}\0${reference.line}:${reference.column}`;
}

function addEdge(
  state: ExtractionState,
  sourceId: string,
  targetId: string,
  kind: CodeEdgeKind,
  resolutionKind: CodeEdgeRecord["resolutionKind"] = "exact",
  confidence = 1,
  metadata: Record<string, unknown> = {},
  evidenceSource: "syntax" | "type_checker" = "syntax",
): void {
  if (sourceId === targetId && kind !== "CALLS") return;
  const provider = evidenceSource === "syntax" ? "typescript_compiler_ast" : "typescript_type_checker";
  const incomingEvidence = [{ provider, providerVersion: ts.version, source: evidenceSource, confidence }];
  const existing = state.edges.get(edgeKey({ sourceId, targetId, kind }));
  const edge: CodeEdgeRecord = {
    workspaceId: state.workspace.id,
    sourceId,
    targetId,
    kind,
    confidence,
    resolutionKind,
    generation: state.generation,
    metadata,
    status: "resolved",
    evidence: existing ? [...(existing.evidence ?? []), ...incomingEvidence] : incomingEvidence,
  };
  state.edges.set(edgeKey(edge), edge);
}

function aliasedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (!symbol) return undefined;
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

function resolveSymbolNode(state: ExtractionState, symbol: ts.Symbol | undefined): string | null {
  if (!state.checker) return null;
  const resolved = aliasedSymbol(state.checker, symbol);
  if (!resolved) return null;
  const direct = state.symbolNodes.get(resolved) ?? state.symbolNodes.get(symbol as ts.Symbol);
  if (direct) return direct;
  for (const declaration of resolved.declarations ?? []) {
    const id = state.declarationNodes.get(declaration);
    if (id) return id;
  }
  return null;
}

function symbolBelongsToWorkspace(state: ExtractionState, symbol: ts.Symbol | undefined): boolean {
  if (!state.checker) return false;
  const resolved = aliasedSymbol(state.checker, symbol);
  return Boolean(
    resolved?.declarations?.some((declaration) => {
      if (
        ts.isImportSpecifier(declaration) ||
        ts.isImportClause(declaration) ||
        ts.isNamespaceImport(declaration) ||
        ts.isImportEqualsDeclaration(declaration)
      ) {
        return false;
      }
      return state.filesByPath.has(
        normalizePathKey(declaration.getSourceFile().fileName, state.caseSensitivePaths),
      );
    }),
  );
}

function diagnosticText(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  if (!diagnostic.file || diagnostic.start === undefined) return message;
  const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${diagnostic.file.fileName}:${location.line + 1}:${location.character + 1} ${message}`;
}

interface CompilerConfiguration {
  options: ts.CompilerOptions;
  diagnostics: string[];
  fatalDiagnostics: string[];
  configHash: string;
  hasConfig: boolean;
  configuredFileNames: Set<string>;
}

interface ProjectScan {
  scan: { files: ScannedFile[]; diagnostics: string[] };
  files: ScannedFile[];
  compiler: CompilerConfiguration;
  pythonProject: ProjectDescriptor;
  configHash: string;
}

interface MetadataProjectScan {
  scan: ReturnType<typeof scanWorkspaceMetadata>;
  files: ScannedFileMetadata[];
  compiler: CompilerConfiguration;
  pythonProject: ProjectDescriptor;
  configHash: string;
}

function canonicalizeCompilerValue(value: unknown, caseSensitivePaths: boolean): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const normalized = value.normalize("NFC").replaceAll("\\", "/");
    return path.isAbsolute(value) ? normalizePathKey(value, caseSensitivePaths) : normalized;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeCompilerValue(item, caseSensitivePaths));
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (key === "configFile") continue;
      const normalized = canonicalizeCompilerValue(
        (value as Record<string, unknown>)[key],
        caseSensitivePaths,
      );
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  }
  return String(value);
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  const lower = fileName.toLocaleLowerCase("en-US");
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

export class CodeIndexer {
  private readonly database: ContextMeshStorage;
  private readonly rootPath: string;
  private readonly caseSensitivePaths: boolean;
  private readonly runtime: WorkspaceRuntime;
  private readonly semantic: SemanticService | null;
  readonly freshnessMode: FreshnessMode;
  readonly coordinator = new GraphIndexCoordinator();
  private lastAdapterStats: AdapterStats[] = [];
  private lastSyntaxEvaluationGraph: ExtractedGraph | null = null;
  private lastTypeScriptInstrumentation = { programCreations: 0, syntaxWorkItems: 0, precisionWorkItems: 0 };

  constructor(
    database: ContextMeshStorage,
    freshnessMode: FreshnessMode = "fast",
    semantic: SemanticService | null = null,
  ) {
    this.database = database;
    this.rootPath = database.rootPath;
    this.caseSensitivePaths = database.caseSensitivePaths;
    this.freshnessMode = freshnessMode;
    this.semantic = semantic;
    this.runtime = workspaceRuntime(`${database.dbPath}\0${database.workspace.id}`);
    this.lastAdapterStats = Object.values(database.getAdapterState()).map((state) => state.stats);
    this.coordinator.register(new PythonLanguageAdapter());
    this.coordinator.register(new TypeScriptLanguageAdapter(
      async (input) => this.extractTypeScriptSyntax(input.workspace, input.files, input.generation, input.project.runtime as TypeScriptProviderRuntime),
      async (project, batch) => this.refineTypeScript(batch, project.runtime as TypeScriptProviderRuntime),
    ));
  }

  adapterStats(): AdapterStats[] { return this.lastAdapterStats.map((item) => ({ ...item })); }
  typeScriptInstrumentation(): Readonly<typeof this.lastTypeScriptInstrumentation> {
    return { ...this.lastTypeScriptInstrumentation };
  }
  evaluationGraph(level: "syntax" | "typed"): ExtractedGraph {
    if (level === "syntax" && this.lastSyntaxEvaluationGraph) return this.lastSyntaxEvaluationGraph;
    const python = this.database.getStoredGraphPartition("python");
    const typescript = this.database.getStoredGraphPartition("non-python");
    return mergeGraphBatches([{
      files: [], nodes: typescript.nodes, edges: typescript.edges,
      unresolvedReferences: typescript.unresolvedReferences, diagnostics: [],
    }, {
      files: [], nodes: python.nodes, edges: python.edges,
      unresolvedReferences: python.unresolvedReferences, diagnostics: [],
    }], this.lastAdapterStats);
  }

  dispose(): void {
    // A process-local baseline is cheap to rebuild and must never survive an app lifecycle as if it were durable.
    this.runtime.baseline = null;
  }

  async checkFreshness(mode: FreshnessMode = this.freshnessMode): Promise<RequestGenerationState> {
    return this.runtime.freshnessMutex.runExclusive(() => this.checkFreshnessUnlocked(mode));
  }

  async verifyStartup(): Promise<RequestGenerationState> {
    return this.checkFreshness("strict");
  }

  async readFinalRequestState(): Promise<RequestGenerationState> {
    return this.runtime.freshnessMutex.runExclusive(() => this.readFinalRequestStateUnlocked());
  }

  async recordStaleIfCurrent(
    requestGeneration: number,
    requestSuccessFence: number,
    reason: string,
  ): Promise<boolean> {
    return this.runtime.freshnessMutex.runExclusive(() => {
      return this.recordStaleUnlocked(reason, requestGeneration, requestSuccessFence);
    });
  }

  async index(mode: IndexMode): Promise<IndexResult> {
    return this.runtime.indexMutex.runExclusive(async () => {
      const startingState = await this.runtime.freshnessMutex.runExclusive(() =>
        this.database.getFreshnessState(),
      );
      const handle = this.database.startIndexRun(mode);
      // Let already queued graph requests observe the running fence and use the last committed graph.
      await yieldToEventLoop();

      let project: ProjectScan;
      let result: IndexResult;
      try {
        project = this.loadProject();
        if (project.compiler.fatalDiagnostics.length > 0) {
          this.database.failIndexRun(handle, project.compiler.fatalDiagnostics);
          throw new ContextMeshError(
            "PARSE_PARTIAL",
            "TypeScript project configuration is invalid; the last committed generation was preserved",
            { diagnostics: project.compiler.fatalDiagnostics },
          );
        }
        const scan = project.scan;
        const compiler = project.compiler;
        const projectFiles = project.files;
        const previous = this.database.getFileHashes();
        const changedPathKeys = projectFiles
          .filter((file) => previous.get(file.pathKey) !== file.contentHash)
          .map((file) => file.pathKey);
        const changedFiles = changedPathKeys.length;
        const scannedKeys = new Set(projectFiles.map((file) => file.pathKey));
        const deletedPathKeys = [...previous.keys()].filter((key) => !scannedKeys.has(key));
        const deletedFiles = deletedPathKeys.length;
        const workspace = this.database.getWorkspace();
        const priorAdapterState = this.database.getAdapterState();
        const typescriptConfigChanged = priorAdapterState["typescript/javascript"]?.configHash !== compiler.configHash;
        const pythonConfigChanged = priorAdapterState.python?.configHash !== project.pythonProject.configHash;
        const configurationChanged = this.database.getIndexConfigHash() !== project.configHash;

        if (
          mode === "incremental" &&
          workspace.currentGeneration > 0 &&
          changedFiles === 0 &&
          deletedFiles === 0 &&
          !configurationChanged
        ) {
          const stats: IndexCommitStats = {
            scannedFiles: projectFiles.length,
            changedFiles: 0,
            deletedFiles: 0,
            failedFiles: 0,
          };
          this.database.completeNoOpRun(
            handle, stats, scan.diagnostics, project.configHash, this.lastAdapterStats, priorAdapterState,
          );
          await this.semantic?.reconcileCodeIfNeeded();
          const counts = this.database.getStatus().counts as Record<string, number>;
          result = {
            generation: workspace.currentGeneration,
            mode,
            noOp: true,
            files: projectFiles.length,
            nodes: Number(counts.nodes ?? 0),
            edges: Number(counts.edges ?? 0),
            unresolved: Number(counts.unresolved ?? 0),
            reinterpretedFiles: 0,
            changedFiles: 0,
            deletedFiles: 0,
            diagnostics: scan.diagnostics,
            adapterStats: this.lastAdapterStats,
          };
        } else {
          const hasAddedFile = changedPathKeys.some((key) => !previous.has(key));
          const declarationFileChanged = [...changedPathKeys, ...deletedPathKeys].some((key) => key.endsWith(".d.ts"));
          const hadUnresolvedFailure =
            startingState.failureFenceGeneration > startingState.successFenceGeneration;
          const requiresFullRelationshipPass =
            mode === "full" ||
            workspace.currentGeneration === 0 ||
            configurationChanged ||
            hadUnresolvedFailure ||
            hasAddedFile ||
            declarationFileChanged;
          const relationshipScope = requiresFullRelationshipPass
            ? undefined
            : this.database.getReverseDependencyClosure([...changedPathKeys, ...deletedPathKeys]);
          const typescriptFiles = projectFiles.filter((file) => file.language !== "python");
          const pythonFiles = projectFiles.filter((file) => file.language === "python");
          const pythonOnlyIncremental = mode === "incremental" && workspace.currentGeneration > 0 &&
            !typescriptConfigChanged && (pythonConfigChanged || changedPathKeys.length + deletedPathKeys.length > 0) &&
            [...changedPathKeys, ...deletedPathKeys].every((key) => key.endsWith(".py"));
          const tsRuntime: TypeScriptProviderRuntime = {
            diagnostics: scan.diagnostics,
            compiler,
            ...(relationshipScope ? { relationshipScope } : {}),
          };
          const tsAdapter = this.coordinator.adapter("typescript/javascript")!;
          const discoveredTsProject = tsAdapter.discoverProject(this.rootPath);
          const tsProject: ProjectDescriptor = {
            ...discoveredTsProject, sourceRoots: discoveredTsProject.sourceRoots.length ? discoveredTsProject.sourceRoots : [""],
            configHash: compiler.configHash, diagnostics: compiler.diagnostics, runtime: tsRuntime,
          };
          let tsGraph = pythonOnlyIncremental
            ? this.reuseStoredTypescriptGraph(workspace, typescriptFiles, handle.generation)
            : await tsAdapter.createSyntaxProvider(tsProject).extract({ workspace, project: tsProject, files: typescriptFiles, generation: handle.generation });
          const tsSyntaxGraph = tsGraph;
          if (!pythonOnlyIncremental) {
            const precision = tsAdapter.createPrecisionProvider?.(tsProject);
            if (precision) tsGraph = await precision.refine(tsGraph);
          }
          for (const file of tsGraph.files) {
            file.ecosystem = "npm";
            file.adapterConfigHash = compiler.configHash;
          }
          for (const node of tsGraph.nodes) {
            node.language = (node.metadata.language as CodeNodeRecord["language"] | undefined) ?? "typescript";
            node.ecosystem = "npm";
            node.nativeKind = (node.metadata.syntaxKind as string | undefined) ?? node.kind;
            node.analysisLevel = "typed";
          }
          const pythonAdapter = this.coordinator.adapter("python");
          const pythonProvider = pythonAdapter?.createSyntaxProvider(project.pythonProject);
          const pythonGraph = pythonProvider
            ? await pythonProvider.extract({ workspace, project: project.pythonProject, files: pythonFiles, generation: handle.generation })
            : { files: [], nodes: [], edges: [], unresolvedReferences: [], diagnostics: [] };
          const adapterStats: AdapterStats[] = [
            ...(typescriptFiles.length > 0 ? [{
              language: "typescript/javascript", ecosystem: "npm", syntaxProvider: "typescript_compiler_ast",
              precisionProvider: "typescript_type_checker", analysisLevel: "typed" as const, files: typescriptFiles.length,
              syntaxInvocations: pythonOnlyIncremental ? 0 : 1, precisionInvocations: pythonOnlyIncremental ? 0 : 1,
              configHash: compiler.configHash,
              providerVersions: { syntax: ts.version, precision: ts.version }, status: "ready" as const,
              coverage: 1, diagnostics: [],
            }] : []),
            ...(pythonFiles.length > 0 ? [{
              language: "python", ecosystem: "pypi", syntaxProvider: "tree_sitter_python", precisionProvider: null,
              analysisLevel: "syntax" as const, files: pythonFiles.length, syntaxInvocations: 1, precisionInvocations: 0,
              configHash: project.pythonProject.configHash,
              providerVersions: { ...PYTHON_PROVIDER_VERSIONS }, status: "ready" as const,
              coverage: 1, diagnostics: project.pythonProject.diagnostics.map((message) => ({
                code: "PYTHON_PROJECT_DIAGNOSTIC", severity: "warning" as const, message,
              })),
            }] : []),
          ];
          this.lastAdapterStats = adapterStats;
          this.lastSyntaxEvaluationGraph = mergeGraphBatches([tsSyntaxGraph, pythonGraph], adapterStats);
          const adapterState: AdapterStateMap = Object.fromEntries(adapterStats.map((item) => [item.language, {
            configHash: item.configHash,
            lastGeneration: handle.generation,
            precisionRevision: item.language === "typescript/javascript"
              ? (item.precisionInvocations > 0 ? handle.generation : (priorAdapterState[item.language]?.precisionRevision ?? 0))
              : 0,
            stats: item,
          }]));
          const graph = mergeGraphBatches([tsGraph, pythonGraph], adapterStats);
          const reinterpretedFiles = relationshipScope
            ? projectFiles.filter((file) => relationshipScope.has(file.pathKey)).length
            : projectFiles.length;
          const stats: IndexCommitStats = {
            scannedFiles: graph.files.length,
            changedFiles: mode === "full" ? graph.files.length : changedFiles,
            deletedFiles,
            failedFiles: graph.files.filter((file) => file.parseStatus !== "ok").length,
          };
          const preparedSemantic = this.semantic
            ? await this.semantic.prepareCodeCommit(graph, handle.generation)
            : undefined;
          const semanticCommit = preparedSemantic?.commit;
          if (semanticCommit?.lastError) {
            graph.diagnostics.push(
              `${semanticCommit.unavailable ? "SEMANTIC_UNAVAILABLE" : "SEMANTIC_PARTIAL"}: ${semanticCommit.lastError}`,
            );
          }
          try {
            this.database.commitGraph(
              handle,
              graph,
              stats,
              project.configHash,
              adapterState,
              semanticCommit,
              preparedSemantic?.claim,
            );
          } catch (error) {
            if (preparedSemantic?.claim) {
              this.database.abandonCodeIndexClaim(preparedSemantic.claim, "index_failed");
            }
            throw error;
          } finally {
            preparedSemantic?.stopHeartbeat();
          }
          result = {
            generation: handle.generation,
            mode,
            noOp: false,
            files: graph.files.length,
            nodes: graph.nodes.length,
            edges: graph.edges.length,
            unresolved: graph.unresolvedReferences.length,
            reinterpretedFiles,
            changedFiles: stats.changedFiles,
            deletedFiles,
            diagnostics: graph.diagnostics,
            adapterStats,
          };
        }
      } catch (error) {
        if (!(error instanceof ContextMeshError && error.code === "PARSE_PARTIAL")) {
          const message = error instanceof Error ? error.message : String(error);
          this.database.failIndexRun(handle, [message]);
        }
        throw error;
      }

      await this.runtime.freshnessMutex.runExclusive(() => {
        const state = this.database.getFreshnessState();
        if (state.successFenceGeneration !== handle.generation) {
          this.runtime.baseline = null;
          return;
        }
        this.installBaselineFromProjectUnlocked(project, state);
      });
      return result;
    });
  }

  async reconcileSemantic(): Promise<void> {
    if (!this.semantic) return;
    await this.runtime.indexMutex.runExclusive(() => this.semantic!.reconcileCodeIfNeeded());
  }

  async readSnippet(
    node: CodeSearchResult,
    contextLines = 2,
  ): Promise<{ snippet: string | null; warning: string | null; staleReason: string | null }> {
    if (!node.relativePath || !node.fileContentHash) {
      return { snippet: null, warning: null, staleReason: null };
    }
    const absolutePath = path.resolve(this.rootPath, node.relativePath);
    if (!isPathInside(this.rootPath, absolutePath)) {
      const warning = `Refused to read a path outside the workspace: ${node.relativePath}`;
      return { snippet: null, warning, staleReason: warning };
    }
    let descriptor: Awaited<ReturnType<typeof open>> | null = null;
    try {
      const linkStatus = await lstat(absolutePath);
      if (linkStatus.isSymbolicLink()) {
        const warning = `Refused to read symbolic link: ${node.relativePath}`;
        return { snippet: null, warning, staleReason: warning };
      }
      const realRoot = await realpath(this.rootPath);
      const realFile = await realpath(absolutePath);
      if (!isPathInside(realRoot, realFile)) {
        const warning = `Refused to read a path outside the workspace: ${node.relativePath}`;
        return { snippet: null, warning, staleReason: warning };
      }
      descriptor = await open(realFile, "r");
      const before = await descriptor.stat();
      const bytes = await descriptor.readFile();
      const after = await descriptor.stat();
      const pathAfter = await lstat(absolutePath);
      const realAfter = await realpath(absolutePath);
      const identityAvailable = before.dev !== 0 || before.ino !== 0;
      const identityChanged =
        identityAvailable && (before.dev !== after.dev || before.ino !== after.ino);
      const pathIdentityChanged =
        identityAvailable && (after.dev !== pathAfter.dev || after.ino !== pathAfter.ino);
      if (
        pathAfter.isSymbolicLink() ||
        !isPathInside(realRoot, realAfter) ||
        realAfter !== realFile ||
        identityChanged ||
        pathIdentityChanged ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        bytes.byteLength !== after.size
      ) {
        const warning = `File changed while reading ${node.relativePath}`;
        return { snippet: null, warning, staleReason: warning };
      }
      if (sha256(bytes) !== node.fileContentHash) {
        const warning = `Index is stale for ${node.relativePath}`;
        return { snippet: null, warning, staleReason: warning };
      }
      const content = bytes.toString("utf8");
      const lines = content.split(/\r?\n/);
      const first = Math.max(0, node.startLine - 1 - contextLines);
      const last = Math.min(lines.length, node.endLine + contextLines);
      return {
        snippet: clampText(lines.slice(first, last).join("\n"), 4000),
        warning: null,
        staleReason: null,
      };
    } catch (error) {
      const warning = `Cannot read ${node.relativePath}: ${error instanceof Error ? error.message : String(error)}`;
      return {
        snippet: null,
        warning,
        staleReason: warning,
      };
    } finally {
      if (descriptor !== null) await descriptor.close();
    }
  }

  private readFinalRequestStateUnlocked(): RequestGenerationState {
    const state = this.database.getFreshnessState();
    return {
      generation: state.currentGeneration,
      successFence: state.successFenceGeneration,
      stale: state.stale,
    };
  }

  private recordStaleUnlocked(
    reason: string,
    expectedGeneration?: number,
    expectedSuccessFence?: number,
  ): boolean {
    return this.database.recordFreshnessStale(reason, expectedGeneration, expectedSuccessFence);
  }

  private async checkFreshnessUnlocked(mode: FreshnessMode): Promise<RequestGenerationState> {
    const state = this.database.getFreshnessState();
    if (state.currentGeneration === 0) {
      this.runtime.baseline = null;
      return { generation: 0, successFence: state.successFenceGeneration, stale: false };
    }
    if (mode === "fast" && state.stale) return this.requestState(state);

    const baseline = this.runtime.baseline;
    if (
      mode === "strict" ||
      !baseline ||
      baseline.generation !== state.currentGeneration ||
      baseline.successFence !== state.successFenceGeneration
    ) {
      return this.runStrictCheckUnlocked(state, 0);
    }
    return this.runFastCheckUnlocked(state, baseline);
  }

  private requestState(state: FreshnessState, forceStale = false): RequestGenerationState {
    return {
      generation: state.currentGeneration,
      successFence: state.successFenceGeneration,
      stale: state.stale || forceStale,
    };
  }

  private runStrictCheckUnlocked(stateAtStart: FreshnessState, casAttempt: number): RequestGenerationState {
    const project = this.loadProject();
    this.database.recordStrictCheck(new Date().toISOString());
    if (project.compiler.fatalDiagnostics.length > 0) {
      const recorded = this.recordStaleUnlocked(
        `Project configuration is invalid: ${project.compiler.fatalDiagnostics.join("; ")}`,
        stateAtStart.currentGeneration,
        stateAtStart.successFenceGeneration,
      );
      if (!recorded) return this.retryStrictAfterChurnUnlocked(casAttempt);
      return this.requestState(this.database.getFreshnessState());
    }

    const indexed = new Map(
      this.database.getIndexedFileBaseline().map((file) => [file.pathKey, file]),
    );
    const strictMismatch =
      indexed.size !== project.files.length ||
      project.files.some((file) => indexed.get(file.pathKey)?.contentHash !== file.contentHash) ||
      this.database.getIndexConfigHash() !== project.configHash;
    if (strictMismatch) {
      const recorded = this.recordStaleUnlocked(
        "Strict freshness verification found workspace changes",
        stateAtStart.currentGeneration,
        stateAtStart.successFenceGeneration,
      );
      if (!recorded) return this.retryStrictAfterChurnUnlocked(casAttempt);
      return this.requestState(this.database.getFreshnessState());
    }

    const stateBeforeInstall = this.database.getFreshnessState();
    if (
      stateBeforeInstall.currentGeneration !== stateAtStart.currentGeneration ||
      stateBeforeInstall.successFenceGeneration !== stateAtStart.successFenceGeneration
    ) {
      if (casAttempt === 0) return this.runStrictCheckUnlocked(stateBeforeInstall, 1);
      this.runtime.baseline = null;
      return this.requestState(stateBeforeInstall, true);
    }
    if (!stateBeforeInstall.stale) this.installBaselineFromProjectUnlocked(project, stateBeforeInstall);
    return this.requestState(stateBeforeInstall);
  }

  private retryStrictAfterChurnUnlocked(casAttempt: number): RequestGenerationState {
    const current = this.database.getFreshnessState();
    if (casAttempt === 0) return this.runStrictCheckUnlocked(current, 1);
    this.runtime.baseline = null;
    return this.requestState(current, true);
  }

  private runFastCheckUnlocked(
    stateAtStart: FreshnessState,
    baseline: ProcessBaseline,
  ): RequestGenerationState {
    const project = this.loadMetadataProject();
    if (project.compiler.fatalDiagnostics.length > 0) {
      const recorded = this.recordStaleUnlocked(
        `Project configuration is invalid: ${project.compiler.fatalDiagnostics.join("; ")}`,
        stateAtStart.currentGeneration,
        stateAtStart.successFenceGeneration,
      );
      if (!recorded) return this.runStrictCheckUnlocked(this.database.getFreshnessState(), 0);
      return this.requestState(this.database.getFreshnessState());
    }
    if (project.configHash !== baseline.configHash) {
      const recorded = this.recordStaleUnlocked(
        "Project configuration changed",
        stateAtStart.currentGeneration,
        stateAtStart.successFenceGeneration,
      );
      if (!recorded) return this.runStrictCheckUnlocked(this.database.getFreshnessState(), 0);
      return this.requestState(this.database.getFreshnessState());
    }

    const candidateFiles = new Map(
      project.files.map((file) => [file.pathKey, { sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs }]),
    );
    if (
      candidateFiles.size !== baseline.files.size ||
      [...candidateFiles.keys()].some((key) => !baseline.files.has(key))
    ) {
      const recorded = this.recordStaleUnlocked(
        "Configured source file set changed",
        stateAtStart.currentGeneration,
        stateAtStart.successFenceGeneration,
      );
      if (!recorded) return this.runStrictCheckUnlocked(this.database.getFreshnessState(), 0);
      return this.requestState(this.database.getFreshnessState());
    }

    const indexed = new Map(
      this.database.getIndexedFileBaseline().map((file) => [file.pathKey, file]),
    );
    for (const file of project.files) {
      const previous = baseline.files.get(file.pathKey);
      if (previous?.sizeBytes === file.sizeBytes && previous.mtimeMs === file.mtimeMs) continue;
      try {
        const hydrated = hydrateScannedFile(file, this.rootPath);
        if (indexed.get(file.pathKey)?.contentHash !== hydrated.contentHash) {
          const recorded = this.recordStaleUnlocked(
            `Source file changed: ${file.relativePath}`,
            stateAtStart.currentGeneration,
            stateAtStart.successFenceGeneration,
          );
          if (!recorded) return this.runStrictCheckUnlocked(this.database.getFreshnessState(), 0);
          return this.requestState(this.database.getFreshnessState());
        }
        candidateFiles.set(file.pathKey, {
          sizeBytes: hydrated.sizeBytes,
          mtimeMs: file.mtimeMs,
        });
      } catch (error) {
        const recorded = this.recordStaleUnlocked(
          `Cannot verify ${file.relativePath}: ${error instanceof Error ? error.message : String(error)}`,
          stateAtStart.currentGeneration,
          stateAtStart.successFenceGeneration,
        );
        if (!recorded) return this.runStrictCheckUnlocked(this.database.getFreshnessState(), 0);
        return this.requestState(this.database.getFreshnessState());
      }
    }

    const stateBeforeInstall = this.database.getFreshnessState();
    if (
      stateBeforeInstall.currentGeneration !== stateAtStart.currentGeneration ||
      stateBeforeInstall.successFenceGeneration !== stateAtStart.successFenceGeneration
    ) {
      return this.runStrictCheckUnlocked(stateBeforeInstall, 0);
    }
    this.runtime.baseline = {
      generation: stateBeforeInstall.currentGeneration,
      successFence: stateBeforeInstall.successFenceGeneration,
      configHash: project.configHash,
      files: candidateFiles,
    };
    return this.requestState(stateBeforeInstall);
  }

  private installBaselineFromProjectUnlocked(project: ProjectScan, state: FreshnessState): void {
    this.runtime.baseline = {
      generation: state.currentGeneration,
      successFence: state.successFenceGeneration,
      configHash: project.configHash,
      files: new Map(
        project.files.map((file) => [
          file.pathKey,
          { sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs },
        ]),
      ),
    };
  }

  private loadMetadataProject(): MetadataProjectScan {
    const scan = scanWorkspaceMetadata(this.rootPath, this.caseSensitivePaths);
    const typescriptFiles = scan.files.filter((file) => file.language !== "python");
    const compiler = this.compilerConfiguration(typescriptFiles);
    const pythonProject = new PythonLanguageAdapter().discoverProject(this.rootPath);
    const configHash = sha256(JSON.stringify({ typescript: compiler.configHash, python: pythonProject.configHash }));
    const files = compiler.hasConfig
      ? scan.files.filter((file) => file.language === "python" ||
          compiler.configuredFileNames.has(normalizePathKey(file.absolutePath, this.caseSensitivePaths)))
      : scan.files;
    return { scan, files, compiler, pythonProject, configHash };
  }

  private loadProject(): ProjectScan {
    const metadata = this.loadMetadataProject();
    const files: ScannedFile[] = [];
    const diagnostics = [...metadata.scan.diagnostics];
    for (const file of metadata.files) {
      try {
        files.push(hydrateScannedFile(file, this.rootPath));
      } catch (error) {
        diagnostics.push(
          `Cannot read file ${file.relativePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return {
      scan: { files, diagnostics },
      files,
      compiler: metadata.compiler,
      pythonProject: metadata.pythonProject,
      configHash: metadata.configHash,
    };
  }

  private compilerConfiguration(scannedFiles: ScannedFileMetadata[]): CompilerConfiguration {
    const diagnostics: string[] = [];
    const fatalDiagnostics: string[] = [];
    const configPath = ["tsconfig.json", "jsconfig.json"]
      .map((name) => path.join(this.rootPath, name))
      .find((candidate) => ts.sys.fileExists(candidate));
    let options: ts.CompilerOptions = {
      allowJs: true,
      checkJs: false,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      jsx: ts.JsxEmit.Preserve,
    };
    let configuredFileNames = scannedFiles.map((file) =>
      normalizePathKey(file.absolutePath, this.caseSensitivePaths),
    );
    const configContents = new Map<string, string>();
    const trackedReadFile = (fileName: string): string | undefined => {
      const content = ts.sys.readFile(fileName);
      if (content !== undefined && fileName.toLocaleLowerCase("en-US").endsWith(".json")) {
        configContents.set(normalizePathKey(fileName, this.caseSensitivePaths), content);
      }
      return content;
    };
    if (configPath) {
      const typescriptConfigPath = configPath.replaceAll("\\", "/");
      const config = ts.readConfigFile(typescriptConfigPath, trackedReadFile);
      if (config.error) {
        const message = diagnosticText(config.error);
        diagnostics.push(message);
        fatalDiagnostics.push(message);
        configuredFileNames = [];
      } else {
        const parseHost: ts.ParseConfigHost = {
          useCaseSensitiveFileNames: this.caseSensitivePaths,
          fileExists: ts.sys.fileExists,
          readFile: trackedReadFile,
          readDirectory: ts.sys.readDirectory,
        };
        const parsed = ts.parseJsonConfigFileContent(
          config.config,
          parseHost,
          this.rootPath,
          { allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true },
          typescriptConfigPath,
        );
        for (const diagnostic of parsed.errors) {
          const message = diagnosticText(diagnostic);
          diagnostics.push(message);
          if (
            diagnostic.category === ts.DiagnosticCategory.Error &&
            diagnostic.code !== 18002 &&
            diagnostic.code !== 18003
          ) {
            fatalDiagnostics.push(message);
          }
        }
        options = {
          ...parsed.options,
          allowJs: true,
          checkJs: false,
          noEmit: true,
          skipLibCheck: true,
        };
        configuredFileNames = parsed.fileNames.map((fileName) =>
          normalizePathKey(path.resolve(fileName), this.caseSensitivePaths),
        );
      }
    }
    const packageJsonPath = path.join(this.rootPath, "package.json");
    let packageJson = "";
    try {
      packageJson = readFileSync(packageJsonPath, "utf8");
    } catch {
      // package.json is optional for a synthetic project.
    }
    configuredFileNames = [...new Set(configuredFileNames)].sort();
    const configFiles = [...configContents.entries()]
      .map(([fileName, content]) => ({ fileName, contentHash: sha256(content) }))
      .sort((left, right) => left.fileName.localeCompare(right.fileName));
    const configHash = sha256(
      JSON.stringify({
        typescriptVersion: ts.version,
        configPath: configPath ? normalizePathKey(configPath, this.caseSensitivePaths) : null,
        configuredFileNames,
        effectiveCompilerOptions: canonicalizeCompilerValue(options, this.caseSensitivePaths),
        configFiles,
        packageJsonHash: sha256(packageJson),
      }),
    );
    return {
      options,
      diagnostics,
      fatalDiagnostics,
      configHash,
      hasConfig: configPath !== undefined,
      configuredFileNames: new Set(configuredFileNames),
    };
  }

  private extractTypeScriptSyntax(
    workspace: WorkspaceRecord,
    scannedFiles: ScannedFile[],
    generation: number,
    runtime: TypeScriptProviderRuntime,
  ): ExtractedGraph {
    const { diagnostics: scanDiagnostics, compiler } = runtime;
    const scannedByPath = new Map(
      scannedFiles.map((file) => [
        normalizePathKey(file.absolutePath, this.caseSensitivePaths),
        file,
      ]),
    );
    const compilerHost = ts.createCompilerHost(compiler.options, true);
    const defaultGetSourceFile = compilerHost.getSourceFile.bind(compilerHost);
    const defaultReadFile = compilerHost.readFile.bind(compilerHost);
    const defaultFileExists = compilerHost.fileExists.bind(compilerHost);
    compilerHost.fileExists = (fileName): boolean =>
      scannedByPath.has(normalizePathKey(fileName, this.caseSensitivePaths)) ||
      defaultFileExists(fileName);
    compilerHost.readFile = (fileName): string | undefined =>
      scannedByPath.get(normalizePathKey(fileName, this.caseSensitivePaths))?.content ??
      defaultReadFile(fileName);
    compilerHost.getSourceFile = (
      fileName,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    ): ts.SourceFile | undefined => {
      const scanned = scannedByPath.get(normalizePathKey(fileName, this.caseSensitivePaths));
      if (scanned) {
        return ts.createSourceFile(
          fileName,
          scanned.content,
          languageVersion,
          true,
          scriptKindFor(fileName),
        );
      }
      return defaultGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    };
    const program = ts.createProgram({
      rootNames: scannedFiles.map((file) => file.absolutePath),
      options: compiler.options,
      host: compilerHost,
    });
    this.lastTypeScriptInstrumentation = { programCreations: 1, syntaxWorkItems: 0, precisionWorkItems: 0 };
    const diagnostics = [...scanDiagnostics, ...compiler.diagnostics];
    const filesByPath = new Map<string, IndexedSourceFile>();
    const moduleByPath = new Map<string, string>();
    const nodes = new Map<string, CodeNodeRecord>();
    const edges = new Map<string, CodeEdgeRecord>();
    const unresolved = new Map<string, UnresolvedReferenceRecord>();

    for (const scanned of scannedFiles) {
      const sourceFile = program.getSourceFile(scanned.absolutePath);
      const fileDiagnostics = sourceFile ? program.getSyntacticDiagnostics(sourceFile) : [];
      diagnostics.push(...fileDiagnostics.map(diagnosticText));
      const fileId = sha256(`${workspace.id}\0${scanned.pathKey}`);
      const file: IndexedSourceFile = {
        id: fileId,
        workspaceId: workspace.id,
        relativePath: scanned.relativePath,
        pathKey: scanned.pathKey,
        absolutePath: scanned.absolutePath,
        language: scanned.language,
        content: scanned.content,
        contentHash: scanned.contentHash,
        sizeBytes: scanned.sizeBytes,
        mtimeMs: scanned.mtimeMs,
        parseStatus: sourceFile ? (fileDiagnostics.length > 0 ? "partial" : "ok") : "error",
        diagnosticCount: fileDiagnostics.length,
        generation,
      };
      filesByPath.set(normalizePathKey(scanned.absolutePath, this.caseSensitivePaths), file);
      const localKey = `${scanned.pathKey}:module`;
      const moduleId = sha256(`${workspace.id}\0${localKey}`);
      moduleByPath.set(normalizePathKey(scanned.absolutePath, this.caseSensitivePaths), moduleId);
      nodes.set(moduleId, {
        id: moduleId,
        workspaceId: workspace.id,
        fileId,
        kind: "module",
        name: path.basename(scanned.relativePath),
        qualifiedName: scanned.relativePath,
        localKey,
        signature: `module ${scanned.relativePath}`,
        doc: "",
        isExported: false,
        startByte: 0,
        endByte: Buffer.byteLength(scanned.content, "utf8"),
        startLine: 1,
        startColumn: 1,
        endLine: scanned.content.split(/\r?\n/).length,
        endColumn: 1,
        contentHash: scanned.contentHash,
        generation,
        metadata: { language: scanned.language },
      });
    }

    const state: ExtractionState = {
      workspace,
      generation,
      compilerOptions: compiler.options,
      checker: null,
      filesByPath,
      moduleByPath,
      nodes,
      edges,
      unresolved,
      declarationNodes: new Map(),
      symbolNodes: new Map(),
      caseSensitivePaths: this.caseSensitivePaths,
    };

    for (const sourceFile of program.getSourceFiles()) {
      const file = filesByPath.get(normalizePathKey(sourceFile.fileName, this.caseSensitivePaths));
      const moduleId = moduleByPath.get(normalizePathKey(sourceFile.fileName, this.caseSensitivePaths));
      if (!file || !moduleId) continue;
      this.extractDeclarations(state, sourceFile, file, moduleId);
      this.lastTypeScriptInstrumentation.syntaxWorkItems += 1;
    }
    for (const sourceFile of program.getSourceFiles()) {
      const file = filesByPath.get(normalizePathKey(sourceFile.fileName, this.caseSensitivePaths));
      const moduleId = moduleByPath.get(normalizePathKey(sourceFile.fileName, this.caseSensitivePaths));
      if (!file || !moduleId) continue;
      this.extractSyntaxRelationships(state, sourceFile, file, moduleId);
    }
    runtime.context = { program, state, programCreations: 1 };

    return {
      files: [...filesByPath.values()],
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      unresolvedReferences: [...unresolved.values()],
      diagnostics,
    };
  }

  private refineTypeScript(batch: ExtractedGraph, runtime: TypeScriptProviderRuntime): Promise<ExtractedGraph> {
    const context = runtime.context;
    if (!context) throw new Error("TypeScript precision provider requires a syntax batch from the shared Program");
    const { program, state } = context;
    state.checker = program.getTypeChecker();
    for (const sourceFile of program.getSourceFiles()) {
      const file = state.filesByPath.get(normalizePathKey(sourceFile.fileName, this.caseSensitivePaths));
      const moduleId = state.moduleByPath.get(normalizePathKey(sourceFile.fileName, this.caseSensitivePaths));
      if (!file || !moduleId) continue;
      this.enrichTypeScriptDeclarations(state, sourceFile, file);
      if (!runtime.relationshipScope || runtime.relationshipScope.has(file.pathKey)) {
        this.extractRelationships(state, sourceFile, file, moduleId);
      }
      this.lastTypeScriptInstrumentation.precisionWorkItems += 1;
    }
    if (runtime.relationshipScope) this.mergeExistingRelations(state, runtime.relationshipScope);
    for (const node of state.nodes.values()) node.analysisLevel = "typed";
    return Promise.resolve({
      ...batch,
      nodes: [...state.nodes.values()],
      edges: [...state.edges.values()],
      unresolvedReferences: [...state.unresolved.values()],
    });
  }

  private reuseStoredTypescriptGraph(
    workspace: WorkspaceRecord,
    scannedFiles: ScannedFile[],
    generation: number,
  ): ExtractedGraph {
    const stored = this.database.getStoredGraphPartition("non-python");
    const files: IndexedSourceFile[] = scannedFiles.map((scanned) => ({
      ...scanned,
      id: sha256(`${workspace.id}\0${scanned.pathKey}`),
      workspaceId: workspace.id,
      ecosystem: "npm",
      adapterConfigHash: this.database.getIndexConfigHash() ?? "",
      parseStatus: "ok",
      diagnosticCount: 0,
      generation,
    }));
    return {
      files,
      nodes: stored.nodes.map((node) => ({ ...node, generation })),
      edges: stored.edges.map((edge) => ({ ...edge, generation })),
      unresolvedReferences: stored.unresolvedReferences.map((item) => ({ ...item, generation })),
      diagnostics: [],
    };
  }

  private mergeExistingRelations(state: ExtractionState, relationshipScope: Set<string>): void {
    const existing = this.database.getExistingRelations();
    for (const node of existing.externalNodes) {
      if (!state.nodes.has(node.id)) state.nodes.set(node.id, { ...node, generation: state.generation });
    }
    for (const relation of existing.edges) {
      if (relation.sourcePathKey && relationshipScope.has(relation.sourcePathKey)) continue;
      if (!state.nodes.has(relation.edge.sourceId) || !state.nodes.has(relation.edge.targetId)) continue;
      const edge = { ...relation.edge, generation: state.generation };
      state.edges.set(edgeKey(edge), edge);
    }
    for (const relation of existing.unresolved) {
      if (relationshipScope.has(relation.filePathKey)) continue;
      if (
        !state.filesByPath.has(
          normalizePathKey(path.join(this.rootPath, relation.filePathKey), this.caseSensitivePaths),
        )
      ) {
        continue;
      }
      if (relation.reference.sourceNodeId && !state.nodes.has(relation.reference.sourceNodeId)) continue;
      const reference = { ...relation.reference, generation: state.generation };
      state.unresolved.set(unresolvedKey(reference), reference);
    }

    const referencedNodes = new Set<string>();
    for (const edge of state.edges.values()) {
      referencedNodes.add(edge.sourceId);
      referencedNodes.add(edge.targetId);
    }
    for (const node of [...state.nodes.values()]) {
      if (node.fileId === null && !referencedNodes.has(node.id)) state.nodes.delete(node.id);
    }
  }

  private extractDeclarations(
    state: ExtractionState,
    sourceFile: ts.SourceFile,
    file: IndexedSourceFile,
    moduleId: string,
  ): void {
    const visit = (
      node: ts.Node,
      containerId: string,
      containerNames: string[],
      containerKind: CodeNodeKind,
    ): void => {
      const descriptor = describeDeclaration(node, sourceFile, containerKind);
      let childContainerId = containerId;
      let childContainerNames = containerNames;
      let childContainerKind = containerKind;
      if (descriptor) {
        const symbolPath = [...containerNames, descriptor.name].join(".");
        const qualifiedName = `${file.relativePath}#${symbolPath}`;
        const localKey = `${file.pathKey}:${descriptor.kind}:${symbolPath}`;
        const id = sha256(`${state.workspace.id}\0${localKey}`);
        const start = node.getStart(sourceFile);
        const end = node.getEnd();
        const startLocation = sourceFile.getLineAndCharacterOfPosition(start);
        const endLocation = sourceFile.getLineAndCharacterOfPosition(end);
        const existing = state.nodes.get(id);
        const record: CodeNodeRecord = {
          id,
          workspaceId: state.workspace.id,
          fileId: file.id,
          kind: descriptor.kind,
          name: descriptor.name,
          qualifiedName,
          localKey,
          signature: declarationSyntaxSignature(node, sourceFile),
          doc: "",
          isExported: hasExportModifier(node),
          startByte: Buffer.byteLength(sourceFile.text.slice(0, start), "utf8"),
          endByte: Buffer.byteLength(sourceFile.text.slice(0, end), "utf8"),
          startLine: startLocation.line + 1,
          startColumn: startLocation.character + 1,
          endLine: endLocation.line + 1,
          endColumn: endLocation.character + 1,
          contentHash: sha256(node.getText(sourceFile)),
          generation: state.generation,
          metadata: { syntaxKind: ts.SyntaxKind[node.kind] },
        };
        if (!existing || (!existing.signature.includes("{") && Boolean((node as ts.FunctionLikeDeclaration).body))) {
          state.nodes.set(id, record);
        }
        state.declarationNodes.set(node, id);
        if (ts.isVariableDeclaration(node) && node.initializer) state.declarationNodes.set(node.initializer, id);
        addEdge(state, containerId, id, "CONTAINS");
        if (record.isExported) addEdge(state, moduleId, id, "EXPORTS");
        childContainerId = id;
        childContainerNames = [...containerNames, descriptor.name];
        childContainerKind = descriptor.kind;
      }
      ts.forEachChild(node, (child) => visit(child, childContainerId, childContainerNames, childContainerKind));
    };
    visit(sourceFile, moduleId, [], "module");
  }

  private enrichTypeScriptDeclarations(
    state: ExtractionState,
    sourceFile: ts.SourceFile,
    file: IndexedSourceFile,
  ): void {
    const checker = state.checker;
    if (!checker) throw new Error("TypeScript precision provider has no TypeChecker");
    const visit = (node: ts.Node, containerNames: string[], containerKind: CodeNodeKind): void => {
      const descriptor = describeDeclaration(node, sourceFile, containerKind);
      let childNames = containerNames;
      let childKind = containerKind;
      if (descriptor) {
        const symbolPath = [...containerNames, descriptor.name].join(".");
        const id = sha256(`${state.workspace.id}\0${file.pathKey}:${descriptor.kind}:${symbolPath}`);
        const record = state.nodes.get(id);
        if (record) {
          record.signature = declarationSignature(node, descriptor, sourceFile, checker);
          record.doc = declarationDoc(descriptor, checker);
        }
        state.declarationNodes.set(node, id);
        if (ts.isVariableDeclaration(node) && node.initializer) state.declarationNodes.set(node.initializer, id);
        if (descriptor.nameNode) {
          const symbol = checker.getSymbolAtLocation(descriptor.nameNode);
          if (symbol) state.symbolNodes.set(symbol, id);
        }
        childNames = [...containerNames, descriptor.name];
        childKind = descriptor.kind;
      }
      ts.forEachChild(node, (child) => visit(child, childNames, childKind));
    };
    visit(sourceFile, [], "module");
  }

  private externalModule(state: ExtractionState, specifier: string): string {
    const canonical = specifier.toLocaleLowerCase("en-US");
    const localKey = `external:npm:${canonical}`;
    const id = sha256(`${state.workspace.id}\0${localKey}`);
    if (!state.nodes.has(id)) {
      state.nodes.set(id, {
        id,
        workspaceId: state.workspace.id,
        fileId: null,
        kind: "external_module",
        name: specifier,
        qualifiedName: specifier,
        localKey,
        signature: `external module ${specifier}`,
        doc: "",
        isExported: true,
        startByte: 0,
        endByte: 0,
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 1,
        contentHash: sha256(specifier),
        generation: state.generation,
        metadata: { legacyAlias: `external:${canonical}` },
      });
    }
    return id;
  }

  private moduleTarget(state: ExtractionState, sourceFile: ts.SourceFile, specifier: string): string {
    const resolved = ts.resolveModuleName(specifier, sourceFile.fileName, state.compilerOptions, ts.sys).resolvedModule;
    if (resolved) {
      const local = state.moduleByPath.get(
        normalizePathKey(resolved.resolvedFileName, this.caseSensitivePaths),
      );
      if (local) return local;
    }
    return this.externalModule(state, specifier);
  }

  private extractSyntaxRelationships(
    state: ExtractionState,
    sourceFile: ts.SourceFile,
    file: IndexedSourceFile,
    moduleId: string,
  ): void {
    const recordUnresolved = (node: ts.Node, kind: string, rawName: string, qualifier: string | null): void => {
      const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const confidence = 0.5;
      const reference: UnresolvedReferenceRecord = {
        workspaceId: state.workspace.id, fileId: file.id, sourceNodeId: moduleId, kind,
        rawName: clampText(rawName, 200), qualifier, line: location.line + 1, column: location.character + 1,
        candidates: [], generation: state.generation, confidence,
        evidence: [{ provider: "typescript_compiler_ast", providerVersion: ts.version, source: "syntax", confidence }],
      };
      state.unresolved.set(unresolvedKey(reference), reference);
    };
    const importSpecifier = (expression: ts.Expression): void => {
      if (!ts.isStringLiteralLike(expression)) {
        recordUnresolved(expression, "IMPORTS", expression.getText(sourceFile), null);
        return;
      }
      const target = this.moduleTarget(state, sourceFile, expression.text);
      addEdge(state, moduleId, target, "IMPORTS", target === moduleId ? "local" : "import", 0.95, { specifier: expression.text }, "syntax");
    };
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) importSpecifier(statement.moduleSpecifier);
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) importSpecifier(statement.moduleSpecifier);
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const requireCall = ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1;
        const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1;
        if ((requireCall || dynamicImport) && node.arguments[0]) importSpecifier(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  private extractRelationships(
    state: ExtractionState,
    sourceFile: ts.SourceFile,
    file: IndexedSourceFile,
    moduleId: string,
  ): void {
    const checker = state.checker;
    if (!checker) throw new Error("TypeScript precision provider has no TypeChecker");
    const recordUnresolved = (
      node: ts.Node,
      callerId: string,
      kind: string,
      rawName: string,
      qualifier: string | null,
      candidates: string[] = [],
    ): void => {
      const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const confidence = 0.5;
      const reference: UnresolvedReferenceRecord = {
        workspaceId: state.workspace.id,
        fileId: file.id,
        sourceNodeId: callerId,
        kind,
        rawName: clampText(rawName, 200),
        qualifier: qualifier ? clampText(qualifier, 200) : null,
        line: location.line + 1,
        column: location.character + 1,
        candidates,
        generation: state.generation,
        confidence,
        evidence: [{ provider: "typescript_type_checker", providerVersion: ts.version, source: "type_checker", confidence }],
      };
      state.unresolved.set(unresolvedKey(reference), reference);
    };

    for (const statement of sourceFile.statements) {
      if (ts.isExportDeclaration(statement)) {
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            const symbol = checker.getSymbolAtLocation(element.name);
            const target = resolveSymbolNode(state, symbol);
            if (target) {
              addEdge(state, moduleId, target, "EXPORTS", "exact", 1, {}, "type_checker");
              const node = state.nodes.get(target);
              if (node) node.isExported = true;
            }
          }
        }
      }
      if (ts.isExportAssignment(statement)) {
        const target = resolveSymbolNode(state, checker.getSymbolAtLocation(statement.expression));
        if (target) addEdge(state, moduleId, target, "EXPORTS", "exact", 1, {}, "type_checker");
      }
    }

    const visit = (node: ts.Node, callerId: string): void => {
      const declarationId = state.declarationNodes.get(node);
      const activeCaller = declarationId ?? callerId;

      if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          const kind: CodeEdgeKind = clause.token === ts.SyntaxKind.ImplementsKeyword ? "IMPLEMENTS" : "EXTENDS";
          for (const type of clause.types) {
            const symbol = checker.getSymbolAtLocation(type.expression);
            const target = resolveSymbolNode(state, symbol);
            if (target) addEdge(state, activeCaller, target, kind, "exact", 1, {}, "type_checker");
            else if (!symbol || symbolBelongsToWorkspace(state, symbol)) {
              recordUnresolved(
                type.expression,
                activeCaller,
                kind,
                type.expression.getText(sourceFile),
                null,
                symbol ? [symbol.getName()] : [],
              );
            }
          }
        }
      }

      if (ts.isCallExpression(node)) {
        const isRequire =
          ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1;
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1;
        if (!(isRequire || isDynamicImport)) {
          const symbol = checker.getSymbolAtLocation(node.expression);
          const target = resolveSymbolNode(state, symbol);
          if (target) {
            const targetNode = state.nodes.get(target);
            addEdge(
              state,
              activeCaller,
              target,
              "CALLS",
              targetNode?.fileId === file.id ? "local" : "import",
              1,
              {},
              "type_checker",
            );
          } else if (
            !symbol ||
            ts.isElementAccessExpression(node.expression) ||
            (ts.isIdentifier(node.expression) && symbolBelongsToWorkspace(state, symbol))
          ) {
            const qualifier = ts.isPropertyAccessExpression(node.expression)
              ? node.expression.expression.getText(sourceFile)
              : null;
            recordUnresolved(
              node.expression,
              activeCaller,
              "CALLS",
              node.expression.getText(sourceFile),
              qualifier,
              symbol ? [symbol.getName()] : [],
            );
          }
        }
      }

      if (ts.isNewExpression(node)) {
        const symbol = checker.getSymbolAtLocation(node.expression);
        const target = resolveSymbolNode(state, symbol);
        if (target) addEdge(state, activeCaller, target, "CALLS", "exact", 1, {}, "type_checker");
        else if (!symbol || symbolBelongsToWorkspace(state, symbol)) {
          recordUnresolved(
            node.expression,
            activeCaller,
            "CALLS",
            node.expression.getText(sourceFile),
            null,
            symbol ? [symbol.getName()] : [],
          );
        }
      }
      ts.forEachChild(node, (child) => visit(child, activeCaller));
    };
    visit(sourceFile, moduleId);
  }
}
