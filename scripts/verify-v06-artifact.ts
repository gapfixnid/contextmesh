import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  v04CanonicalSourceEvidenceOrArchive,
  v04CommitSourceEvidence,
  v04SourceDifferencePaths,
  type V04SourceEvidence,
} from "./v04-artifact-contract.js";

interface Artifact {
  schemaVersion: number;
  release: string;
  fixture: {
    id: string;
    digest: string;
    caseCount: number;
    immutable: boolean;
  };
  source: V04SourceEvidence;
  runs: number;
  deterministic: boolean;
  signatures: string[];
  metrics: {
    expectedResolved: number;
    actualResolved: number;
    truePositive: number;
    falsePositive: number;
    falseNegative: number;
    precision: number;
    recall: number;
  };
  thresholds: {
    minimumCases: number;
    deterministicRuns: number;
    resolvedPrecision: number;
    resolvedRecall: number;
  };
  caseResults: Array<{ id: string; passed: boolean }>;
  passed: boolean;
}

const PINNED_FIXTURE_DIGEST = "dbb39a2900f5730ed1d13c5967648fed7e11ab1ffd818c0a8bdd5f99d7ac134f";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : null;
}

function artifactPath(): string {
  return path.resolve(argument("--artifact") ?? path.join("artifacts", "v06-boundary-impact.json"));
}

function minimumRuns(artifact: Artifact): number {
  const raw = argument("--minimum-runs");
  if (!raw) return artifact.thresholds.deterministicRuns;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
    throw new Error("V06_ARTIFACT_INVALID: --minimum-runs must be an integer from 1 to 20");
  }
  return value;
}

function sameSource(left: V04SourceEvidence, right: V04SourceEvidence): boolean {
  return left.contract === right.contract &&
    left.treeDigest === right.treeDigest &&
    left.files === right.files &&
    left.headCommit === right.headCommit &&
    left.headTreeDigest === right.headTreeDigest &&
    left.dirty === right.dirty;
}

const target = artifactPath();
if (!existsSync(target)) throw new Error(`V06_ARTIFACT_MISSING: ${target}`);
const sourceText = readFileSync(target, "utf8");
const artifact = JSON.parse(sourceText) as Artifact;
if (sourceText.replaceAll("\r\n", "\n") !== `${JSON.stringify(artifact, null, 2)}\n`) {
  throw new Error("V06_ARTIFACT_INVALID: artifact JSON is not canonical formatted output");
}
const requiredRuns = minimumRuns(artifact);
if (
  artifact.schemaVersion !== 1 ||
  artifact.release !== "v0.6" ||
  artifact.fixture?.id !== "contextmesh-v06-boundary-impact-v2" ||
  artifact.fixture?.digest !== PINNED_FIXTURE_DIGEST ||
  artifact.fixture?.immutable !== true ||
  !Number.isSafeInteger(artifact.fixture.caseCount) ||
  artifact.fixture.caseCount < 11 ||
  artifact.caseResults.length !== artifact.fixture.caseCount ||
  new Set(artifact.caseResults.map((item) => item.id)).size !== artifact.caseResults.length ||
  artifact.caseResults.some((item) => item.passed !== true) ||
  artifact.passed !== true
) {
  throw new Error("V06_ARTIFACT_INVALID: fixture identity, case results, or pass state mismatch");
}
if (
  !Number.isSafeInteger(artifact.runs) ||
  artifact.runs < requiredRuns ||
  artifact.signatures.length !== artifact.runs ||
  artifact.signatures.some((item) => !/^[0-9a-f]{64}$/.test(item)) ||
  new Set(artifact.signatures).size !== 1 ||
  artifact.deterministic !== true
) {
  throw new Error("V06_ARTIFACT_INVALID: deterministic run evidence mismatch");
}
const metrics = artifact.metrics;
if (
  metrics.expectedResolved <= 0 ||
  metrics.actualResolved !== metrics.truePositive ||
  metrics.falsePositive !== 0 ||
  metrics.falseNegative !== 0 ||
  metrics.precision < artifact.thresholds.resolvedPrecision ||
  metrics.recall < artifact.thresholds.resolvedRecall ||
  metrics.precision !== 1 ||
  metrics.recall !== 1
) {
  throw new Error("V06_ARTIFACT_INVALID: exact resolved-boundary precision/recall gate failed");
}
const current = v04CanonicalSourceEvidenceOrArchive(process.cwd());
if (current.dirty) {
  throw new Error(`V06_SOURCE_WORKTREE_DIRTY: ${v04SourceDifferencePaths(process.cwd()).join(", ") || "unknown difference"}`);
}
const historical = process.argv.includes("--historical");
if (existsSync(path.join(process.cwd(), ".git"))) {
  execFileSync("git", ["merge-base", "--is-ancestor", artifact.source.headCommit, "HEAD"], { stdio: "inherit" });
  const committed = v04CommitSourceEvidence(artifact.source.headCommit);
  if (
    committed.treeDigest !== artifact.source.treeDigest ||
    committed.files !== artifact.source.files
  ) {
    throw new Error("V06_ARTIFACT_SOURCE_MISMATCH: evidence does not match its exact source commit");
  }
}
if (!historical && !sameSource(artifact.source, current)) {
  throw new Error("V06_ARTIFACT_SOURCE_MISMATCH: checked evidence does not identify the exact current source");
}
process.stdout.write(`${JSON.stringify({
  artifact: target,
  sourceCommit: artifact.source.headCommit,
  sourceTreeDigest: artifact.source.treeDigest,
  runs: artifact.runs,
  cases: artifact.caseResults.length,
  precision: metrics.precision,
  recall: metrics.recall,
  verified: true,
}, null, 2)}\n`);
