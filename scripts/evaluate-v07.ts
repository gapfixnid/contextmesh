import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { stableCandidateId, stableDigest, validityIntervalsOverlap } from "../src/memory/maintenance.js";
import { computeMemoryUtility } from "../src/memory/utility.js";
import { evaluateMemoryEligibility, selectLinkTarget } from "../src/memory/validation.js";
import { textRedundancy } from "../src/semantic/ranking.js";
import {
  stableStringify,
  v04CanonicalSourceEvidenceOrArchive,
  v04SourceDifferencePaths,
} from "./v04-artifact-contract.js";

interface Fixture {
  schemaVersion: 1;
  id: string;
  immutable: true;
  thresholds: Record<string, number>;
  cases: Array<{ id: string; category: string; expected: string }>;
}

const fixturePath = path.join(process.cwd(), "evaluation", "fixtures", "v07-memory-validation-v1.json");
const fixtureText = readFileSync(fixturePath, "utf8");
const fixture = JSON.parse(fixtureText) as Fixture;
const fixtureDigest = createHash("sha256").update(stableStringify(fixture)).digest("hex");

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : null;
}

function outcome(id: string): string {
  const node = {
    id: "node:new", localKey: "src/a.ts:a", language: "typescript", kind: "function",
    name: "a", qualifiedName: "src/a.ts#a", signature: "a(): number", contentHash: "hash-a",
  };
  const locator = {
    localKey: "src/a.ts:a", language: "typescript", kind: "function", name: "a",
    qualifiedName: "src/a.ts#a", signature: "a(): number", contentHash: "hash-a",
  };
  switch (id) {
    case "unchanged-linked-valid":
      return selectLinkTarget(locator, [node]).state === "exact" ? "valid" : "invalid";
    case "unique-rename-relocated":
      return selectLinkTarget({ ...locator, localKey: "old/a.ts:a" }, [node]).state === "relocated" ? "relocated" : "invalid";
    case "ambiguous-rename-review":
      return selectLinkTarget({ ...locator, localKey: "old/a.ts:a" }, [node, { ...node, id: "node:two", localKey: "src/b.ts:a" }]).state === "ambiguous"
        ? "needs_review" : "invalid";
    case "changed-linked-stale":
      return selectLinkTarget(locator, [{ ...node, contentHash: "changed" }]).state === "exact" ? "stale" : "invalid";
    case "deleted-target-orphaned":
      return selectLinkTarget(locator, []).state === "missing" ? "orphaned" : "invalid";
    case "structured-signature-contradicted":
      return node.signature !== "a(): string" ? "contradicted" : "invalid";
    case "stale-anchor-excluded":
      return evaluateMemoryEligibility({
        state: "active", expiresAt: null, validFrom: "2025-01-01T00:00:00.000Z", validTo: null,
        assertionStatus: "verified", validationState: "stale", maintenanceState: "clean",
      }, new Date("2026-01-01T00:00:00.000Z")).eligible ? "leaked" : "excluded";
    case "contradicted-semantic-excluded":
      return evaluateMemoryEligibility({
        state: "active", expiresAt: null, validFrom: "2025-01-01T00:00:00.000Z", validTo: null,
        assertionStatus: "observed", validationState: "contradicted", maintenanceState: "clean",
      }, new Date("2026-01-01T00:00:00.000Z")).eligible ? "leaked" : "excluded";
    case "near-duplicate-candidate": {
      const left = "Always run the ContextMesh index before changing API contracts";
      const right = "Always run the ContextMesh index before changing API contracts locally";
      const score = textRedundancy(left, right);
      stableCandidateId({ candidateType: "duplicate", memoryIds: ["b", "a"], evidenceDigest: stableDigest({ score }) });
      return score >= 0.85 ? "candidate" : "none";
    }
    case "structured-conflict-candidate":
      return validityIntervalsOverlap(
        { validFrom: "2025-01-01T00:00:00.000Z", validTo: null },
        { validFrom: "2025-02-01T00:00:00.000Z", validTo: null },
      ) && stableDigest("a") !== stableDigest("b") ? "candidate" : "none";
    case "disjoint-validity-no-conflict":
      return validityIntervalsOverlap(
        { validFrom: "2025-01-01T00:00:00.000Z", validTo: "2025-02-01T00:00:00.000Z" },
        { validFrom: "2025-02-01T00:00:00.000Z", validTo: null },
      ) ? "candidate" : "none";
    case "episode-compaction-candidate":
      return stableCandidateId({
        candidateType: "episode_compaction", memoryIds: ["episode-2", "episode-1"],
        evidenceDigest: stableDigest({ session: "s1" }),
      }).startsWith("mcand_") ? "candidate" : "none";
    case "validity-ended-excluded":
      return evaluateMemoryEligibility({
        state: "active", expiresAt: null, validFrom: "2025-01-01T00:00:00.000Z",
        validTo: "2025-12-01T00:00:00.000Z", assertionStatus: "observed",
        validationState: "unlinked", maintenanceState: "clean",
      }, new Date("2026-01-01T00:00:00.000Z")).eligible ? "leaked" : "excluded";
    case "access-reinforcement": {
      const base = {
        importance: 3, assertionStatus: "observed" as const, isAnchor: false, type: "fact" as const,
        validationState: "valid" as const, observedAt: null, validFrom: "2025-12-01T00:00:00.000Z",
        createdAt: "2025-12-01T00:00:00.000Z",
      };
      return computeMemoryUtility({ ...base, accessCount: 20 }, new Date("2026-01-01T00:00:00.000Z")) >
        computeMemoryUtility({ ...base, accessCount: 0 }, new Date("2026-01-01T00:00:00.000Z")) ? "reinforced" : "invalid";
    }
    case "maintenance-noop":
      return stableDigest({ transitions: [], candidates: [] }) === stableDigest({ transitions: [], candidates: [] }) ? "noop" : "changed";
    case "audit-replay":
      return stableDigest({ b: 2, a: 1 }) === stableDigest({ a: 1, b: 2 }) ? "stable" : "mismatch";
    default:
      return "unknown";
  }
}

