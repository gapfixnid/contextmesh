import type { UtilityInput } from "./types.js";

const ASSERTION_BONUS = { verified: 180, observed: 100, inferred: 40, rejected: -1000 } as const;
const TYPE_BONUS = {
  decision: 100, procedure: 100, fact: 60, preference: 60, relation: 60, error: 30, episode: 0,
} as const;
const VALIDATION_ADJUSTMENT = {
  unlinked: 0, valid: 120, relocated: 80, needs_review: -200, stale: -350, orphaned: -450, contradicted: -1000,
} as const;

export function computeMemoryUtility(input: UtilityInput, clock: Date): number {
  if (input.assertionStatus === "rejected" || input.validationState === "contradicted") return 0;
  const ageBasis = Date.parse(input.observedAt ?? input.validFrom ?? input.createdAt);
  const ageBlocks = Math.max(0, Math.floor((clock.getTime() - ageBasis) / (30 * 86_400_000)));
  const decayRate = input.isAnchor
    ? 5
    : input.type === "decision" || input.type === "procedure"
      ? 10
      : input.type === "fact" || input.type === "preference" || input.type === "relation"
        ? 20
        : 40;
  const score =
    input.importance * 120 +
    ASSERTION_BONUS[input.assertionStatus] +
    (input.isAnchor ? 160 : 0) +
    TYPE_BONUS[input.type] +
    Math.min(100, input.accessCount * 5) +
    VALIDATION_ADJUSTMENT[input.validationState] -
    ageBlocks * decayRate;
  return Math.max(0, Math.min(1000, Math.trunc(score)));
}
