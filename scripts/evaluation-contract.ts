import { createHash } from "node:crypto";

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export interface RankedGateMetric {
  gateGroup: string;
  recall: number;
  reciprocalRank: number;
  ndcg: number;
}

function compareUtf16(left: string, right: string): number {
  const common = Math.min(left.length, right.length);
  for (let index = 0; index < common; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/**
 * Versioned canonical serializer for evaluation artifacts and control-plane
 * fingerprints. It writes properties directly so integer-looking keys cannot
 * be reordered by JavaScript's ordinary object enumeration rules.
 */
export function canonicalControlJson(value: CanonicalJsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON only supports finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalControlJson(entry)).join(",")}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Canonical JSON only supports plain objects");
  }
  const keys = Object.keys(value).sort(compareUtf16);
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalControlJson(value[key]!)}`)
    .join(",")}}`;
}

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizedFixtureDigest(value: Uint8Array): string {
  const normalized = Buffer.from(value).toString("utf8").replace(/\r\n?/gu, "\n");
  return sha256Bytes(Buffer.from(normalized, "utf8"));
}

export function addBaselineDigest<T extends Record<string, CanonicalJsonValue>>(
  artifact: T,
): T & { baselineDigest: string } {
  const payload = Object.fromEntries(
    Object.entries(artifact).filter(([key]) => key !== "baselineDigest"),
  ) as Record<string, CanonicalJsonValue>;
  return {
    ...artifact,
    baselineDigest: sha256Bytes(Buffer.from(canonicalControlJson(payload), "utf8")),
  };
}

export function serializeCanonicalArtifact(value: CanonicalJsonValue): Buffer {
  return Buffer.from(`${canonicalControlJson(value)}\n`, "utf8");
}

export function sourceDateEpochIso(value: string | undefined): string {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer for deterministic artifacts");
  }
  const milliseconds = Number(value) * 1_000;
  if (!Number.isSafeInteger(milliseconds)) throw new Error("SOURCE_DATE_EPOCH is outside the safe range");
  return new Date(milliseconds).toISOString();
}

export function requiredChallengeRecall(baseline: number): number {
  return baseline < 0.75 ? Math.max(0.8, baseline + 0.15) : 0.9;
}

export function requiredNdcg(baseline: number): number {
  return Math.min(1, baseline + 0.08);
}

export function meetsMinimumWithTolerance(actual: number, target: number, tolerance: number): boolean {
  if (![actual, target, tolerance].every(Number.isFinite) || tolerance < 0) return false;
  return actual + tolerance >= target;
}

export function metricsForGateGroup<T extends { gateGroup: string }>(
  metrics: readonly T[],
  gateGroup: string,
): T[] {
  return metrics.filter((metric) => metric.gateGroup === gateGroup);
}

export function runEvaluationContractSelfTest(): void {
  const integerLikeKeys = Object.assign(Object.create(null) as Record<string, CanonicalJsonValue>, {
    "10": "a",
    "2": "b",
    a: "c",
    가: "d",
  });
  const serialized = canonicalControlJson(integerLikeKeys);
  if (serialized !== '{"10":"a","2":"b","a":"c","가":"d"}') {
    throw new Error(`Canonical UTF-16 key ordering failed: ${serialized}`);
  }
  const artifact = addBaselineDigest({ z: 1, a: "fixed" });
  const expected = sha256Bytes(Buffer.from('{"a":"fixed","z":1}', "utf8"));
  if (artifact.baselineDigest !== expected) throw new Error("Non-self-referential baseline digest failed");
  if (serializeCanonicalArtifact(artifact)[0] === 0xef) throw new Error("Canonical artifact must not contain a BOM");
  if (normalizedFixtureDigest(Buffer.from("{\r\n}\r\n")) !== normalizedFixtureDigest(Buffer.from("{\n}\n"))) {
    throw new Error("Fixture digest line-ending normalization failed");
  }
  if (requiredChallengeRecall(0.5) !== 0.8 || requiredChallengeRecall(0.8) !== 0.9) {
    throw new Error("Challenge recall contract failed");
  }
  if (requiredNdcg(0.95) !== 1) throw new Error("nDCG ceiling contract failed");
  if (!meetsMinimumWithTolerance(0.775, 0.8, 0.025) || meetsMinimumWithTolerance(0.774999, 0.8, 0.025)) {
    throw new Error("Minimum threshold tolerance contract failed");
  }
}
