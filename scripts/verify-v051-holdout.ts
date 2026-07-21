import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  stableStringify,
  V04_SOURCE_CONTRACT,
  v04CommitSourceEvidence,
  v04SourceDifferencePaths,
  v04SourceEvidence,
  verifyV04ArchiveSourceManifest,
  type V04SourceEvidence,
} from "./v04-artifact-contract.js";

const FIXTURE_ID = "contextmesh-v051-external-holdout-v3";
const FIXTURE_DIGEST = "e48573c4d8789ea8690cbb7d472cf41f7702a8b6d1c913f040b4ae46f8774ef4";
const REQUIRED_PROFILES = ["complex-src-layout", "generated-code", "large-monorepo", "multi-binary-workspace"];
const REQUIRED_REPOSITORIES = ["kubernetes/client-go", "nrwl/nx", "pallets/flask", "rust-lang/rustlings"];
const REQUIRED_LANGUAGES = ["go", "python", "rust", "typescript"];

interface Artifact {
  schemaVersion: number;
  release: string;
  source: V04SourceEvidence;
  fixture: {
    id: string;
    schemaVersion: number;
    immutable: boolean;
    digest: string;
    repositoryCount: number;
    fileCount: number;
    caseCount: number;
    profiles: string[];
    thresholds: { precision: number; recall: number; classificationCoverage: number };
    repositories: Array<{
      id: string;
      repository: string;
      tag: string;
      commit: string;
      license: string;
      fileCount: number;
    }>;
  };
  runner: { node: string; platform: string; go: string; rustAnalyzer: string; rustc: string };
  generation: number;
  precisionRevision: number;
  languageResults: Array<{
    language: string;
    cases: number;
    truePositive: number;
    falsePositive: number;
    falseNegative: number;
    precision: number;
    recall: number;
    classifiedCases: number;
    classificationCoverage: number;
  }>;
  caseResults: Array<{
    id: string;
    repositoryId: string;
    language: string;
    sourceQualifiedName: string;
    sourceStartLine: number;
    expectedCallEdges: Array<{ target: string; targetStartLine: number; status: string }>;
    actualCallEdges: Array<{ target: string; targetStartLine: number; status: string }>;
    expectedUnresolved: { rawName: string; minimumCandidates: number } | null;
    missingPaths: unknown[];
    unexpectedPaths: unknown[];
    unresolvedObserved: boolean | null;
    pathPassed: boolean;
    classificationPassed: boolean;
    passed: boolean;
  }>;
  providerStates: Array<{ provider: string; status: string; coverage: number }>;
  determinism: { scope: string; runs: number; identical: boolean; signatures: string[] };
  checks: Record<string, boolean>;
  passed: boolean;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid v0.5.1 external holdout artifact: ${message}`);
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function fileDigest(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function normalizedEdges(edges: Array<{ target: string; targetStartLine: number; status: string }>): string {
  return stableStringify([...edges].sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))));
}

function requireFiniteNumbers(value: unknown, keyPath = "artifact"): void {
  if (typeof value === "number") {
    requireCondition(Number.isFinite(value), `${keyPath} must be finite`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => requireFiniteNumbers(item, `${keyPath}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) requireFiniteNumbers(nested, `${keyPath}.${key}`);
  }
}

const artifactPath = path.resolve(process.argv[2] ?? "artifacts/v051-external-holdout.json");
const sourceText = readFileSync(artifactPath, "utf8");
const artifact = JSON.parse(sourceText) as Artifact;
requireCondition(
  sourceText.replaceAll("\r\n", "\n") === `${JSON.stringify(JSON.parse(stableStringify(artifact)), null, 2)}\n`,
  "file is not canonical stable JSON",
);
requireCondition(artifact.schemaVersion === 1 && artifact.release === "v0.5.1", "release identity mismatch");
requireCondition(artifact.source.contract === V04_SOURCE_CONTRACT, "source contract mismatch");
requireCondition(/^[0-9a-f]{40}$/.test(artifact.source.headCommit), "source commit must be a full SHA");
requireCondition(/^[0-9a-f]{64}$/.test(artifact.source.treeDigest), "source tree digest missing");
requireCondition(artifact.source.treeDigest === artifact.source.headTreeDigest, "measured source differed from HEAD");
requireCondition(artifact.source.dirty === false, "measurement source was dirty");

