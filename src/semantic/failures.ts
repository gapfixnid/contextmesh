import { SemanticModelValidationError } from "./manifest.js";
import { controlDigest, type ControlJsonValue } from "./control-json.js";

export type SemanticFailureClass =
  | "material_sticky"
  | "scale_limit"
  | "runtime_retryable"
  | "data_repairable";

export interface SemanticFailureDiagnostic {
  failureClass: SemanticFailureClass;
  code: string;
  detailCode: string;
  materialFingerprint?: string | null;
  repairFingerprint?: string | null;
  safeSummary: string;
}

const FAILURE_PRIORITY: Record<SemanticFailureClass, number> = {
  material_sticky: 0,
  scale_limit: 1,
  runtime_retryable: 2,
  data_repairable: 3,
};

export class SemanticRuntimeError extends Error {
  readonly code: string;
  readonly detailCode: string;

  constructor(code: string, detailCode: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SemanticRuntimeError";
    this.code = code;
    this.detailCode = detailCode;
  }
}

function redactUnknownMessage(error: unknown): string {
  const source = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return source
    .replace(/[A-Za-z]:[\\/][^\s]+|\/(?:[^\s/]+\/)+[^\s]*/g, "<path>")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<uuid>")
    .replace(/\b(?:0x)?[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\b\d+(?:\.\d+){0,3}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifySemanticFailure(
  error: unknown,
  materialFingerprint: string | null = null,
): SemanticFailureDiagnostic {
  if (error instanceof SemanticModelValidationError) {
    return {
      failureClass: "material_sticky",
      code: error.reason,
      detailCode: error.reason,
      materialFingerprint,
      safeSummary: error.reason,
    };
  }
  if (error instanceof SemanticRuntimeError) {
    return {
      failureClass: "runtime_retryable",
      code: error.code,
      detailCode: error.detailCode,
      materialFingerprint,
      safeSummary: error.code,
    };
  }
  const redacted = redactUnknownMessage(error);
  return {
    failureClass: "runtime_retryable",
    code: "UNKNOWN_RUNTIME",
    detailCode: controlDigest({ redacted }),
    materialFingerprint,
    safeSummary: "UNKNOWN_RUNTIME",
  };
}

export function choosePrimaryFailure(
  diagnostics: readonly SemanticFailureDiagnostic[],
): SemanticFailureDiagnostic | null {
  return [...diagnostics].sort(
    (left, right) =>
      FAILURE_PRIORITY[left.failureClass] - FAILURE_PRIORITY[right.failureClass] ||
      left.code.localeCompare(right.code) ||
      left.detailCode.localeCompare(right.detailCode),
  )[0] ?? null;
}

export function semanticFailureFingerprint(diagnostic: SemanticFailureDiagnostic): string {
  return controlDigest({
    failureClass: diagnostic.failureClass,
    code: diagnostic.code,
    detailCode: diagnostic.detailCode,
    materialFingerprint: diagnostic.materialFingerprint ?? null,
    repairFingerprint: diagnostic.repairFingerprint ?? null,
  });
}

export interface SemanticDataDefect {
  entityId: string;
  defectCode: string;
  storedModelKey: string | null;
  generation: number | null;
  sourceHash: string | null;
  codec: string | null;
  blobLength: number | null;
  blobSha256: string | null;
}

export function repairFingerprint(defects: readonly SemanticDataDefect[]): string {
  const tuples = [...defects]
    .sort((left, right) => left.entityId.localeCompare(right.entityId) || left.defectCode.localeCompare(right.defectCode))
    .map((defect) => ({ ...defect })) as unknown as ControlJsonValue;
  return controlDigest(tuples);
}

export function dataRepairFailure(defects: readonly SemanticDataDefect[]): SemanticFailureDiagnostic {
  const fingerprint = repairFingerprint(defects);
  return {
    failureClass: "data_repairable",
    code: "EMBEDDING_DATA_REPAIR_REQUIRED",
    detailCode: "INVALID_OR_MISSING_EMBEDDING",
    repairFingerprint: fingerprint,
    safeSummary: "EMBEDDING_DATA_REPAIR_REQUIRED",
  };
}

export function scaleLimitFailure(eligible: number, maximum: number): SemanticFailureDiagnostic {
  return {
    failureClass: "scale_limit",
    code: "SCALE_LIMIT",
    detailCode: `${eligible}:${maximum}`,
    safeSummary: "SCALE_LIMIT",
  };
}
