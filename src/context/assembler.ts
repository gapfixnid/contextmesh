import type { GetContextInput, MemoryFragmentRecord } from "../contracts.js";
import { ContextMeshError } from "../errors.js";
import type {
  CodeSearchResult,
  ContextMeshStorage,
  MemoryCodeProvenance,
  TraceEdgeResult,
} from "../storage/database.js";
import type { CodeIndexer } from "../code/indexer.js";
import { fuseAndDiversify, type RankingItem } from "../semantic/ranking.js";
import type { SemanticSearchResult } from "../semantic/service.js";

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
  relevance: number;
  mmrScore: number;
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

  assembleDatabase(
    input: GetContextInput,
    semanticCode: SemanticSearchResult | null = null,
    semanticMemory: SemanticSearchResult | null = null,
  ): AssembledContext {
    const includeCode = input.include.includes("code");
    const includeMemory = input.include.includes("memory");
    const warnings: string[] = [
      ...(semanticCode?.warnings ?? []),
      ...(semanticMemory?.warnings ?? []),
    ];
    const candidates: ContextCandidate[] = [];
    const codeById = new Map<string, ContextCodeItem>();
    const memoryById = new Map<string, ContextMemoryItem>();
    const codeRelevance = new Map<string, number>();
    const memoryRelevance = new Map<string, number>();
    const codeMmr = new Map<string, number>();
    const memoryMmr = new Map<string, number>();
    let relationships: TraceEdgeResult[] = [];
    let candidateTruncated = false;

    let searchResults: CodeSearchResult[] = [];
    let traceStartId: string | undefined = input.symbolId;
    if (includeCode) {
      searchResults = this.database.searchCode(input.query, undefined, 100);
      candidateTruncated ||= searchResults.length === 100 || (semanticCode?.candidates.length ?? 0) === 100;
      const semanticNodes = semanticCode
        ? this.database.getCodeNodesByIds(semanticCode.candidates.map((candidate) => candidate.id))
        : [];
      const semanticById = new Map(semanticCode?.candidates.map((candidate) => [candidate.id, candidate]) ?? []);
      const direct = input.symbolId ? this.database.getCodeNode(input.symbolId) : null;
      if (input.symbolId && !direct) throw new ContextMeshError("NOT_FOUND", `Code symbol not found: ${input.symbolId}`);
      const codeItem = (node: CodeSearchResult): RankingItem<CodeSearchResult> => ({
        id: node.id,
        value: node,
        text: [node.kind, node.name, node.qualifiedName, node.relativePath ?? "", node.signature, node.doc].join("\n"),
        ...(semanticById.get(node.id)?.vector ? { vector: semanticById.get(node.id)!.vector } : {}),
      });
      const preliminarySources = [
        { weight: 1, items: searchResults.map(codeItem) },
        ...(semanticNodes.length > 0 ? [{ weight: 1, items: semanticNodes.map(codeItem) }] : []),
        ...(direct ? [{ weight: 1, items: [codeItem(direct)] }] : []),
      ];
      const preliminary = fuseAndDiversify(preliminarySources, direct ? [direct.id] : []);
      traceStartId ??= preliminary[0]?.id;
      let graphNodes: CodeSearchResult[] = [];
      if (traceStartId) {
        const trace = this.database.traceCode(traceStartId, "both", undefined, 1, 50);
        relationships = trace.edges;
        graphNodes = trace.nodes;
        if (trace.unresolved.length > 0) {
          warnings.push(`${trace.unresolved.length} unresolved code reference(s) were encountered near the selected symbol`);
        }
      }
      const lexicalIds = new Set(searchResults.map((node) => node.id));
      const semanticIds = new Set(semanticNodes.map((node) => node.id));
      const graphIds = new Set(graphNodes.map((node) => node.id));
      const fusedCode = fuseAndDiversify(
        [
          { weight: 1, items: searchResults.map(codeItem) },
          ...(semanticNodes.length > 0 ? [{ weight: 1, items: semanticNodes.map(codeItem) }] : []),
          { weight: 0.75, items: graphNodes.map(codeItem) },
          ...(direct ? [{ weight: 1, items: [codeItem(direct)] }] : []),
        ],
        direct ? [direct.id] : [],
      );
      for (const candidate of fusedCode) {
        const node = candidate.value;
        const source =
          node.id === input.symbolId
            ? "direct"
            : lexicalIds.has(node.id) || semanticIds.has(node.id)
              ? "search"
              : graphIds.has(node.id)
                ? "graph"
                : "search";
        codeById.set(node.id, { ...node, score: candidate.relevance, snippet: null, source });
        codeRelevance.set(node.id, candidate.relevance);
        codeMmr.set(node.id, candidate.mmrScore);
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
        limit: 100,
        offset: 0,
      });
      candidateTruncated ||= anchorAndSearch.truncated || (semanticMemory?.candidates.length ?? 0) === 100;
      const semanticMemories = semanticMemory
        ? this.database.getMemoriesByIds(semanticMemory.candidates.map((candidate) => candidate.id))
        : [];
      const semanticById = new Map(semanticMemory?.candidates.map((candidate) => [candidate.id, candidate]) ?? []);
      for (const memory of anchorAndSearch.anchors) {
        memoryById.set(memory.id, {
          ...memory,
          source: "anchor",
          untrusted: true,
          provenance: { sessionId: memory.sessionId, codeLinks: [], codeLinksOmitted: 0 },
        });
        memoryRelevance.set(memory.id, 1);
        memoryMmr.set(memory.id, 1);
      }
      const linked = this.database.getMemoriesLinkedToNodes(linkedNodeIds, 30);
      const preliminaryMemoryIds = [
        ...anchorAndSearch.anchors.map((memory) => memory.id),
        ...anchorAndSearch.fragments.map((memory) => memory.id),
        ...semanticMemories.map((memory) => memory.id),
        ...linked.map((memory) => memory.id),
      ];
      const related = this.database.getRelatedMemories(preliminaryMemoryIds, 20);
      const memoryItem = (memory: MemoryFragmentRecord): RankingItem<MemoryFragmentRecord> => ({
        id: memory.id,
        value: memory,
        text: [memory.type, memory.topic, memory.keywords.join(" "), memory.content].join("\n"),
        ...(semanticById.get(memory.id)?.vector ? { vector: semanticById.get(memory.id)!.vector } : {}),
      });
      const linkedAndRelated = [...linked, ...related].filter(
        (memory, index, all) => all.findIndex((candidate) => candidate.id === memory.id) === index,
      );
      const fusedMemory = fuseAndDiversify(
        [
          { weight: 1, items: anchorAndSearch.fragments.map(memoryItem) },
          ...(semanticMemories.length > 0
            ? [{ weight: 1, items: semanticMemories.filter((memory) => !memory.isAnchor).map(memoryItem) }]
            : []),
          { weight: 0.75, items: linkedAndRelated.filter((memory) => !memory.isAnchor).map(memoryItem) },
        ],
      );
      const linkedIds = new Set(linkedAndRelated.map((memory) => memory.id));
      for (const candidate of fusedMemory) {
        const memory = candidate.value;
        if (memoryById.has(memory.id)) continue;
        memoryById.set(memory.id, {
          ...memory,
          source: linkedIds.has(memory.id) ? "linked" : "search",
          untrusted: true,
          provenance: { sessionId: memory.sessionId, codeLinks: [], codeLinksOmitted: 0 },
        });
        memoryRelevance.set(memory.id, candidate.relevance);
        memoryMmr.set(memory.id, candidate.mmrScore);
      }
      const provenance = this.database.getMemoryCodeProvenance([...memoryById.keys()]);
      for (const memory of memoryById.values()) {
        memory.provenance.codeLinks = provenance.get(memory.id) ?? [];
      }
    }

    let order = 0;
    const unpinned: Array<{
      kind: "code" | "memory";
      relevance: number;
      mmrScore: number;
      key: string;
      value: ContextCodeItem | ContextMemoryItem;
    }> = [];
    for (const item of codeById.values()) {
      if (item.source === "direct") {
        candidates.push({
          key: `code:${item.id}`,
          priority: 0,
          order: order++,
          relevance: 1,
          mmrScore: 1,
          kind: "code",
          value: item,
        });
      } else {
        unpinned.push({
          kind: "code",
          relevance: codeRelevance.get(item.id) ?? 0,
          mmrScore: codeMmr.get(item.id) ?? 0,
          key: `code:${item.id}`,
          value: item,
        });
      }
    }
    for (const item of memoryById.values()) {
      if (item.source === "anchor") {
        candidates.push({
          key: `memory:${item.id}`,
          priority: 1,
          order: order++,
          relevance: 1,
          mmrScore: 1,
          kind: "memory",
          value: item,
        });
      } else {
        unpinned.push({
          kind: "memory",
          relevance: memoryRelevance.get(item.id) ?? 0,
          mmrScore: memoryMmr.get(item.id) ?? 0,
          key: `memory:${item.id}`,
          value: item,
        });
      }
    }
    unpinned.sort(
      (left, right) =>
        right.mmrScore - left.mmrScore ||
        right.relevance - left.relevance ||
        left.key.localeCompare(right.key),
    );
    for (const item of unpinned) {
      candidates.push({
        key: item.key,
        priority: 2,
        order: order++,
        relevance: item.relevance,
        mmrScore: item.mmrScore,
        kind: item.kind,
        value: item.value,
      });
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