if (existsSync(path.join(process.cwd(), ".git"))) {
  execFileSync("git", ["merge-base", "--is-ancestor", artifact.source.headCommit, "HEAD"], { stdio: "inherit" });
  const committed = v04CommitSourceEvidence(artifact.source.headCommit);
  requireCondition(
    committed.treeDigest === artifact.source.treeDigest && committed.files === artifact.source.files,
    "artifact source digest does not match its exact commit",
  );
  try {
    execFileSync("git", [
      "diff", "--quiet", artifact.source.headCommit, "HEAD", "--", ".",
      ":(exclude)artifacts/**", ":(exclude)evaluation/artifacts/**",
    ]);
  } catch {
    throw new Error("Invalid v0.5.1 external holdout artifact: source changed after evaluation");
  }
  const current = v04SourceEvidence();
  requireCondition(current.dirty === false,
    `current non-artifact source working tree is dirty: ${v04SourceDifferencePaths().join(", ") || "unknown difference"}`);
  requireCondition(
    current.treeDigest === artifact.source.treeDigest && current.files === artifact.source.files,
    "artifact was evaluated from a different source tree",
  );
} else {
  const sourceCommit = readFileSync(path.join(process.cwd(), "SOURCE_COMMIT"), "utf8").trim();
  const archiveEvidence = JSON.parse(
    readFileSync(path.join(process.cwd(), "SOURCE_EVIDENCE.json"), "utf8"),
  ) as V04SourceEvidence;
  requireCondition(sourceCommit === archiveEvidence.headCommit, "archive source commit mismatch");
  requireCondition(
    artifact.source.headCommit === sourceCommit &&
    archiveEvidence.contract === artifact.source.contract &&
    archiveEvidence.treeDigest === artifact.source.treeDigest &&
    archiveEvidence.files === artifact.source.files &&
    archiveEvidence.dirty === false,
    "archive source evidence mismatch",
  );
  verifyV04ArchiveSourceManifest(artifact.source);
}

const fixturePath = path.join(process.cwd(), "evaluation", "fixtures", "v051-external-holdout-v3.json");
const corpusRoot = path.join(process.cwd(), "evaluation", "fixtures", "v051-external-corpus-v1");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  id: string;
  schemaVersion: number;
  immutable: boolean;
  thresholds: Artifact["fixture"]["thresholds"];
  repositories: Array<{
    id: string;
    repository: string;
    tag: string;
    commit: string;
    license: string;
    profiles: string[];
    files: Array<{ corpusPath: string; sha256: string }>;
  }>;
  harness: { files: Array<{ path: string; sha256: string }> };
  cases: Array<{
    id: string;
    repositoryId: string;
    language: string;
    sourceQualifiedName: string;
    sourceStartLine: number;
    expectedCallEdges: Array<{ target: string; targetStartLine: number; status: string }>;
    expectedUnresolved?: { rawName: string; minimumCandidates: number };
  }>;
};
requireCondition(
  fixture.id === FIXTURE_ID && fixture.schemaVersion === 3 && fixture.immutable === true,
  "fixture identity mismatch",
);
requireCondition(canonicalDigest(fixture) === FIXTURE_DIGEST, "fixture digest mismatch");
requireCondition(artifact.fixture.id === FIXTURE_ID && artifact.fixture.digest === FIXTURE_DIGEST, "artifact fixture mismatch");
requireCondition(
  stableStringify(artifact.fixture.thresholds) === stableStringify(fixture.thresholds),
  "quality thresholds differ from the pinned fixture",
);
requireCondition(artifact.fixture.repositoryCount === 4, "four repositories are required");
requireCondition(artifact.fixture.fileCount === fixture.repositories.reduce((sum, item) => sum + item.files.length, 0), "file count mismatch");
requireCondition(artifact.fixture.caseCount === fixture.cases.length && artifact.fixture.caseCount >= 18, "case count mismatch");
requireCondition(
  stableStringify([...artifact.fixture.profiles].sort()) === stableStringify(REQUIRED_PROFILES),
  "repository profile coverage mismatch",
);
requireCondition(
  stableStringify(artifact.fixture.repositories.map((item) => item.repository).sort()) === stableStringify(REQUIRED_REPOSITORIES),
  "repository set mismatch",
);
requireCondition(
  stableStringify(artifact.fixture.repositories) === stableStringify(fixture.repositories.map((item) => ({
    id: item.id,
    repository: item.repository,
    tag: item.tag,
    commit: item.commit,
    license: item.license,
    fileCount: item.files.length,
  }))),
  "repository provenance mismatch",
);
for (const repository of fixture.repositories) {
  for (const file of repository.files) {
    requireCondition(fileDigest(path.join(corpusRoot, file.corpusPath)) === file.sha256, `${file.corpusPath} changed`);
  }
}
for (const file of fixture.harness.files) {
  requireCondition(fileDigest(path.join(corpusRoot, file.path)) === file.sha256, `${file.path} harness changed`);
}

