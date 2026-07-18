import { dotProduct } from "./vector-codec.js";

const RRF_K = 60;
const MMR_LAMBDA = 0.75;
const SCORE_QUANTUM = 1_000_000;
const RANK_SCORE_QUANTUM = 100_000;
export const REDUNDANCY_TEXT_VERSION = 1;

export interface RankingItem<T> {
  id: string;
  value: T;
  vector?: Float32Array;
  vectorModelKey?: string;
  text: string;
}

export interface RankingSource<T> {
  weight: number;
  items: RankingItem<T>[];
  normalizationGroup?: string;
}

export interface FusedRankingItem<T> extends RankingItem<T> {
  relevance: number;
  mmrScore: number;
  rankScore: number;
  sourceRanks: number[];
}

export interface RankingDiagnostics {
  inputByNormalizationGroup: Record<string, number>;
  uniqueCandidates: number;
  nearDuplicatePairs: number;
  hardDeduplicatedCandidates: number;
  selectedCandidates: number;
}

export function quantizeScore(value: number): number {
  return Math.round(value * SCORE_QUANTUM) / SCORE_QUANTUM;
}

/** Internal cross-platform sort bucket; public scores remain at 1e-6. */
export function rankScore(value: number): number {
  return Math.round(value * RANK_SCORE_QUANTUM);
}

