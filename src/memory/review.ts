import type { MemoryValidationState } from "../contracts.js";
import { VALIDATION_SEVERITY } from "./types.js";

export function compareReviewItems(
  left: { validation: { state: MemoryValidationState }; candidateType?: string | null; fragment: { id: string } },
  right: { validation: { state: MemoryValidationState }; candidateType?: string | null; fragment: { id: string } },
): number {
  return VALIDATION_SEVERITY[right.validation.state] - VALIDATION_SEVERITY[left.validation.state] ||
    (left.candidateType ?? "").localeCompare(right.candidateType ?? "") ||
    left.fragment.id.localeCompare(right.fragment.id);
}
