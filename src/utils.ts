import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface PathCaseSensitivity {
  caseSensitive: boolean;
  warning: string | null;
}

export function detectPathCaseSensitivity(workspaceRoot: string): PathCaseSensitivity {
  let probePath: string | null = null;
  try {
    const realRoot = realpathSync(workspaceRoot);
    const probeName = `.ContextMesh-CaseProbe-${randomUUID()}`;
    probePath = path.join(realRoot, probeName);
    const alternatePath = path.join(realRoot, probeName.toLocaleLowerCase("en-US"));
    const descriptor = openSync(probePath, "wx");
    try {
      writeFileSync(descriptor, randomUUID(), "utf8");
    } finally {
      closeSync(descriptor);
    }

    try {
      const original = statSync(probePath);
      const alternate = statSync(alternatePath);
      const sameIdentity =
        (original.dev !== 0 || original.ino !== 0) &&
        original.dev === alternate.dev &&
        original.ino === alternate.ino;
      const sameRealPath = realpathSync(probePath) === realpathSync(alternatePath);
      return { caseSensitive: !(sameIdentity || sameRealPath), warning: null };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { caseSensitive: true, warning: null };
      }
      throw error;
    }
  } catch (error) {
    return {
      caseSensitive: true,
      warning: `Could not probe workspace path case sensitivity; using case-sensitive keys: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    if (probePath) {
      try {
        unlinkSync(probePath);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          // Cleanup failure is reported on stderr because stdout is reserved for MCP frames.
          console.error(
            `[ContextMesh] Could not remove case-sensitivity probe ${probePath}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }
}

export function normalizePathKey(value: string, caseSensitive: boolean): string {
  const normalized = path.resolve(value).normalize("NFC").replaceAll("\\", "/");
  return caseSensitive ? normalized : normalized.toLocaleLowerCase("en-US");
}

export function normalizeRelativePath(value: string, caseSensitive: boolean): string {
  const normalized = value.normalize("NFC").replaceAll("\\", "/").replace(/^\.\//, "");
  return caseSensitive ? normalized : normalized.toLocaleLowerCase("en-US");
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 3));
}

export function tokenizeIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.#/\\:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

export function buildFtsQuery(value: string): string | null {
  const terms = value
    .normalize("NFC")
    .split(/[^\p{L}\p{N}_$]+/u)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 20);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" OR ");
}

export function clampText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

export function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}