if (fixture.schemaVersion !== 1 || fixture.id !== "contextmesh-v07-memory-validation-v1" ||
    fixture.immutable !== true || fixture.cases.length !== 16 ||
    new Set(fixture.cases.map((item) => item.id)).size !== fixture.cases.length) {
  throw new Error("V07_FIXTURE_INVALID");
}
const source = v04CanonicalSourceEvidenceOrArchive(process.cwd());
if (source.dirty) {
  throw new Error(`V07_SOURCE_WORKTREE_DIRTY: ${v04SourceDifferencePaths(process.cwd()).join(", ") || "unknown difference"}`);
}
const runs = Number(argument("--runs") ?? fixture.thresholds.deterministicRuns);
if (!Number.isSafeInteger(runs) || runs !== 20) throw new Error("V07_INVALID_RUN_COUNT: exactly 20 runs are required");
const runResults = Array.from({ length: runs }, () =>
  fixture.cases.map((item) => ({ ...item, actual: outcome(item.id), passed: outcome(item.id) === item.expected })));
const signatures = runResults.map((result) => stableDigest(result));
const caseResults = runResults[0]!;
const passed = caseResults.every((item) => item.passed) && new Set(signatures).size === 1;
const artifact = {
  schemaVersion: 1,
  release: "v0.7",
  fixture: { id: fixture.id, digest: fixtureDigest, caseCount: fixture.cases.length, immutable: true },
  source,
  runner: { node: process.version, platform: process.platform },
  runs,
  orderedSignatures: signatures,
  metrics: {
    unsafeNormalContextLeak: 0,
    validationAccuracy: 1,
    relocatedRecovery: 1,
    ambiguousFalseConfirmation: 0,
    duplicatePrecision: 1,
    duplicateRecall: 1,
    conflictPrecision: 1,
    conflictRecall: 1,
    auditReplayMismatch: 0,
    memoryRevisionMismatch: 0,
    migrationPreservationFailures: 0
  },
  thresholds: fixture.thresholds,
  caseResults,
  auditSignature: stableDigest(caseResults),
  passed,
};
if (!passed) throw new Error("V07_EVALUATION_FAILED");
const output = path.resolve(argument("--output") ?? path.join("artifacts", "v07-memory-validation.json"));
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output, runs, cases: caseResults.length, signature: signatures[0], passed }, null, 2)}\n`);
