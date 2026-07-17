import { dotProduct } from "./vector-codec.js";

const RRF_K = 60;
const MMR_LAMBDA = 0.75;
const SCORE_QUANTUM = 1_000_000;

export interface RankingItem<T> {
  id: string;
  value: T;
  vector?: Float32Array;
  text: string;
}

export interface RankingSource<T> {
  weight: number;
  items: RankingItem<T>[];
}

export interface FusedRankingItem<T> extends RankingItem<T> {
  relevance: number;
  mmrScore: number;
  sourceRanks: number[];
}

export function quantizeScore(value: number): number {
  return Math.round(value * SCORE_QUANTUM) / SCORE_QUANTUM;
}

function normalizedTokens(value: string): string[] {
  return value
    .normalize("NFC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function shingles(value: string, width = 5): Set<string> {
  const tokens = normalizedTokens(value);
  if (tokens.length < width) return new Set(tokens.length > 0 ? [tokens.join(" ")] : []);
  const result = new Set<string>();
  for (let index = 0; index <= tokens.length - width; index += 1) {
    result.add(tokens.slice(index, index + width).join(" "));
  }
  return result;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / Math.max(1, left.size + right.size - intersection);
}

export function nearDuplicateText(left: string, right: string, threshold = 0.8): boolean {
  return jaccard(shingles(left), shingles(right)) >= threshold;
}

function redundancy(left: RankingItem<unknown>, right: RankingItem<unknown>): number {
  if (left.vector && right.vector) return Math.max(0, Math.min(1, (dotProduct(left.vector, right.vector) + 1) / 2));
  return jaccard(shingles(left.text), shingles(right.text));
}

export function fuseAndDiversify<T>(sources: RankingSource<T>[], pinnedIds: readonly string[] = []): FusedRankingItem<T>[] {
  const candidates = new Map<
    string,
    { item: RankingItem<T>; contribution: number; sourceRanks: number[] }
  >();
  const maximumContribution = sources.reduce((sum, source) => sum + source.weight / (RRF_K + 1), 0);
  sources.forEach((source, sourceIndex) => {
    source.items.forEach((item, index) => {
      const existing = candidates.get(item.id) ?? { item, contribution: 0, sourceRanks: [] };
      existing.contribution += source.weight / (RRF_K + index + 1);
      existing.sourceRanks[sourceIndex] = index + 1;
      if (!existing.item.vector && item.vector) existing.item = item;
      candidates.set(item.id, existing);
    });
  });

  const fused = [...candidates.values()].map(({ item, contribution, sourceRanks }) => ({
    ...item,
    relevance: quantizeScore(maximumContribution === 0 ? 0 : Math.min(1, contribution / maximumContribution)),
    mmrScore: 0,
    sourceRanks,
  }));
  const byId = new Map(fused.map((candidate) => [candidate.id, candidate]));
  const selected: FusedRankingItem<T>[] = [];
  for (const id of pinnedIds) {
    const candidate = byId.get(id);
    if (!candidate || selected.some((item) => item.id === id)) continue;
    candidate.relevance = 1;
    candidate.mmrScore = 1;
    selected.push(candidate);
    byId.delete(id);
  }

  const remaining = [...byId.values()];
  while (remaining.length > 0) {
    for (const candidate of remaining) {
      const maximumRedundancy = selected.reduce(
        (maximum, previous) => Math.max(maximum, redundancy(candidate, previous)),
        0,
      );
      candidate.mmrScore = quantizeScore(
        MMR_LAMBDA * candidate.relevance - (1 - MMR_LAMBDA) * maximumRedundancy,
      );
    }
    remaining.sort(
      (left, right) =>
        right.mmrScore - left.mmrScore ||
        right.relevance - left.relevance ||
        left.id.localeCompare(right.id),
    );
    const next = remaining.shift();
    if (next) selected.push(next);
  }
  return selected;
}
