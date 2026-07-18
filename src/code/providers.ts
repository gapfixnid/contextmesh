import type {
  AdapterStats,
  CodeEdgeRecord,
  CodeNodeRecord,
  ExtractedGraph,
  IndexedSourceFile,
  UnresolvedReferenceRecord,
  WorkspaceRecord,
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

export interface SyntaxGraphBatch {
  files: IndexedSourceFile[];
  nodes: CodeNodeRecord[];
  edges: CodeEdgeRecord[];
  unresolvedReferences: UnresolvedReferenceRecord[];
  diagnostics: string[];
  providerMetrics?: { filesParsed: number; mode: string; kernelRssBytes?: number };
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

export interface LanguageAdapter {
  readonly languageId: string;
  readonly ecosystem: string;
  readonly extensions: readonly string[];
  discoverProject(rootPath: string, input?: ProjectDiscoveryInput): ProjectDescriptor;
  createSyntaxProvider(project: ProjectDescriptor): SyntaxProvider;
  createPrecisionProvider?(project: ProjectDescriptor): PrecisionProvider;
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

  capabilities(): Array<{ language: string; ecosystem: string; extensions: readonly string[] }> {
    return [...this.adapters.values()]
      .map((adapter) => ({
        language: adapter.languageId,
        ecosystem: adapter.ecosystem,
        extensions: adapter.extensions,
      }))
      .sort((a, b) => a.language.localeCompare(b.language));
  }
}
