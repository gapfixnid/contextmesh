import type { GetContextInput, MemoryFragmentRecord, TraceCodeInput } from "../contracts.js";
import { ContextMeshError } from "../errors.js";
import type {
  CodeSearchResult,
  ContextMeshStorage,
  MemoryCodeProvenance,
  TraceEdgeResult,
} from "../storage/database.js";
import type { CodeIndexer } from "../code/indexer.js";
import { APPROVED_MODEL_KEY } from "../semantic/manifest.js";
import {
  fuseAndDiversify,
  type RankingDiagnostics,
  type RankingItem,
  type RankingSource,
} from "../semantic/ranking.js";
import type { SemanticSearchResult } from "../semantic/service.js";
import { buildCodeRedundancyText, buildMemoryRedundancyText } from "../semantic/redundancy.js";

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
  rankingDiagnostics: RankingDiagnostics;
}

export interface ContextCandidate {
  key: string;
  priority: number;
  order: number;
  relevance: number;
  mmrScore: number;
  kind: "code" | "memory";
  hasVector: boolean;
  value: ContextCodeItem | ContextMemoryItem;
}

type UnifiedContextValue =
  | { kind: "code"; value: CodeSearchResult }
  | { kind: "memory"; value: MemoryFragmentRecord };

const SNIPPET_READ_CONCURRENCY = 8;

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function planeSources<T extends UnifiedContextValue>(
  items: readonly RankingItem<T>[],
  weight: number,
): RankingSource<T>[] {
  return (["code", "memory"] as const).flatMap((plane) => {
    const planeItems = items.filter((item) => item.value.kind === plane);
    return planeItems.length > 0 ? [{ weight, items: planeItems, normalizationGroup: plane }] : [];
  });
}

export class ContextAssembler {
  private readonly database: ContextMeshStorage;
  private readonly indexer: CodeIndexer;
  private readonly traceCode: (input: TraceCodeInput) => ReturnType<ContextMeshStorage["traceCode"]>;

  constructor(
    database: ContextMeshStorage,
    indexer: CodeIndexer,
    traceCode: (input: TraceCodeInput) => ReturnType<ContextMeshStorage["traceCode"]> = (input) =>
      database.traceCode(input.symbolId, input.direction, input.edgeKinds, input.depth, input.limit),
  ) {
    this.database = database;
    this.indexer = indexer;
    this.traceCode = traceCode;
  }

