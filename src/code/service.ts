import type { SearchCodeInput, TraceCodeInput } from "../contracts.js";
import type { ContextMeshStorage } from "../storage/database.js";
import type { SemanticService } from "../semantic/service.js";
import type { SemanticSearchResult } from "../semantic/service.js";
import { hybridCodeSearch } from "../semantic/hybrid.js";
import { estimateTokens } from "../utils.js";
import { CodeIndexer, type IndexResult } from "./indexer.js";
import type { FreshnessMode, RequestGenerationState } from "./indexer.js";
import { GenerationGraphCache } from "./query-cache.js";

export const INDEX_STALE_WARNING = "INDEX_STALE: serving the last committed generation";

export class CodeService {
  readonly indexer: CodeIndexer;
  private readonly database: ContextMeshStorage;
  private readonly cache: GenerationGraphCache;

  constructor(
    database: ContextMeshStorage,
    freshnessMode: FreshnessMode = "fast",
    semantic: SemanticService | null = null,
  ) {
    this.database = database;
    this.indexer = new CodeIndexer(database, freshnessMode, semantic);
    this.cache = new GenerationGraphCache(database);
  }

  async index(mode: "full" | "incremental"): Promise<IndexResult> {
    try {
      const result = await this.indexer.index(mode);
      await this.database.withReadSnapshot(() => this.cache.hydrate());
      if (result.adapterStats.some((item) => item.language === "python")) {
        this.database.setOperationalStatus("graph_kernel", "ready");
      }
      return result;
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      if (/KERNEL_/.test(diagnostic)) this.database.setOperationalStatus("graph_kernel", "failed", diagnostic);
      throw error;
    }
  }

  recordOperationalFailure(diagnostic: string): void {
    this.database.setOperationalStatus(diagnostic.startsWith("WATCH_") ? "watcher" : "graph_kernel", "failed", diagnostic);
    this.database.recordFreshnessStale(diagnostic);
  }

  recordOperationalRecovery(component: "graph_kernel" | "watcher"): void {
    this.database.setOperationalStatus(component, "ready");
  }

  reconcileSemantic(): Promise<void> {
    return this.indexer.reconcileSemantic();
  }

  async status(): Promise<Record<string, unknown>> {
    const freshness = await this.indexer.checkFreshness();
    const durable = this.database.getFreshnessState();
    const runFenceReason =
      durable.failureFenceGeneration > durable.successFenceGeneration
        ? `Index run ${durable.failureFenceGeneration} is newer than success fence ${durable.successFenceGeneration}`
        : null;
    return {
      ...this.database.getStatus(),
      stale: freshness.stale,
      freshness: {
        mode: this.indexer.freshnessMode,
        latch: durable.freshnessStale,
        staleAt: durable.freshnessStaleAt,
        reasons: [
          ...durable.freshnessReasons,
          ...(runFenceReason ? [runFenceReason] : []),
        ],
        lastStrictCheckAt: durable.lastStrictCheckAt,
        latestSuccessFence: durable.successFenceGeneration,
        latestFailureFence: durable.failureFenceGeneration,
      },
    };
  }

  async freshnessState(): Promise<RequestGenerationState> {
    return this.indexer.checkFreshness();
  }

  async staleWarnings(): Promise<string[]> {
    return (await this.freshnessState()).stale ? [INDEX_STALE_WARNING] : [];
  }

  search(input: SearchCodeInput, semantic: SemanticSearchResult | null = null): {
    results: ReturnType<ContextMeshStorage["searchCode"]>;
    estimatedTokens: number;
    truncated: boolean;
    nextOffset: number | null;
  } {
    this.cache.hydrate();
    const hybrid = semantic
      ? hybridCodeSearch(this.database, input, semantic)
      : this.cache.search(JSON.stringify(input), () => hybridCodeSearch(this.database, input, null));
    const results = hybrid.results;
    return {
      results,
      estimatedTokens: estimateTokens(results),
      truncated: hybrid.truncated,
      nextOffset: hybrid.nextOffset,
    };
  }

  trace(input: TraceCodeInput): ReturnType<ContextMeshStorage["traceCode"]> {
    this.cache.hydrate();
    return this.cache.trace(JSON.stringify(input), () => this.cache.traceGraph(input.symbolId, input.direction, input.edgeKinds, input.depth, input.limit)
      ?? this.database.traceCode(input.symbolId, input.direction, input.edgeKinds, input.depth, input.limit));
  }

  cacheStats(): ReturnType<GenerationGraphCache["stats"]> { this.cache.hydrate(); return this.cache.stats(); }
}
