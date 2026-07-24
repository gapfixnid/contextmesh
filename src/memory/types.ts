import type {
  AssertionStatus,
  MemoryMaintenanceState,
  MemoryType,
  MemoryValidationState,
} from "../contracts.js";

export const VALIDATION_SEVERITY: Record<MemoryValidationState, number> = {
  unlinked: 0,
  valid: 1,
  relocated: 2,
  needs_review: 3,
  orphaned: 4,
  stale: 5,
  contradicted: 6,
};

export interface UtilityInput {
  importance: number;
  assertionStatus: AssertionStatus;
  isAnchor: boolean;
  type: MemoryType;
  accessCount: number;
  validationState: MemoryValidationState;
  observedAt: string | null;
  validFrom: string | null;
  createdAt: string;
}

export interface EligibilityInput {
  state: "active" | "superseded" | "forgotten" | "expired";
  expiresAt: string | null;
  validFrom: string;
  validTo: string | null;
  assertionStatus: AssertionStatus;
  validationState: MemoryValidationState;
  maintenanceState: MemoryMaintenanceState;
}

export interface EligibilityResult {
  eligible: boolean;
  reasonCode: string | null;
}
