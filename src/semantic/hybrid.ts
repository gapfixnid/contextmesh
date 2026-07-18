import type { MemoryFragmentRecord, RecallInput, SearchCodeInput } from "../contracts.js";
import type {
  CodeSearchResult,
  ContextMeshStorage,
  RecallResult,
} from "../storage/database.js";
import { fuseAndDiversify, type RankingItem } from "./ranking.js";
import type { SemanticSearchResult } from "./service.js";
import { APPROVED_MODEL_KEY } from "./manifest.js";
import { buildCodeRedundancyText, buildMemoryRedundancyText } from "./redundancy.js";

const MAX_SOURCE_DEPTH = 10_100;

export interface HybridCodeResult {
  results: CodeSearchResult[];
  truncated: boolean;
  nextOffset: number | null;
}

export function hybridCodeSearch(
  database: ContextMeshStorage,
  input: SearchCodeInput,
  semantic: SemanticSearchResult | null,
): HybridCodeResult {
  const sourceDepth = Math.min(MAX_SOURCE_DEPTH, input.offset + input.limit + 1);
  const lexical = database.searchCode(input.query, input.kinds, sourceDepth, 0);
  const semanticNodes = semantic ? database.getCodeNodesByIds(semantic.candidates.map((candidate) => candidate.id)) : [];
  const semanticById = new Map(semantic?.candidates.map((candidate) => [candidate.id, candidate]) ?? []);
  const lexicalItems: RankingItem<CodeSearchResult>[] = lexical.map((node) => ({
    id: node.id,
    value: node,
    text: buildCodeRedundancyText(node),
    ...(semanticById.get(node.id)?.vector
      ? { vector: semanticById.get(node.id)!.vector, vectorModelKey: APPROVED_MODEL_KEY }
      : {}),
  }));
  const semanticItems: RankingItem<CodeSearchResult>[] = semanticNodes.map((node) => ({
    id: node.id,
    value: node,
    text: buildCodeRedundancyText(node),
    vector: semanticById.get(node.id)!.vector,
    vectorModelKey: APPROVED_MODEL_KEY,
  }));
  const normalizedQuery = input.query.toLocaleLowerCase("en-US");
  const pinnedIds = lexical
    .filter(
      (node) =>
        node.name.toLocaleLowerCase("en-US") === normalizedQuery ||
        node.qualifiedName.toLocaleLowerCase("en-US") === normalizedQuery,
    )
    .map((node) => node.id);
  const sources = [{ weight: 1, items: lexicalItems }];
  if (semanticItems.length > 0) sources.push({ weight: 1, items: semanticItems });
  const fused = fuseAndDiversify(sources, pinnedIds);
  const page = fused.slice(input.offset, input.offset + input.limit);
  const hasMore =
    fused.length > input.offset + input.limit ||
    lexical.length === sourceDepth ||
    (semantic?.candidates.length ?? 0) === sourceDepth;
  return {
    results: page.map((candidate) => ({ ...candidate.value, score: candidate.relevance })),
    truncated: hasMore,
    nextOffset: hasMore ? input.offset + input.limit : null,
  };
}

export function hybridMemoryRecall(
  database: ContextMeshStorage,
  input: RecallInput,
  semantic: SemanticSearchResult | null,
): RecallResult {
  const sourceDepth = Math.min(MAX_SOURCE_DEPTH, input.offset + input.limit + 1);
  const lexical = database.recall({ ...input, limit: sourceDepth, offset: 0 });
  const semanticMemories = semantic
    ? database
        .getMemoriesByIds(semantic.candidates.map((candidate) => candidate.id))
        .filter((memory) => !memory.isAnchor)
    : [];
  const semanticById = new Map(semantic?.candidates.map((candidate) => [candidate.id, candidate]) ?? []);
  const lexicalItems: RankingItem<MemoryFragmentRecord>[] = lexical.fragments.map((memory) => ({
    id: memory.id,
    value: memory,
    text: buildMemoryRedundancyText(memory),
    ...(semanticById.get(memory.id)?.vector
      ? { vector: semanticById.get(memory.id)!.vector, vectorModelKey: APPROVED_MODEL_KEY }
      : {}),
  }));
  const semanticItems: RankingItem<MemoryFragmentRecord>[] = semanticMemories.map((memory) => ({
    id: memory.id,
    value: memory,
    text: buildMemoryRedundancyText(memory),
    vector: semanticById.get(memory.id)!.vector,
    vectorModelKey: APPROVED_MODEL_KEY,
  }));
  const query = input.query?.toLocaleLowerCase("en-US") ?? "";
  const pinnedIds = query
    ? lexical.fragments
        .filter(
          (memory) =>
            memory.topic.toLocaleLowerCase("en-US") === query ||
            memory.content.toLocaleLowerCase("en-US") === query,
        )
        .map((memory) => memory.id)
    : [];
  const sources = [{ weight: 1, items: lexicalItems }];
  if (semanticItems.length > 0) sources.push({ weight: 1, items: semanticItems });
  const fused = fuseAndDiversify(sources, pinnedIds);
  const fragments = fused.slice(input.offset, input.offset + input.limit).map((candidate) => candidate.value);
  const hasMore =
    fused.length > input.offset + input.limit ||
    lexical.truncated ||
    (semantic?.candidates.length ?? 0) === sourceDepth;
  return {
    anchors: lexical.anchors,
    fragments,
    truncated: hasMore,
    nextOffset: hasMore ? input.offset + input.limit : null,
  };
}
