import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  expectedNativeRuntime,
  stableStringify,
  V04_ARTIFACT_CONTRACT,
  V04_SOURCE_CONTRACT,
  validateFixedHardwareIdentity,
  v04CommitSourceEvidence,
  v04SourceEvidence,
} from "./v04-artifact-contract.js";

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid v0.4 artifact: ${message}`);
}

function requireFiniteNumbers(value: unknown, keyPath = "artifact"): void {
  if (typeof value === "number") {
    requireCondition(Number.isFinite(value) && value >= 0, `${keyPath} must be finite and non-negative`);
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

interface TimingSummary {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

interface Artifact {
  schemaVersion: number;
  git: { commit: string; baseline: string };
  source: { contract: string; treeDigest: string; files: number; headCommit: string; headTreeDigest: string; dirty: boolean };
  fixtureDigest: string;
  fixtures: Record<string, string>;
  runner: { contract: string; hardwareProfile: string; powerSchemeGuid: string; os: string; cpu: string; logicalCpus: number; ramBytes: number; node: string; rust: string; native: string; mode: string; runtimeNetwork: number };
  measurements: {
    coldFull: Record<string, { timing: TimingSummary }>;
    workloads: Record<string, {
      warm: Record<string, TimingSummary>;
      singleFileIncremental: TimingSummary;
      filesReparsed: number[];
      providerInvocations: { typescriptSyntax: number[]; typescriptPrecision: number[] };
      dbCommit: TimingSummary;
    }>;
    watcherEventToGeneration: TimingSummary;
  };
  parity: {
    nativePortableExactOrdered: boolean;
    nativeDigest: string;
    portableDigest: string;
    crossProcessRuns: number;
    crossProcess: Array<{ nativeDigest: string; portableDigest: string }>;
    crossProcessDeterministic: boolean;
  };
  typeScriptDecision: {
    productionDefault: string;
    productionEndToEnd: { resolvedEdgeQuality: { precision: number; recall: number } };
    compilerProgramTypeChecker: { timing: TimingSummary; counts: { resolvedCalls: number }; scope: string };
    treeSitterBenchmarkOnly: { timing: TimingSummary; precisionReady: boolean; resolvedEdgeQuality: null; hasError: boolean; scope: string };
    decision: string;
  };
  thresholds: Record<string, boolean | number>;
}

const artifactPath = path.resolve(process.argv[2] ?? "artifacts/v04-performance.json");
const source = readFileSync(artifactPath, "utf8");
const artifact = JSON.parse(source) as Artifact;
const canonicalSource = stableStringify(artifact);
requireCondition(
  source === `${canonicalSource}\n` || source === `${canonicalSource}\r\n`,
  "file is not canonical stable JSON",
);
requireCondition(artifact.schemaVersion === 4, "schemaVersion must be 4");
requireCondition(artifact.git.baseline === "e37977199e231fc95b581e6254003941b8f447b2", "baseline mismatch");
requireCondition(/^[0-9a-f]{40}$/.test(artifact.git.commit), "source commit must be a full SHA");
requireCondition(artifact.source.headCommit === artifact.git.commit, "measured source HEAD does not match git.commit");
requireCondition(artifact.source.dirty === false, "canonical measurement source was dirty");
requireCondition(artifact.source.treeDigest === artifact.source.headTreeDigest, "measured working source did not equal its HEAD tree");
requireCondition(artifact.source.contract === V04_SOURCE_CONTRACT, "source contract mismatch");
requireCondition(/^[0-9a-f]{64}$/.test(artifact.source.treeDigest), "source tree digest missing");
if (existsSync(path.join(process.cwd(), ".git"))) {
  execFileSync("git", ["merge-base", "--is-ancestor", artifact.git.commit, "HEAD"], { stdio: "inherit" });
  const committedSource = v04CommitSourceEvidence(artifact.git.commit);
  requireCondition(
    artifact.source.treeDigest === committedSource.treeDigest && artifact.source.files === committedSource.files,
    "artifact source digest does not match its exact source commit",
  );
  try {
    execFileSync("git", [
      "diff", "--quiet", artifact.git.commit, "HEAD", "--", ".",
      ":(exclude)artifacts/**", ":(exclude)evaluation/artifacts/**",
    ]);
  } catch {
    throw new Error("Invalid v0.4 artifact: non-artifact source changed after the measured source commit");
  }
  const currentSource = v04SourceEvidence();
  requireCondition(
    artifact.source.treeDigest === currentSource.treeDigest && artifact.source.files === currentSource.files,
    "artifact was measured from a different source tree",
  );
  requireCondition(currentSource.dirty === false, "current non-artifact source working tree is dirty");
} else {
  const sourceCommitPath = path.join(process.cwd(), "SOURCE_COMMIT");
  const sourceEvidencePath = path.join(process.cwd(), "SOURCE_EVIDENCE.json");
  requireCondition(existsSync(sourceCommitPath) && existsSync(sourceEvidencePath), "archive source evidence is missing");
  const archiveCommit = readFileSync(sourceCommitPath, "utf8").trim();
  const archiveEvidence = JSON.parse(readFileSync(sourceEvidencePath, "utf8")) as Artifact["source"];
  requireCondition(archiveCommit === archiveEvidence.headCommit && archiveEvidence.dirty === false, "archive commit evidence is invalid");
  requireCondition(
    artifact.source.headCommit === archiveCommit &&
    archiveEvidence.contract === artifact.source.contract &&
    archiveEvidence.treeDigest === artifact.source.treeDigest &&
    archiveEvidence.files === artifact.source.files,
    "archive source tree does not match artifact source",
  );
}
requireCondition(/^[0-9a-f]{64}$/.test(artifact.fixtureDigest), "fixture digest missing");
requireCondition(artifact.runner.contract === V04_ARTIFACT_CONTRACT, "runner contract mismatch");
requireCondition(Boolean(artifact.runner.os && artifact.runner.cpu && artifact.runner.node && artifact.runner.rust), "runner identity incomplete");
requireCondition(artifact.runner.runtimeNetwork === 0 && artifact.runner.mode === "sidecar", "runtime mode/network policy mismatch");
validateFixedHardwareIdentity(artifact.runner);
requireCondition(artifact.runner.native === expectedNativeRuntime(), "native runtime does not match the graph-kernel handshake version");

for (const label of ["small", "medium", "large"]) {
  requireCondition(artifact.measurements.coldFull[label]?.timing.samples === 5, `${label} cold samples must equal 5`);
  const workload = artifact.measurements.workloads[label];
  requireCondition(workload, `${label} workload missing`);
  requireCondition(workload.warm.search?.samples === 20 && workload.warm.trace?.samples === 20 && workload.warm.explore?.samples === 20, `${label} warm sample counts invalid`);
  requireCondition(workload.singleFileIncremental.samples === 10 && workload.dbCommit.samples === 10, `${label} incremental/commit sample counts invalid`);
  requireCondition(workload.filesReparsed.length === 10 && workload.filesReparsed.every((value) => value === 1), `${label} filesReparsed is not actual one-file accounting`);
  requireCondition(workload.providerInvocations.typescriptSyntax.length === 10
    && workload.providerInvocations.typescriptSyntax.every((value) => value === 0)
    && workload.providerInvocations.typescriptPrecision.every((value) => value === 0), `${label} TypeScript provider isolation failed`);
}

requireCondition(artifact.measurements.watcherEventToGeneration.samples === 20, "watcher must contain 20 real samples");
requireCondition(artifact.measurements.watcherEventToGeneration.p95Ms <= 2_000, "watcher p95 exceeds 2 seconds");
requireCondition(artifact.parity.nativePortableExactOrdered && artifact.parity.nativeDigest === artifact.parity.portableDigest, "native/portable graph parity failed");
requireCondition(artifact.parity.crossProcessRuns === 20 && artifact.parity.crossProcess.length === 20, "cross-process run count must equal 20");
requireCondition(artifact.parity.crossProcessDeterministic
  && artifact.parity.crossProcess.every((item) => item.nativeDigest === artifact.parity.nativeDigest && item.portableDigest === artifact.parity.nativeDigest), "cross-process canonical graph digest mismatch");

const decision = artifact.typeScriptDecision;
requireCondition(decision.productionDefault === "typescript-compiler-ast-plus-shared-program-typechecker", "production TypeScript provider changed");
requireCondition(decision.productionEndToEnd.resolvedEdgeQuality.precision === 1
  && decision.productionEndToEnd.resolvedEdgeQuality.recall === 1, "production TypeScript resolved-edge quality regressed");
requireCondition(decision.compilerProgramTypeChecker.timing.samples === 20
  && decision.compilerProgramTypeChecker.counts.resolvedCalls > 0
  && /createProgram.*getTypeChecker/i.test(decision.compilerProgramTypeChecker.scope), "Compiler Program/TypeChecker probe is not real");
requireCondition(decision.treeSitterBenchmarkOnly.timing.samples === 20
  && decision.treeSitterBenchmarkOnly.precisionReady === false
  && decision.treeSitterBenchmarkOnly.resolvedEdgeQuality === null
  && !decision.treeSitterBenchmarkOnly.hasError, "Tree-sitter benchmark scope/quality declaration invalid");
requireCondition(decision.decision.includes("retain TypeScript Compiler AST"), "provider decision missing");
requireCondition(Object.entries(artifact.thresholds).every(([key, value]) => !key.endsWith("Passed") || value === true), "one or more recorded thresholds failed");
requireFiniteNumbers(artifact);
process.stdout.write(`${JSON.stringify({ artifact: artifactPath, repositoryBase: artifact.git.commit, sourceTreeDigest: artifact.source.treeDigest, sourceTreeCurrent: true, schemaVersion: 4, crossProcessRuns: 20 })}\n`);
