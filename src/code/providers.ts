import type {
  AdapterStats,
  CodeEdgeRecord,
  CodeNodeRecord,
  ExtractedGraph,
  IndexedSourceFile,
  UnresolvedReferenceRecord,
  WorkspaceRecord,
  AnalysisLevel,
  EdgeStatus,
} from "../contracts.js";
import type { ScannedFile } from "./scanner.js";

export interface ProjectDescriptor {
  language: string;
  ecosystem: string;
  sourceRoots: string[];
  configHash: string;
  diagnostics: string[];
  runtime?: unknown;
}

export interface ProjectDiscoveryInput {
  sourceFiles?: Array<{ absolutePath: string }>;
  caseSensitivePaths?: boolean;
}

export interface LanguageInvalidationInput {
  currentFiles: ScannedFile[];
  changedPathKeys: readonly string[];
  deletedPathKeys: readonly string[];
  previousConfigHash: string | null;
  currentConfigHash: string;
}

export interface LanguageInvalidationPlan {
  reparseAll: boolean;
  invalidatedPathKeys: string[];
  reason: "configuration" | "source" | "unchanged";
}

export interface SyntaxGraphBatch {
  files: IndexedSourceFile[];
  nodes: CodeNodeRecord[];
  edges: CodeEdgeRecord[];
  unresolvedReferences: UnresolvedReferenceRecord[];
  diagnostics: string[];
  providerMetrics?: { filesParsed: number; mode: string; kernelRssBytes?: number; providerVersion?: string };
}

export interface SyntaxProvider {
  readonly id: string;
  readonly version: string;
  extract(input: {
    workspace: WorkspaceRecord;
    project: ProjectDescriptor;
    files: ScannedFile[];
    generation: number;
    mode?: "full" | "incremental" | "evaluation";
  }): Promise<SyntaxGraphBatch>;
}

export interface PrecisionProvider {
  readonly id: string;
  readonly version: string;
  refine(batch: SyntaxGraphBatch): Promise<SyntaxGraphBatch>;
}

export interface PrecisionOverlayEdge {
  sourceId: string;
  targetId: string;
  kind: CodeEdgeRecord["kind"];
  status: EdgeStatus;
  confidence: number;
  resolutionKind: CodeEdgeRecord["resolutionKind"];
  evidence: NonNullable<CodeEdgeRecord["evidence"]>;
}

export interface PrecisionOverlayBatch {
  language: string;
  provider: string;
  providerVersion: string;
  capability: Exclude<AnalysisLevel, "syntax">;
  baseGeneration: number;
  edges: PrecisionOverlayEdge[];
  eligibleEdges: number;
  diagnostics: string[];
  partial?: boolean;
}

export interface OverlayPrecisionProvider {
  readonly id: string;
  readonly version: string;
  readonly capability: Exclude<AnalysisLevel, "syntax">;
  available(): Promise<{ available: boolean; diagnostic?: string; unavailableStatus?: "not_configured" | "failed" }>;
  analyze(batch: SyntaxGraphBatch, baseGeneration: number): Promise<PrecisionOverlayBatch>;
}

export interface LanguageAdapter {
  readonly languageId: string;
  readonly ecosystem: string;
  readonly extensions: readonly string[];
  discoverProject(rootPath: string, input?: ProjectDiscoveryInput): ProjectDescriptor;
  planInvalidation?(input: LanguageInvalidationInput): LanguageInvalidationPlan;
  createSyntaxProvider(project: ProjectDescriptor): SyntaxProvider;
  createPrecisionProvider?(project: ProjectDescriptor): PrecisionProvider | undefined;
  createOverlayPrecisionProvider?(project: ProjectDescriptor): OverlayPrecisionProvider | undefined;
}

function evidenceKey(item: NonNullable<CodeEdgeRecord["evidence"]>[number]): string {
  return `${item.provider}\0${item.providerVersion}\0${item.source}\0${item.confidence}\0${JSON.stringify(item.sourceSpan ?? null)}\0${JSON.stringify(item.details ?? null)}`;
}

export function mergeEvidence(...groups: Array<CodeEdgeRecord["evidence"]>): NonNullable<CodeEdgeRecord["evidence"]> {
  const merged = new Map<string, NonNullable<CodeEdgeRecord["evidence"]>[number]>();
  for (const item of groups.flatMap((group) => group ?? [])) merged.set(evidenceKey(item), item);
  return [...merged.values()].sort((left, right) => evidenceKey(left).localeCompare(evidenceKey(right)));
}

export function mergeGraphBatches(
  batches: SyntaxGraphBatch[],
  adapterStats: AdapterStats[],
): ExtractedGraph {
  const edgeKey = (edge: CodeEdgeRecord): string =>
    `${edge.sourceId}\0${edge.targetId}\0${edge.kind}`;
  const unresolvedKey = (item: UnresolvedReferenceRecord): string =>
    `${item.fileId}\0${item.sourceNodeId ?? ""}\0${item.kind}\0${item.rawName}\0${item.line}\0${item.column}`;
  const files = new Map(batches.flatMap((batch) => batch.files.map((file) => [file.id, file])));
  const nodes = new Map(batches.flatMap((batch) => batch.nodes.map((node) => [node.id, node])));
  const edges = new Map(batches.flatMap((batch) => batch.edges.map((edge) => [edgeKey(edge), edge])));
  const unresolved = new Map(
    batches.flatMap((batch) => batch.unresolvedReferences.map((item) => [unresolvedKey(item), item])),
  );
  return {
    files: [...files.values()].sort((a, b) => a.pathKey.localeCompare(b.pathKey)),
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
    unresolvedReferences: [...unresolved.values()].sort((a, b) => unresolvedKey(a).localeCompare(unresolvedKey(b))),
    diagnostics: batches.flatMap((batch) => batch.diagnostics),
    adapterStats,
  };
}

export class GraphIndexCoordinator {
  private readonly adapters = new Map<string, LanguageAdapter>();

  register(adapter: LanguageAdapter): void {
    this.adapters.set(adapter.languageId, adapter);
  }

  adapter(language: string): LanguageAdapter | undefined {
    return this.adapters.get(language);
  }

  discoverProject(language: string, rootPath: string, input?: ProjectDiscoveryInput): ProjectDescriptor {
    const adapter = this.adapters.get(language);
    if (!adapter) throw new Error(`No language adapter registered for ${language}`);
    return adapter.discoverProject(rootPath, input);
  }

  capabilities(rootPath = process.cwd()): Array<{ language: string; ecosystem: string; extensions: readonly string[]; syntaxProvider: string; precisionProvider: string | null }> {
    return [...this.adapters.values()]
      .map((adapter) => {
        const project = adapter.discoverProject(rootPath);
        const overlay = adapter.createOverlayPrecisionProvider?.(project);
        return ({
        language: adapter.languageId,
        ecosystem: adapter.ecosystem,
        extensions: adapter.extensions,
        syntaxProvider: adapter.createSyntaxProvider(project).id,
        precisionProvider: overlay?.id ?? adapter.createPrecisionProvider?.(project)?.id ?? null,
      }); })
      .sort((a, b) => a.language.localeCompare(b.language));
  }
}