  assembleDatabase(
    input: GetContextInput,
    semanticCode: SemanticSearchResult | null = null,
    semanticMemory: SemanticSearchResult | null = null,
  ): AssembledContext {
    const includeCode = input.include.includes("code");
    const includeMemory = input.include.includes("memory");
    const warnings: string[] = [...(semanticCode?.warnings ?? []), ...(semanticMemory?.warnings ?? [])];
    let relationships: TraceEdgeResult[] = [];
    let candidateTruncated = false;

    const lexicalItems: RankingItem<UnifiedContextValue>[] = [];
    const semanticItems: RankingItem<UnifiedContextValue>[] = [];
    const graphItems: RankingItem<UnifiedContextValue>[] = [];
    const pinnedItems: RankingItem<UnifiedContextValue>[] = [];
    const pinnedIds: string[] = [];
    const lexicalCodeIds = new Set<string>();
    const semanticCodeIds = new Set<string>();
    const graphCodeIds = new Set<string>();
    const anchorMemoryIds = new Set<string>();
    const linkedMemoryIds = new Set<string>();

    const semanticCodeById = new Map(semanticCode?.candidates.map((candidate) => [candidate.id, candidate]) ?? []);
    const semanticMemoryById = new Map(
      semanticMemory?.candidates.map((candidate) => [candidate.id, candidate]) ?? [],
    );
    const codeItem = (node: CodeSearchResult): RankingItem<UnifiedContextValue> => {
      const vector = semanticCodeById.get(node.id)?.vector;
      return {
        id: `code:${node.id}`,
        value: { kind: "code", value: node },
        text: buildCodeRedundancyText(node),
        ...(vector ? { vector, vectorModelKey: APPROVED_MODEL_KEY } : {}),
      };
    };
    const memoryItem = (memory: MemoryFragmentRecord): RankingItem<UnifiedContextValue> => {
      const vector = semanticMemoryById.get(memory.id)?.vector;
      return {
        id: `memory:${memory.id}`,
        value: { kind: "memory", value: memory },
        text: buildMemoryRedundancyText(memory),
        ...(vector ? { vector, vectorModelKey: APPROVED_MODEL_KEY } : {}),
      };
    };

    let direct: CodeSearchResult | null = null;
    let traceStartId = input.symbolId;
    const allCodeNodeIds = new Set<string>();
    if (includeCode) {
      const lexicalCode = this.database.searchCode(input.query, undefined, 100);
      candidateTruncated ||= lexicalCode.length === 100 || (semanticCode?.candidates.length ?? 0) === 100;
      const semanticNodes = semanticCode
        ? this.database.getCodeNodesByIds(semanticCode.candidates.map((candidate) => candidate.id))
        : [];
      direct = input.symbolId ? this.database.getCodeNode(input.symbolId) : null;
      if (input.symbolId && !direct) throw new ContextMeshError("NOT_FOUND", `Code symbol not found: ${input.symbolId}`);
      for (const node of lexicalCode) {
        lexicalCodeIds.add(node.id);
        allCodeNodeIds.add(node.id);
        lexicalItems.push(codeItem(node));
      }
      for (const node of semanticNodes) {
        semanticCodeIds.add(node.id);
        allCodeNodeIds.add(node.id);
        semanticItems.push(codeItem(node));
      }
      if (direct) {
        allCodeNodeIds.add(direct.id);
        const item = codeItem(direct);
        pinnedItems.push(item);
        pinnedIds.push(item.id);
      }
      const preliminary = fuseAndDiversify(
        [
          ...(lexicalCode.length > 0 ? [{ weight: 1, items: lexicalCode.map(codeItem) }] : []),
          ...(semanticNodes.length > 0 ? [{ weight: 1, items: semanticNodes.map(codeItem) }] : []),
        ],
        direct ? [`code:${direct.id}`] : [],
        direct ? [codeItem(direct)] : [],
      );
      traceStartId ??= preliminary[0]?.value.kind === "code" ? preliminary[0].value.value.id : undefined;
      if (traceStartId) {
        const trace = this.traceCode({ symbolId: traceStartId, direction: "both", depth: 1, limit: 50 });
        relationships = trace.edges;
        const verificationEdges = trace.edges.filter((edge) => edge.status === "candidate" || edge.confidence < 0.9);
        if (verificationEdges.length > 0) {
          warnings.push(`SOURCE_VERIFICATION_REQUIRED: ${verificationEdges.length} candidate/low-confidence relationship(s); current source snippets are included when budget permits`);
        }
        for (const node of trace.nodes) {
          graphCodeIds.add(node.id);
          allCodeNodeIds.add(node.id);
          graphItems.push(codeItem(node));
        }
        if (trace.unresolved.length > 0) {
          warnings.push(`${trace.unresolved.length} unresolved code reference(s) were encountered near the selected symbol`);
        }
      }
    } else if (input.symbolId) {
      direct = this.database.getCodeNode(input.symbolId);
      if (!direct) throw new ContextMeshError("NOT_FOUND", `Code symbol not found: ${input.symbolId}`);
      allCodeNodeIds.add(direct.id);
    }

    if (includeMemory) {
      const recalled = this.database.recallSnapshot({
        query: input.query,
        tokenBudget: input.tokenBudget,
        includeAnchors: true,
        limit: 100,
        offset: 0,
      });
      candidateTruncated ||= recalled.truncated || (semanticMemory?.candidates.length ?? 0) === 100;
      const semanticMemories = semanticMemory
        ? this.database
            .getMemoriesByIds(semanticMemory.candidates.map((candidate) => candidate.id))
            .filter((memory) => !memory.isAnchor)
        : [];
      for (const memory of recalled.anchors) {
        anchorMemoryIds.add(memory.id);
        const item = memoryItem(memory);
        pinnedItems.push(item);
        pinnedIds.push(item.id);
      }
      for (const memory of recalled.fragments.filter((candidate) => !candidate.isAnchor)) {
        lexicalItems.push(memoryItem(memory));
      }
      for (const memory of semanticMemories) semanticItems.push(memoryItem(memory));

      const linked = this.database.getMemoriesLinkedToNodes([...allCodeNodeIds], 30);
      const relatedIds = [
        ...recalled.anchors.map((memory) => memory.id),
        ...recalled.fragments.map((memory) => memory.id),
        ...semanticMemories.map((memory) => memory.id),
        ...linked.map((memory) => memory.id),
      ];
      const related = this.database.getRelatedMemories(relatedIds, 20);
      const linkedAndRelated = [...linked, ...related].filter(
        (memory, index, all) =>
          !memory.isAnchor && all.findIndex((candidate) => candidate.id === memory.id) === index,
      );
      for (const memory of linkedAndRelated) {
        linkedMemoryIds.add(memory.id);
        graphItems.push(memoryItem(memory));
      }
    }

    const sources: RankingSource<UnifiedContextValue>[] = [];
    sources.push(...planeSources(lexicalItems, 1));
    sources.push(...planeSources(semanticItems, 1));
    sources.push(...planeSources(graphItems, 0.75));
    const rankingDiagnostics: RankingDiagnostics = {
      inputByNormalizationGroup: {},
      uniqueCandidates: 0,
      nearDuplicatePairs: 0,
      hardDeduplicatedCandidates: 0,
      selectedCandidates: 0,
    };
    const fused = fuseAndDiversify(sources, pinnedIds, pinnedItems, rankingDiagnostics);

    let order = 0;
    const candidates: ContextCandidate[] = fused.map((candidate) => {
      if (candidate.value.kind === "code") {
        const node = candidate.value.value;
        const source: ContextCodeItem["source"] =
          direct?.id === node.id
            ? "direct"
            : lexicalCodeIds.has(node.id) || semanticCodeIds.has(node.id)
              ? "search"
              : graphCodeIds.has(node.id)
                ? "graph"
                : "search";
        return {
          key: candidate.id,
          priority: source === "direct" ? 0 : 2,
          order: order++,
          relevance: candidate.relevance,
          mmrScore: candidate.mmrScore,
          kind: "code" as const,
          hasVector: Boolean(candidate.vector),
          value: { ...node, score: candidate.relevance, snippet: null, source },
        };
      }
      const memory = candidate.value.value;
      const source: ContextMemoryItem["source"] = anchorMemoryIds.has(memory.id)
        ? "anchor"
        : linkedMemoryIds.has(memory.id)
          ? "linked"
          : "search";
      return {
        key: candidate.id,
        priority: source === "anchor" ? 1 : 2,
        order: order++,
        relevance: candidate.relevance,
        mmrScore: candidate.mmrScore,
        kind: "memory" as const,
        hasVector: Boolean(candidate.vector),
        value: {
          ...memory,
          source,
          untrusted: true as const,
          provenance: { sessionId: memory.sessionId, codeLinks: [], codeLinksOmitted: 0 },
        },
      };
    });
    const memoryCandidates = candidates.filter(
      (candidate): candidate is ContextCandidate & { value: ContextMemoryItem } => candidate.kind === "memory",
    );
    const provenance = this.database.getMemoryCodeProvenance(
      memoryCandidates.map((candidate) => candidate.value.id),
    );
    for (const candidate of memoryCandidates) {
      candidate.value.provenance.codeLinks = provenance.get(candidate.value.id) ?? [];
    }

    return {
      query: input.query,
      candidates,
      relationships,
      candidateTruncated,
      warnings: [...new Set(warnings)],
      rankingDiagnostics,
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
    const codeCandidates = assembled.candidates.filter((candidate) => candidate.kind === "code");
    const snippets = await mapConcurrent(codeCandidates, SNIPPET_READ_CONCURRENCY, async (candidate) => {
      const item = candidate.value as ContextCodeItem;
      return this.indexer.readSnippet(item, item.source === "graph" ? 0 : 2);
    });
    let codeIndex = 0;
    for (const candidate of assembled.candidates) {
      if (candidate.kind !== "code") {
        candidates.push(candidate);
        continue;
      }
      const item = candidate.value as ContextCodeItem;
      const snippet = snippets[codeIndex++]!;
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
