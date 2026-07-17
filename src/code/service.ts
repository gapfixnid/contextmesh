import type { CodeNodeKind, SearchCodeInput, TraceCodeInput } from "../contracts.js";
import type { ContextMeshStorage } from "../storage/database.js";
import { estimateTokens } from "../utils.js";
import { CodeIndexer, type IndexResult } from "./indexer.js";
import type { FreshnessMode, RequestGenerationState } from "./indexer.js";

export const INDEX_STALE_WARNING = "INDEX_STALE: serving the last committed generation";

export class CodeService {
  readonly indexer: CodeIndexer;
  private readonly database: ContextMeshStorage;

  constructor(database: ContextMeshStorage, freshnessMode: FreshnessMode = "fast") {
    this.database = database;
    this.indexer = new CodeIndexer(database, freshnessMode);
  }

  index(mode: "full" | "incremental"): Promise<IndexResult> {
    return this.indexer.index(mode);
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

  search(input: SearchCodeInput): {
    results: ReturnType<ContextMeshStorage["searchCode"]>;
    estimatedTokens: number;
    truncated: boolean;
    nextOffset: number | null;
  } {
    const page = this.database.searchCode(
      input.query,
      input.kinds as CodeNodeKind[] | undefined,
      input.limit + 1,
      input.offset,
    );
    const truncated = page.length > input.limit;
    const results = page.slice(0, input.limit);
    return {
      results,
      estimatedTokens: estimateTokens(results),
      truncated,
      nextOffset: truncated ? input.offset + input.limit : null,
    };
  }

  trace(input: TraceCodeInput): ReturnType<ContextMeshStorage["traceCode"]> {
    return this.database.traceCode(input.symbolId, input.direction, input.edgeKinds, input.depth, input.limit);
  }
}
