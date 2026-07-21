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

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid v0.5 artifact: ${message}`);
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
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

interface Artifact {
  schemaVersion: number;
  release: string;
  source: V04SourceEvidence;
  fixture: {
    id: string;
    schemaVersion: number;
    immutable: boolean;
    digest: string;
    caseCount: number;
    thresholds: { precision: number; recall: number };
  };
  semanticFixture: { id: string; schemaVersion: number; immutable: boolean; digest: string; caseCount: number };
  runner: { node: string; platform: string; go: string; rustAnalyzer: string; rustc: string };
  generation: number;
  precisionRevision: number;
  languageResults: Array<{ language: string; falsePositive: number; falseNegative: number; precision: number; recall: number }>;
  caseResults: Array<{ passed: boolean; pathPassed: boolean; unexpectedPaths: unknown[]; missingPaths: unknown[] }>;
  semanticCaseResults: Array<{ passed: boolean; unexpectedEdges: unknown[]; missingEdges: unknown[] }>;
  statusCoverage: string[];
  providerStates: Array<{ provider: string; providerVersion: string; status: string }>;
  providerConformance: Array<{ provider: string; passed: boolean }>;
  providerAbsence: Array<{
    language: string;
    providerState: string;
    expectedBaseDigest: string;
    actualBaseDigest: string;
    exactBaseGraph: boolean;
    preservesBase: boolean;
  }>;
  determinism: { runs: number; identical: boolean; signatures: string[] };
  checks: Record<string, boolean>;
  passed: boolean;
}

const artifactPath = path.resolve(process.argv[2] ?? "artifacts/v05-quality.json");
const sourceText = readFileSync(artifactPath, "utf8");
const artifact = JSON.parse(sourceText) as Artifact;
const canonicalText = `${JSON.stringify(JSON.parse(stableStringify(artifact)), null, 2)}\n`;
requireCondition(sourceText.replaceAll("\r\n", "\n") === canonicalText, "file is not canonical stable JSON");
requireCondition(artifact.schemaVersion === 4, "schemaVersion must be 4");
requireCondition(artifact.release === "v0.5", "release must be v0.5");
requireCondition(artifact.source.contract === V04_SOURCE_CONTRACT, "source contract mismatch");
requireCondition(/^[0-9a-f]{40}$/.test(artifact.source.headCommit), "source commit must be a full SHA");
requireCondition(/^[0-9a-f]{64}$/.test(artifact.source.treeDigest), "source tree digest missing");
requireCondition(artifact.source.treeDigest === artifact.source.headTreeDigest, "measured source did not equal its HEAD tree");
requireCondition(artifact.source.dirty === false, "measurement source was dirty");

if (existsSync(path.join(process.cwd(), ".git"))) {
  execFileSync("git", ["merge-base", "--is-ancestor", artifact.source.headCommit, "HEAD"], { stdio: "inherit" });
  const committed = v04CommitSourceEvidence(artifact.source.headCommit);
  requireCondition(
    committed.treeDigest === artifact.source.treeDigest && committed.files === artifact.source.files,
    "artifact source digest does not match its exact source commit",
  );
  try {
    execFileSync("git", [
      "diff", "--quiet", artifact.source.headCommit, "HEAD", "--", ".",
      ":(exclude)artifacts/**", ":(exclude)evaluation/artifacts/**",
    ]);
  } catch {
    throw new Error("Invalid v0.5 artifact: non-artifact source changed after the evaluated source commit");
  }
  const current = v04SourceEvidence();
  requireCondition(current.dirty === false,
    `current non-artifact source working tree is dirty: ${v04SourceDifferencePaths().join(", ") || "unknown difference"}`);
  requireCondition(
    current.treeDigest === artifact.source.treeDigest && current.files === artifact.source.files,
    "artifact was evaluated from a different source tree",
  );
} else {
  const sourceCommitPath = path.join(process.cwd(), "SOURCE_COMMIT");
  const sourceEvidencePath = path.join(process.cwd(), "SOURCE_EVIDENCE.json");
  requireCondition(existsSync(sourceCommitPath) && existsSync(sourceEvidencePath), "archive source evidence is missing");
  const archiveCommit = readFileSync(sourceCommitPath, "utf8").trim();
  const archiveEvidence = JSON.parse(readFileSync(sourceEvidencePath, "utf8")) as V04SourceEvidence;
  requireCondition(archiveCommit === archiveEvidence.headCommit && archiveEvidence.dirty === false, "archive commit evidence is invalid");
  requireCondition(
    artifact.source.headCommit === archiveCommit &&
    archiveEvidence.contract === artifact.source.contract &&
    archiveEvidence.treeDigest === artifact.source.treeDigest &&
    archiveEvidence.files === artifact.source.files,
    "archive source tree does not match artifact source",
  );
  verifyV04ArchiveSourceManifest(artifact.source);
}

const fixture = JSON.parse(readFileSync(path.join(process.cwd(), "evaluation", "fixtures", "v05-quality-v6.json"), "utf8")) as Record<string, unknown>;
const semanticFixture = JSON.parse(readFileSync(path.join(process.cwd(), "evaluation", "fixtures", "v05-semantic-conformance-v3.json"), "utf8")) as Record<string, unknown>;
requireCondition(artifact.fixture.id === "contextmesh-v05-tier1-resolved-edge-v6" && artifact.fixture.schemaVersion === 6 && artifact.fixture.immutable, "primary fixture identity mismatch");
requireCondition(artifact.semanticFixture.id === "contextmesh-v05-semantic-conformance-v3" && artifact.semanticFixture.schemaVersion === 3 && artifact.semanticFixture.immutable, "semantic fixture identity mismatch");
requireCondition(artifact.fixture.digest === canonicalDigest(fixture), "primary fixture digest mismatch");
requireCondition(artifact.semanticFixture.digest === canonicalDigest(semanticFixture), "semantic fixture digest mismatch");
requireCondition(artifact.fixture.caseCount === (fixture.cases as unknown[]).length, "primary fixture case count mismatch");
requireCondition(artifact.semanticFixture.caseCount === (semanticFixture.cases as unknown[]).length, "semantic fixture case count mismatch");

requireCondition(/^v\d+\.\d+\.\d+$/.test(artifact.runner.node), "Node runtime identity missing");
requireCondition(Boolean(artifact.runner.platform), "platform identity missing");
requireCondition(/^go version go\d+\.\d+(?:\.\d+)?\s/.test(artifact.runner.go), "Go runtime identity missing");
const rustAnalyzerIdentity = artifact.runner.rustAnalyzer.match(/^rust-analyzer (\d+\.\d+\.\d+) \(([0-9a-f]{7,}) \d{4}-\d{2}-\d{2}\)$/);
const rustcIdentity = artifact.runner.rustc.match(/^rustc (\d+\.\d+\.\d+) \(([0-9a-f]{8,}) \d{4}-\d{2}-\d{2}\)$/);
requireCondition(Boolean(rustAnalyzerIdentity && rustcIdentity && rustAnalyzerIdentity[1] === rustcIdentity[1]
  && rustcIdentity[2]!.startsWith(rustAnalyzerIdentity[2]!)), "rust-analyzer provenance does not match the pinned Rust toolchain");
requireCondition(Number.isSafeInteger(artifact.generation) && artifact.generation > 0, "generation must be positive");
requireCondition(Number.isSafeInteger(artifact.precisionRevision) && artifact.precisionRevision > 0, "precision revision must be positive");
requireCondition(artifact.languageResults.length === 4, "four Tier 1 language results are required");
requireCondition(new Set(artifact.languageResults.map((item) => item.language)).size === 4, "Tier 1 language results must be unique");
requireCondition(artifact.languageResults.every((item) =>
  item.falsePositive === 0 && item.falseNegative === 0 &&
  item.precision >= artifact.fixture.thresholds.precision && item.recall >= artifact.fixture.thresholds.recall), "Tier 1 quality threshold failed");
requireCondition(artifact.caseResults.length === artifact.fixture.caseCount && artifact.caseResults.every((item) =>
  item.passed && item.pathPassed && item.unexpectedPaths.length === 0 && item.missingPaths.length === 0), "primary fixture paths failed");
requireCondition(artifact.semanticCaseResults.length === artifact.semanticFixture.caseCount && artifact.semanticCaseResults.every((item) =>
  item.passed && item.unexpectedEdges.length === 0 && item.missingEdges.length === 0), "semantic conformance paths failed");
requireCondition(stableStringify(artifact.statusCoverage) === stableStringify(["candidate", "rejected", "resolved"]), "edge status coverage mismatch");

const expectedAbsenceLanguages = ["go", "python", "rust", "typescript"];
requireCondition(artifact.providerAbsence.length === 4, "four provider-absence runs are required");
requireCondition(stableStringify(artifact.providerAbsence.map((item) => item.language).sort()) === stableStringify(expectedAbsenceLanguages), "provider-absence languages mismatch");
requireCondition(artifact.providerAbsence.every((item) =>
  item.providerState === "not_configured" && item.preservesBase && item.exactBaseGraph &&
  /^[0-9a-f]{64}$/.test(item.expectedBaseDigest) && item.expectedBaseDigest === item.actualBaseDigest), "provider absence did not preserve the exact base graph");
requireCondition(artifact.providerConformance.length >= 2 && artifact.providerConformance.every((item) => item.passed), "provider conformance failed");
requireCondition(["typescript_type_checker", "contextmesh_python_resolver", "go_types", "rust_analyzer"].every((provider) =>
  artifact.providerStates.some((state) => state.provider === provider && (state.status === "ready" || state.status === "partial"))), "required provider state is unhealthy");
const goState = artifact.providerStates.find((state) => state.provider === "go_types");
const runnerGo = artifact.runner.go.match(/^go version (go\d+\.\d+(?:\.\d+)?)/)?.[1];
requireCondition(Boolean(goState && runnerGo && goState.providerVersion.endsWith(`+${runnerGo}`)), "Go provider provenance does not match the local runtime");

requireCondition(artifact.determinism.runs === 20 && artifact.determinism.signatures.length === 20, "determinism must contain 20 runs");
requireCondition(artifact.determinism.identical && new Set(artifact.determinism.signatures).size === 1, "graph output is not deterministic");
requireCondition(artifact.determinism.signatures.every((value) => /^[0-9a-f]{64}$/.test(value)), "determinism signature is invalid");
const requiredChecks = [
  "immutableFixturePinned",
  "immutableSemanticFixturePinned",
  "tier1Precision",
  "tier1Recall",
  "noFalsePositives",
  "noFalseNegatives",
  "exactCandidateRejectedResolvedPaths",
  "semanticCallAndInheritanceConformance",
  "semanticProviderConformance",
  "optionalProviderAbsencePreservesBase",
  "providerAbsenceExactBaseFingerprint",
  "twentyRunGraphDeterminism",
  "providerUpdatePreservesGeneration",
  "providerUpdateAdvancesPrecisionRevision",
  "providerStatesHealthy",
  "rustAnalyzerMatchesPinnedToolchain",
];
requireCondition(requiredChecks.every((name) => artifact.checks[name] === true), "one or more mandatory checks are missing or failed");
requireCondition(Object.values(artifact.checks).every((value) => value === true), "one or more recorded checks failed");
requireCondition(artifact.passed === true, "artifact did not pass");
requireFiniteNumbers(artifact);
process.stdout.write(`${JSON.stringify({ artifact: artifactPath, sourceCommit: artifact.source.headCommit, sourceTreeDigest: artifact.source.treeDigest, schemaVersion: artifact.schemaVersion, determinismRuns: artifact.determinism.runs })}\n`);
