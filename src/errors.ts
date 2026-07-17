export const ERROR_CODES = [
  "INVALID_ARGUMENT",
  "NOT_INDEXED",
  "INDEX_STALE",
  "NOT_FOUND",
  "PARSE_PARTIAL",
  "DB_BUSY",
  "INTERNAL_ERROR",
] as const;

export type ContextMeshErrorCode = (typeof ERROR_CODES)[number];

export class ContextMeshError extends Error {
  readonly code: ContextMeshErrorCode;
  readonly details?: unknown;

  constructor(code: ContextMeshErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ContextMeshError";
    this.code = code;
    this.details = details;
  }
}

export function asContextMeshError(error: unknown): ContextMeshError {
  if (error instanceof ContextMeshError) return error;
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_PARSE_ARGS")
  ) {
    return new ContextMeshError("INVALID_ARGUMENT", error.message);
  }
  if (error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message)) {
    return new ContextMeshError("DB_BUSY", error.message);
  }
  return new ContextMeshError(
    "INTERNAL_ERROR",
    error instanceof Error ? error.message : "Unknown internal error",
  );
}
