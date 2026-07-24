import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  stableStringify,
  v04CanonicalSourceEvidenceOrArchive,
  v04SourceDifferencePaths,
  type V04SourceEvidence,
} from "./v04-artifact-contract.js";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : null;
}
const artifactPath = path.resolve(argument("--artifact") ?? path.join("artifacts", "v07-memory-validation.json"));
if (!existsSync(artifactPath)) throw new Error(`V07_ARTIFACT_MISSING: ${artifactPath}`);
const text = readFileSync(artifactPath, "utf8");
const artifact = JSON.parse(text) as {
  schemaVersion: number; release: string;
  fixture: { id: string; digest: string; caseCount: number; immutable: boolean };
  source: V04SourceEvidence; runs: number; orderedSignatures: string[];
  metrics: Record<string, number>; thresholds: Record<string, number>;
  probes: {
    maintenanceCursor: { failures: number; checked: number; expected: number };
    migration: { failures: number; state: string; leaked: boolean };
    semanticBackend: string;
  };
  caseResults: Array<{ id: string; passed: boolean }>; auditSignature: string; passed: boolean;
};
if (text.replaceAll("\r\n", "\n") !== `${JSON.stringify(artifact, null, 2)}\n`) {
  throw new Error("V07_ARTIFACT_INVALID: non-canonical JSON formatting");
}
const fixture = JSON.parse(readFileSync(
  path.join(process.cwd(), "evaluation", "fixtures", "v07-memory-validation-v1.json"), "utf8",
)) as unknown;
const fixtureDigest = createHash("sha256").update(stableStringify(fixture)).digest("hex");
if (artifact.schemaVersion !== 1 || artifact.release !== "v0.7" ||
    artifact.fixture.id !== "contextmesh-v07-memory-validation-v1" ||
    artifact.fixture.digest !== fixtureDigest || artifact.fixture.caseCount !== 16 ||
    artifact.fixture.immutable !== true || artifact.caseResults.length !== 16 ||
    new Set(artifact.caseResults.map((item) => item.id)).size !== 16 ||
    artifact.probes?.maintenanceCursor?.failures !== 0 ||
    artifact.probes?.maintenanceCursor?.checked !== 1001 ||
    artifact.probes?.maintenanceCursor?.expected !== 1001 ||
    artifact.probes?.migration?.failures !== 0 ||
    artifact.probes?.migration?.state !== "stale" ||
    artifact.probes?.migration?.leaked !== false ||
    artifact.probes?.semanticBackend !== "deterministic-integration" ||
    artifact.metrics.maintenanceCursorFailures !== 0 ||
    artifact.caseResults.some((item) => !item.passed) || artifact.passed !== true) {
  throw new Error("V07_ARTIFACT_INVALID: fixture or case contract mismatch");
}
if (artifact.runs !== 20 || artifact.orderedSignatures.length !== 20 ||
    artifact.orderedSignatures.some((signature) => !/^[0-9a-f]{64}$/.test(signature)) ||
    new Set(artifact.orderedSignatures).size !== 1 ||
    !/^[0-9a-f]{64}$/.test(artifact.auditSignature)) {
  throw new Error("V07_ARTIFACT_INVALID: deterministic signature mismatch");
}
for (const [key, threshold] of Object.entries(artifact.thresholds)) {
  if (key === "deterministicRuns") continue;
  const value = artifact.metrics[key];
  const zeroMaximum = key.includes("Leak") || key.includes("False") || key.includes("Mismatch") || key.includes("Failures");
  if (value === undefined || (zeroMaximum ? value > threshold : value < threshold)) {
    throw new Error(`V07_ARTIFACT_INVALID: threshold failed for ${key}`);
  }
}
const current = v04CanonicalSourceEvidenceOrArchive(process.cwd());
if (current.dirty) {
  throw new Error(`V07_SOURCE_WORKTREE_DIRTY: ${v04SourceDifferencePaths(process.cwd()).join(", ") || "unknown difference"}`);
}
if (stableStringify(current) !== stableStringify(artifact.source)) {
  throw new Error("V07_ARTIFACT_SOURCE_MISMATCH");
}
process.stdout.write(`${JSON.stringify({
  artifact: artifactPath,
  sourceCommit: artifact.source.headCommit,
  runs: artifact.runs,
  cases: artifact.caseResults.length,
  signature: artifact.orderedSignatures[0],
  verified: true,
}, null, 2)}\n`);
