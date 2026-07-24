import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function stableDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function stableClaimId(input: {
  workspaceId: string; memoryId: string; namespace: string; claimKey: string;
  operator: string; canonicalValueJson: string; sourceSymbolId: string | null;
}): string {
  return `mclaim_${stableDigest(input)}`;
}

export function stableCandidateId(input: {
  candidateType: string; memoryIds: readonly string[]; claimKey?: string | null; evidenceDigest: string;
}): string {
  return `mcand_${stableDigest({
    candidateType: input.candidateType,
    memoryIds: [...input.memoryIds].sort(),
    claimKey: input.claimKey ?? null,
    evidenceDigest: input.evidenceDigest,
  })}`;
}

export function validityIntervalsOverlap(
  left: { validFrom: string; validTo: string | null },
  right: { validFrom: string; validTo: string | null },
): boolean {
  return (left.validTo === null || right.validFrom < left.validTo) &&
    (right.validTo === null || left.validFrom < right.validTo);
}
