import type { GetContextInput, MemoryFragmentRecord } from "../contracts.js";
import { ContextMeshError } from "../errors.js";
import type {
  CodeSearchResult,
  ContextMeshStorage,
  MemoryCodeProvenance,
  TraceEdgeResult,
} from "../storage/database.js";
import type { CodeIndexer } from "../code/indexer.js";

export interface ContextCodeItem extends CodeSearchResult {
  snippet: string | null;
  source: "direct" | "search" | "graph";
}

export interface ContextMemoryItem extends MemoryFragmentRecord {
  source: "anchor" | "linked" | "search";
  untrusted: true;
  provenance: { sessionId: string | null; codeLinks: MemoryCodeProvenance[]; codeLinksOmitted: number };
}

export interface AssembledContext {
  query: string;
  candidates: ContextCandidate[];
  relationships: TraceEdgeResult[];
  candidateTruncated: boolean;
  warnings: string[];
}

export interface ContextCandidate {
  key: string;
  priority: number;
  order: number;
  kind: "code" | "memory";
  value: ContextCodeItem | ContextMemoryItem;
}

export class ContextAssembler {
  private readonly database: ContextMeshStorage;
  private readonly indexer: CodeIndexer;

  constructor(database: ContextMeshStorage, indexer: CodeIndexer) {
    this.database = database;
    this.indexer = indexer;
  }

  assembleDatabase(input: GetContextInput): AssembledContext {
    const includeCode = input.include.includes("code");
    const includeMemory = input.include.includes("memory");
    const warnings: string[] = [];
    const candidates: ContextCandidate[] = [];
    const codeById = new Map<string, ContextCodeItem>();
    const memoryById = new Map<string, ContextMemoryItem>();
    let relationships: TraceEdgeResult[] = [];
    let candidateTruncated = false;

    let searchResults: CodeSearchResult[] = [];
    let traceStartId: string | undefined = input.symbolId;
    if (includeCode) {
      searchResults = this.database.searchCode(input.query, undefined, 20);
      traceStartId ??= searchResults[0]?.id;
      for (const node of searchResults) {
        const item: ContextCodeItem = {
          ...node,
          snippet: null,
          source: node.id === input.symbolId ? "direct" : "search",
        };
        codeById.set(node.id, item);
      }
      if (traceStartId) {
        const trace = this.database.traceCode(traceStartId, "both", undefined, 1, 50);
        relationships = trace.edges;
        for (const node of trace.nodes) {
          if (codeById.has(node.id)) continue;
          codeById.set(node.id, {
            ...node,
            snippet: null,
            source: node.id === input.symbolId ? "direct" : "graph",
          });
        }
        if (trace.unresolved.length > 0) {
          warnings.push(`${trace.unresolved.length} unresolved code reference(s) were encountered near the selected symbol`);
        }
      } else if (input.symbolId) {
        throw new ContextMeshError("NOT_FOUND", `Code symbol not found: ${input.symbolId}`);
      }
    }

    if (includeMemory) {
      const linkedNodeIds = [...codeById.keys()];
      if (!includeCode && input.symbolId) {
        const directNode = this.database.getCodeNode(input.symbolId);
        if (!directNode) throw new ContextMeshError("NOT_FOUND", `Code symbol not found: ${input.symbolId}`);
        linkedNodeIds.push(directNode.id);
      }
      const anchorAndSearch = this.database.recallSnapshot({
        query: input.query,
        tokenBudget: input.tokenBudget,
        includeAnchors: true,
        limit: 50,
        offset: 0,
      });
      candidateTruncated = anchorAndSearch.truncated;
      for (const memory of anchorAndSearch.anchors) {
        memoryById.set(memory.id, {
          ...memory,
          source: "anchor",
          untrusted: true,
          provenance: { sessionId: memory.sessionId, codeLinks: [], codeLinksOmitted: 0 },
        });
      }
      for (const memory of anchorAndSearch.fragments) {
        if (memoryById.has(memory.id)) continue;
        memoryById.set(memory.id, {
          ...memory,
          source: "search",
          untrusted: true,
          provenance: { sessionId: memory.sessionId, codeLinks: [], codeLinksOmitted: 0 },
        });
      }
      const linked = this.database.getMemoriesLinkedToNodes(linkedNodeIds, 30);
      for (const memory of linked) {
        if (!memoryById.has(memory.id) || !memory.isAnchor) {
          memoryById.set(memory.id, {
            ...memory,
            source: memory.isAnchor ? "anchor" : "linked",
            untrusted: true,
            provenance: { sessionId: memory.sessionId, codeLinks: [], codeLinksOmitted: 0 },
          });
        }
      }
      const related = this.database.getRelatedMemories([...memoryById.keys()], 20);
      for (const memory of related) {
        if (!memoryById.has(memory.id)) {
          memoryById.set(memory.id, {
            ...memory,
            source: memory.isAnchor ? "anchor" : "linked",
            untrusted: true,
            provenance: { sessionId: memory.sessionId, codeLinks: [], codeLinksOmitted: 0 },
          });
        }
      }
      const provenance = this.database.getMemoryCodeProvenance([...memoryById.keys()]);
      for (const memory of memoryById.values()) {
        memory.provenance.codeLinks = provenance.get(memory.id) ?? [];
      }
    }

    let order = 0;
    for (const item of codeById.values()) {
      const priority = item.source === "direct" ? 0 : item.source === "search" ? 2 : 4;
      candidates.push({
        key: `code:${item.id}`,
        priority,
        order,
        kind: "code",
        value: item,
      });
      order += 1;
    }
    for (const item of memoryById.values()) {
      const priority = item.source === "anchor" ? 1 : item.source === "linked" ? 3 : 5;
      candidates.push({
        key: `memory:${item.id}`,
        priority,
        order,
        kind: "memory",
        value: item,
      });
      order += 1;
    }
    candidates.sort(
      (left, right) => left.priority - right.priority || left.order - right.order || left.key.localeCompare(right.key),
    );

    return {
      query: input.query,
      candidates,
      relationships,
      candidateTruncated,
      warnings: [...new Set(warnings)],
    };
  }

  async hydrateSnippets(
    assembled: AssembledContext,
    requestGeneration: number,
    requestSuccessFence: number,
  ): Promise<{ assembled: AssembledContext; generationChanged: boolean }> {
    const warnings = [...assembled.warnings];
    let generationChanged = false;
    const candidates: ContextCandidate[] = [];
    for (const candidate of assembled.candidates) {
      if (candidate.kind !== "code") {
        candidates.push(candidate);
        continue;
      }
      const item = candidate.value as ContextCodeItem;
      const snippet = await this.indexer.readSnippet(item, item.source === "graph" ? 0 : 2);
      if (snippet.warning) warnings.push(snippet.warning);
      if (snippet.staleReason) {
        const recorded = await this.indexer.recordStaleIfCurrent(
          requestGeneration,
          requestSuccessFence,
          snippet.staleReason,
        );
        if (!recorded) generationChanged = true;
      }
      candidates.push({ ...candidate, value: { ...item, snippet: snippet.snippet } });
    }
    return {
      assembled: { ...assembled, candidates, warnings: [...new Set(warnings)] },
      generationChanged,
    };
  }
}