requireCondition(/^v\d+\.\d+\.\d+$/.test(artifact.runner.node), "Node runtime identity missing");
requireCondition(Boolean(artifact.runner.platform), "platform identity missing");
requireCondition(/^go version go1\.23(?:\.\d+)?\s/.test(artifact.runner.go), "Go 1.23 runtime identity missing");
const rustAnalyzerIdentity = artifact.runner.rustAnalyzer.match(/^rust-analyzer (\d+\.\d+\.\d+) \(([0-9a-f]{8,}) \d{4}-\d{2}-\d{2}\)$/);
const rustcIdentity = artifact.runner.rustc.match(/^rustc (\d+\.\d+\.\d+) \(([0-9a-f]{8,}) \d{4}-\d{2}-\d{2}\)$/);
requireCondition(Boolean(rustAnalyzerIdentity && rustcIdentity && rustAnalyzerIdentity[1] === rustcIdentity[1]
  && rustAnalyzerIdentity[2] === rustcIdentity[2]), "rust-analyzer provenance does not match the pinned Rust toolchain");
requireCondition(Number.isSafeInteger(artifact.generation) && artifact.generation > 0, "generation must be positive");
requireCondition(Number.isSafeInteger(artifact.precisionRevision) && artifact.precisionRevision > 0, "precision revision must be positive");
requireCondition(
  stableStringify(artifact.languageResults.map((item) => item.language).sort()) === stableStringify(REQUIRED_LANGUAGES),
  "Tier 1 languages mismatch",
);
requireCondition(artifact.languageResults.every((item) =>
  item.cases >= 6 &&
  item.falsePositive === 0 &&
  item.falseNegative === 0 &&
  item.precision >= artifact.fixture.thresholds.precision &&
  item.recall >= artifact.fixture.thresholds.recall &&
  item.classificationCoverage >= artifact.fixture.thresholds.classificationCoverage &&
  item.classifiedCases === item.cases),
  "language quality threshold failed",
);
requireCondition(artifact.caseResults.length === artifact.fixture.caseCount, "case result count mismatch");
const fixtureCaseById = new Map(fixture.cases.map((item) => [item.id, item]));
requireCondition(new Set(artifact.caseResults.map((item) => item.id)).size === artifact.caseResults.length, "case ids must be unique");
requireCondition(artifact.caseResults.every((item) =>
  (() => {
    const expected = fixtureCaseById.get(item.id);
    return Boolean(expected) &&
      item.repositoryId === expected!.repositoryId &&
      item.language === expected!.language &&
      item.sourceQualifiedName === expected!.sourceQualifiedName &&
      item.sourceStartLine === expected!.sourceStartLine &&
      stableStringify(item.expectedCallEdges) === stableStringify(expected!.expectedCallEdges) &&
      normalizedEdges(item.actualCallEdges) === normalizedEdges(expected!.expectedCallEdges) &&
      stableStringify(item.expectedUnresolved) === stableStringify(expected!.expectedUnresolved ?? null);
  })() &&
  Number.isSafeInteger(item.sourceStartLine) && item.sourceStartLine > 0 &&
  item.pathPassed && item.classificationPassed && item.passed &&
  item.missingPaths.length === 0 && item.unexpectedPaths.length === 0 &&
  item.unresolvedObserved !== false),
  "one or more gold cases failed",
);
requireCondition(
  fixture.cases.every((item) => artifact.caseResults.some((result) => result.id === item.id)),
  "one or more fixture cases are missing",
);
requireCondition(["typescript_type_checker", "contextmesh_python_resolver", "go_types", "rust_analyzer"].every((provider) =>
  artifact.providerStates.some((state) => state.provider === provider && ["ready", "partial"].includes(state.status))),
  "required provider is unhealthy",
);
requireCondition(
  artifact.providerStates.every((state) => Number.isFinite(state.coverage) && state.coverage >= 0 && state.coverage <= 1),
  "provider coverage is invalid",
);
requireCondition(artifact.determinism.runs === 20 && artifact.determinism.signatures.length === 20, "20 runs required");
requireCondition(
  artifact.determinism.scope === "20 fresh Node processes with independent application, database, and materialized workspace instances",
  "determinism scope mismatch",
);
requireCondition(
  artifact.determinism.identical && new Set(artifact.determinism.signatures).size === 1 &&
  artifact.determinism.signatures.every((value) => /^[0-9a-f]{64}$/.test(value)),
  "determinism failed",
);
requireCondition(Object.values(artifact.checks).every(Boolean), "one or more recorded checks failed");
requireCondition(artifact.passed === true, "artifact did not pass");
requireFiniteNumbers(artifact);
process.stdout.write(`${JSON.stringify({
  artifact: artifactPath,
  sourceCommit: artifact.source.headCommit,
  sourceTreeDigest: artifact.source.treeDigest,
  repositories: artifact.fixture.repositoryCount,
  cases: artifact.fixture.caseCount,
  determinismRuns: artifact.determinism.runs,
})}\n`);