export function redundancyTokens(value: string): string[] {
  return value
    .normalize("NFC")
    .replace(/^\s*(?:query|passage)\s*:\s*/iu, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function tokenSet(tokens: readonly string[]): Set<string> {
  return new Set(tokens);
}

function shingles(tokens: readonly string[], width = 5): Set<string> {
  const result = new Set<string>();
  for (let index = 0; index <= tokens.length - width; index += 1) {
    result.add(tokens.slice(index, index + width).join(" "));
  }
  return result;
}

interface PreparedRedundancyText {
  tokens: string[];
  tokenSet: Set<string>;
  shingles: Set<string> | null;
}

function prepareRedundancyText(value: string): PreparedRedundancyText {
  const tokens = redundancyTokens(value);
  return {
    tokens,
    tokenSet: tokenSet(tokens),
    shingles: tokens.length >= 5 ? shingles(tokens) : null,
  };
}

function setJaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / Math.max(1, left.size + right.size - intersection);
}

function preparedTextRedundancy(
  left: PreparedRedundancyText,
  right: PreparedRedundancyText,
  sameEntity: boolean,
): number {
  if (left.tokens.length === 0 && right.tokens.length === 0) return sameEntity ? 1 : 0;
  if (
    left.tokens.length === right.tokens.length &&
    left.tokens.every((token, index) => token === right.tokens[index])
  ) {
    return 1;
  }
  if (!left.shingles || !right.shingles) return setJaccard(left.tokenSet, right.tokenSet);
  return setJaccard(left.shingles, right.shingles);
}

export function textRedundancy(leftText: string, rightText: string, sameEntity = false): number {
  return preparedTextRedundancy(
    prepareRedundancyText(leftText),
    prepareRedundancyText(rightText),
    sameEntity,
  );
}

export function nearDuplicateText(left: string, right: string, threshold = 0.8): boolean {
  return textRedundancy(left, right, false) >= threshold;
}

export function rankingRedundancy(left: RankingItem<unknown>, right: RankingItem<unknown>): number {
  if (
    left.vector &&
    right.vector &&
    left.vectorModelKey &&
    left.vectorModelKey === right.vectorModelKey
  ) {
    return Math.max(0, Math.min(1, (dotProduct(left.vector, right.vector) + 1) / 2));
  }
  return textRedundancy(left.text, right.text, left.id === right.id);
}

export function fuseAndDiversify<T>(
  sources: RankingSource<T>[],
  pinnedIds: readonly string[] = [],
  pinnedItems: readonly RankingItem<T>[] = [],
  diagnostics?: RankingDiagnostics,
): FusedRankingItem<T>[] {
  const candidates = new Map<
    string,
    { item: RankingItem<T>; contribution: number; sourceRanks: number[]; normalizationGroup: string }
  >();
  const maximumContribution = new Map<string, number>();
  for (const source of sources) {
    const group = source.normalizationGroup ?? "default";
    maximumContribution.set(
      group,
      (maximumContribution.get(group) ?? 0) + source.weight / (RRF_K + 1),
    );
  }
  sources.forEach((source, sourceIndex) => {
    const normalizationGroup = source.normalizationGroup ?? "default";
    source.items.forEach((item, index) => {
      const existing = candidates.get(item.id) ?? {
        item,
        contribution: 0,
        sourceRanks: [],
        normalizationGroup,
      };
      if (existing.normalizationGroup !== normalizationGroup) {
        throw new Error(`Ranking item ${item.id} appears in multiple normalization groups`);
      }
      existing.contribution += source.weight / (RRF_K + index + 1);
      existing.sourceRanks[sourceIndex] = index + 1;
      if (!existing.item.vector && item.vector) existing.item = item;
      candidates.set(item.id, existing);
    });
  });
  for (const item of pinnedItems) {
    if (!candidates.has(item.id)) {
      candidates.set(item.id, { item, contribution: 0, sourceRanks: [], normalizationGroup: "default" });
    }
  }
  if (diagnostics) {
    diagnostics.inputByNormalizationGroup = {};
    for (const candidate of candidates.values()) {
      diagnostics.inputByNormalizationGroup[candidate.normalizationGroup] =
        (diagnostics.inputByNormalizationGroup[candidate.normalizationGroup] ?? 0) + 1;
    }
    diagnostics.uniqueCandidates = candidates.size;
    diagnostics.nearDuplicatePairs = 0;
    diagnostics.hardDeduplicatedCandidates = 0;
    diagnostics.selectedCandidates = 0;
  }

  const fused = [...candidates.values()].map(({ item, contribution, sourceRanks, normalizationGroup }) => {
    const maximum = maximumContribution.get(normalizationGroup) ?? 0;
    return {
      ...item,
      relevance: quantizeScore(maximum === 0 ? 0 : Math.min(1, contribution / maximum)),
      mmrScore: 0,
      rankScore: 0,
      sourceRanks,
    };
  });
  const byId = new Map(fused.map((candidate) => [candidate.id, candidate]));
  const selected: FusedRankingItem<T>[] = [];
  for (const id of pinnedIds) {
    const candidate = byId.get(id);
    if (!candidate || selected.some((item) => item.id === id)) continue;
    candidate.relevance = 1;
    candidate.mmrScore = 1;
    candidate.rankScore = rankScore(1);
    selected.push(candidate);
    byId.delete(id);
  }

  const remaining = [...byId.values()];
  const preparedText = new Map(
    fused.map((candidate) => [candidate.id, prepareRedundancyText(candidate.text)]),
  );
  const nearDuplicatePairs = new Set<string>();
  const recordRedundancy = (
    left: FusedRankingItem<T>,
    right: FusedRankingItem<T>,
    redundancy: number,
  ): number => {
    if (redundancy >= 0.8) {
      nearDuplicatePairs.add(left.id < right.id ? `${left.id}\0${right.id}` : `${right.id}\0${left.id}`);
    }
    return redundancy;
  };
  const textOnlyRedundancy = (left: FusedRankingItem<T>, right: FusedRankingItem<T>): number =>
    recordRedundancy(
      left,
      right,
      preparedTextRedundancy(
        preparedText.get(left.id)!,
        preparedText.get(right.id)!,
        left.id === right.id,
      ),
    );
  const cachedRedundancy = (left: FusedRankingItem<T>, right: FusedRankingItem<T>): number => {
    if (
      left.vector &&
      right.vector &&
      left.vectorModelKey &&
      left.vectorModelKey === right.vectorModelKey
    ) {
      return recordRedundancy(
        left,
        right,
        Math.max(0, Math.min(1, (dotProduct(left.vector, right.vector) + 1) / 2)),
      );
    }
    return textOnlyRedundancy(left, right);
  };
  const maximumRedundancy = new Map<string, number>();
  for (let index = remaining.length - 1; index >= 0; index -= 1) {
    const candidate = remaining[index]!;
    if (
      !candidate.vector &&
      selected.some((previous) => textOnlyRedundancy(candidate, previous) >= 0.8)
    ) {
      remaining.splice(index, 1);
      if (diagnostics) diagnostics.hardDeduplicatedCandidates += 1;
      continue;
    }
    maximumRedundancy.set(
      candidate.id,
      selected.reduce((maximum, previous) => Math.max(maximum, cachedRedundancy(candidate, previous)), 0),
    );
  }
  while (remaining.length > 0) {
    for (const candidate of remaining) {
      candidate.mmrScore = quantizeScore(
        MMR_LAMBDA * candidate.relevance -
          (1 - MMR_LAMBDA) * (maximumRedundancy.get(candidate.id) ?? 0),
      );
      candidate.rankScore = rankScore(candidate.mmrScore);
    }
    remaining.sort(
      (left, right) =>
        right.rankScore - left.rankScore ||
        rankScore(right.relevance) - rankScore(left.relevance) ||
        left.id.localeCompare(right.id),
    );
    const next = remaining.shift();
    if (!next) continue;
    selected.push(next);
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      const candidate = remaining[index]!;
      if (
        !candidate.vector &&
        textOnlyRedundancy(candidate, next) >= 0.8
      ) {
        remaining.splice(index, 1);
        maximumRedundancy.delete(candidate.id);
        if (diagnostics) diagnostics.hardDeduplicatedCandidates += 1;
        continue;
      }
      maximumRedundancy.set(
        candidate.id,
        Math.max(maximumRedundancy.get(candidate.id) ?? 0, cachedRedundancy(candidate, next)),
      );
    }
  }
  if (diagnostics) {
    diagnostics.nearDuplicatePairs = nearDuplicatePairs.size;
    diagnostics.selectedCandidates = selected.length;
  }
  return selected;
}
