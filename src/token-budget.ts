import type { Envelope, WorkspaceSnapshot } from "./contracts.js";
import { ContextMeshError } from "./errors.js";
import { estimateTokens } from "./utils.js";

export interface EnvelopeScope {
  workspaceId: string;
  generation: number;
  snapshot?: WorkspaceSnapshot;
}

function envelopeWithEstimate<T>(
  scope: EnvelopeScope,
  data: T,
  warnings: string[],
  truncated: boolean,
  estimatedTokens: number,
): Envelope<T> {
  return {
    schemaVersion: 1,
    workspaceId: scope.workspaceId,
    generation: scope.generation,
    data,
    warnings,
    truncated,
    estimatedTokens,
    ...(scope.snapshot ? { snapshot: scope.snapshot } : {}),
  };
}

export function stabilizeEnvelope<T>(
  scope: EnvelopeScope,
  data: T,
  warnings: string[] = [],
  truncated = false,
): Envelope<T> {
  let estimate = 0;
  const observed: number[] = [];
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const envelope = envelopeWithEstimate(scope, data, warnings, truncated, estimate);
    const actual = estimateTokens(envelope);
    observed.push(actual);
    if (actual === estimate) return envelope;
    estimate = actual;
  }

  const conservative = Math.max(estimate, ...observed) + 32;
  const envelope = envelopeWithEstimate(scope, data, warnings, truncated, conservative);
  if (estimateTokens(envelope) > conservative) {
    throw new ContextMeshError("INTERNAL_ERROR", "Could not establish a conservative token estimate");
  }
  return envelope;
}

export function envelopeFits<T>(
  scope: EnvelopeScope,
  data: T,
  warnings: string[],
  truncated: boolean,
  tokenBudget: number,
): boolean {
  return stabilizeEnvelope(scope, data, warnings, truncated).estimatedTokens <= tokenBudget;
}

