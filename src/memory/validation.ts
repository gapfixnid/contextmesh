import type { MemoryValidationState } from "../contracts.js";
import type { EligibilityInput, EligibilityResult } from "./types.js";
import { VALIDATION_SEVERITY } from "./types.js";

export function aggregateValidationStates(states: readonly MemoryValidationState[]): MemoryValidationState {
  if (states.length === 0) return "unlinked";
  return [...states].sort((left, right) => VALIDATION_SEVERITY[right] - VALIDATION_SEVERITY[left])[0]!;
}

export function evaluateMemoryEligibility(input: EligibilityInput, clock: Date): EligibilityResult {
  const now = clock.toISOString();
  if (input.state !== "active") return { eligible: false, reasonCode: "LIFECYCLE_INACTIVE" };
  if (input.expiresAt !== null && input.expiresAt <= now) return { eligible: false, reasonCode: "LIFECYCLE_EXPIRED" };
  if (input.validFrom > now) return { eligible: false, reasonCode: "NOT_YET_VALID" };
  if (input.validTo !== null && now >= input.validTo) return { eligible: false, reasonCode: "VALIDITY_ENDED" };
  if (input.assertionStatus === "rejected") return { eligible: false, reasonCode: "ASSERTION_REJECTED" };
  if (!["unlinked", "valid", "relocated"].includes(input.validationState)) {
    return { eligible: false, reasonCode: `VALIDATION_${input.validationState.toUpperCase()}` };
  }
  if (input.maintenanceState === "review_required") return { eligible: false, reasonCode: "MAINTENANCE_REVIEW_REQUIRED" };
  return { eligible: true, reasonCode: null };
}

export interface LinkValidationCandidate {
  id: string;
  localKey: string;
  language: string | null;
  kind: string;
  name: string;
  qualifiedName: string;
  signature: string;
  contentHash: string;
}

export interface LinkLocator {
  localKey: string;
  language: string | null;
  kind: string | null;
  name: string | null;
  qualifiedName: string | null;
  signature: string | null;
  contentHash: string | null;
}

export function selectLinkTarget(
  locator: LinkLocator,
  nodes: readonly LinkValidationCandidate[],
): { state: "exact" | "relocated" | "ambiguous" | "missing" | "insufficient"; node: LinkValidationCandidate | null } {
  if (!locator.localKey || !locator.name || !locator.kind || !locator.contentHash) {
    return { state: "insufficient", node: null };
  }
  const compatible = (node: LinkValidationCandidate) =>
    (!locator.language || node.language === locator.language) && (locator.kind === "resource" || node.kind === locator.kind);
  const exact = nodes.filter((node) => node.localKey === locator.localKey && compatible(node));
  if (exact.length === 1) return { state: "exact", node: exact[0]! };
  if (exact.length > 1) return { state: "ambiguous", node: null };
  const stages = [
    (node: LinkValidationCandidate) => compatible(node) && node.name === locator.name && node.contentHash === locator.contentHash,
    (node: LinkValidationCandidate) => compatible(node) && node.qualifiedName === locator.qualifiedName,
    (node: LinkValidationCandidate) => compatible(node) && node.signature === locator.signature && node.name === locator.name,
  ];
  for (const stage of stages) {
    const matches = nodes.filter(stage);
    if (matches.length === 1) return { state: "relocated", node: matches[0]! };
    if (matches.length > 1) return { state: "ambiguous", node: null };
  }
  return { state: "missing", node: null };
}
