import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ContextMeshApp } from "../src/app.js";
import { buildImpactEnvelope } from "../src/code/impact.js";
import type { CodeEdgeKind, Envelope } from "../src/contracts.js";
import type { TraceResult } from "../src/storage/database.js";
import {
  stableStringify,
  v04CanonicalSourceEvidence,
  v04SourceDifferencePaths,
  type V04SourceEvidence,
} from "./v04-artifact-contract.js";

interface ExpectedTarget {
  qualifiedName: string;
  protocol: string;
  operation: string;
  resource: string;
}

interface FixtureCase {
  id: string;
  sourceQualifiedName: string;
  edgeKind: CodeEdgeKind;
  expectedTargets: ExpectedTarget[];
  expectedUnresolved: {
    kind: string;
    rawName: string;
    minimumCandidates: number;
  } | null;
}

interface Fixture {
  schemaVersion: 1;
  id: string;
  immutable: true;
  description: string;
  provenance: {
    origin: string;
    authoredAgainst: string;
    frozenAt: string;
    mutationPolicy: string;
  };
  thresholds: {
    minimumCases: number;
    deterministicRuns: number;
    resolvedPrecision: number;
    resolvedRecall: number;
  };
  files: Array<{ path: string; content: string }>;
  cases: FixtureCase[];
}

interface ActualTarget extends ExpectedTarget {
  status: string;
  confirmed: boolean;
}

interface CaseResult {
  id: string;
  sourceQualifiedName: string;
  edgeKind: CodeEdgeKind;
  expectedTargets: ExpectedTarget[];
  actualTargets: ActualTarget[];
  unexpectedTargets: ActualTarget[];
  missingTargets: ExpectedTarget[];
  unresolved: {
    expected: FixtureCase["expectedUnresolved"];
    observed: boolean;
    candidateCount: number;
  };
  impactConfirmedTargets: string[];
  passed: boolean;
}

const FIXTURE_PATH = path.join(process.cwd(), "evaluation", "fixtures", "v06-boundary-impact-v1.json");
const PINNED_FIXTURE_DIGEST = "2dba90b9741989283ca665e39bda94f67a650a056372b4976df41a8a07fe8779";

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : null;
}

function runCount(fixture: Fixture): number {
  const raw = argument("--runs");
  if (!raw) return fixture.thresholds.deterministicRuns;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
    throw new Error("V06_INVALID_RUN_COUNT: --runs must be an integer from 1 to 20");
  }
  return value;
}

function outputPath(): string | null {
  const value = argument("--output");
  return value ? path.resolve(value) : null;
}

function sourceEvidence(): V04SourceEvidence {
  const evidence = v04CanonicalSourceEvidence(process.cwd());
  if (evidence.dirty) {
    throw new Error(`V06_SOURCE_WORKTREE_DIRTY: ${v04SourceDifferencePaths(process.cwd()).join(", ") || "unknown difference"}`);
  }
  return evidence;
}

function loadFixture(): Fixture {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
  if (
    fixture.schemaVersion !== 1 ||
    fixture.id !== "contextmesh-v06-boundary-impact-v1" ||
    fixture.immutable !== true ||
    !fixture.provenance?.origin ||
    !fixture.provenance.authoredAgainst ||
    !fixture.provenance.mutationPolicy ||
    fixture.cases.length < fixture.thresholds.minimumCases ||
    digest(fixture) !== PINNED_FIXTURE_DIGEST
  ) {
    throw new Error("V06_FIXTURE_INVALID: immutable fixture identity, count, or digest mismatch");
  }
  if (new Set(fixture.cases.map((item) => item.id)).size !== fixture.cases.length) {
    throw new Error("V06_FIXTURE_INVALID: case ids must be unique");
  }
  const protocols = new Set(fixture.cases.flatMap((item) => item.expectedTargets.map((target) => target.protocol)));
  for (const protocol of ["http", "rpc", "queue", "database"]) {
    if (!protocols.has(protocol)) throw new Error(`V06_FIXTURE_INVALID: missing resolved ${protocol} case`);
  }
  if (!fixture.cases.some((item) => item.id === "queue-fanout" && item.expectedTargets.length >= 2)) {
    throw new Error("V06_FIXTURE_INVALID: queue fan-out case is required");
  }
  for (const kind of ["HTTP_BOUNDARY_CALL", "RPC_BOUNDARY_CALL", "QUEUE_BOUNDARY_PUBLISH", "DATABASE_BOUNDARY_WRITE"]) {
    if (!fixture.cases.some((item) => item.expectedUnresolved?.kind === kind)) {
      throw new Error(`V06_FIXTURE_INVALID: missing unresolved ${kind} case`);
    }
  }
  return fixture;
}

function boundaryTargetKey(target: ExpectedTarget): string {
  return `${target.qualifiedName}\0${target.protocol}\0${target.operation}\0${target.resource}`;
}

function actualTargetKey(target: ActualTarget): string {
  return `${boundaryTargetKey(target)}\0${target.status}\0${target.confirmed ? "1" : "0"}`;
}

function boundaryDetails(details: Record<string, unknown>): {
  protocol: string;
  operation: string;
  resource: string;
} | null {
  if (typeof details.boundaryProtocol !== "string") return null;
  const operation = typeof details.boundaryOperation === "string"
    ? details.boundaryOperation
    : typeof details.boundaryMethod === "string"
      ? details.boundaryMethod
      : null;
  const resource = typeof details.boundaryResource === "string"
    ? details.boundaryResource
    : typeof details.boundaryPath === "string"
      ? details.boundaryPath
      : null;
  return operation && resource ? { protocol: details.boundaryProtocol, operation, resource } : null;
}

async function evaluateOnce(fixture: Fixture): Promise<CaseResult[]> {
  const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v06-evaluation-"));
  for (const file of fixture.files) {
    const absolute = path.join(root, file.path);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.content, "utf8");
  }
  const app = new ContextMeshApp(root);
  try {
    await app.indexWorkspace({ mode: "full" });
    const partitions = [
      app.database.getStoredGraphPartition("non-python"),
      app.database.getStoredGraphPartition("python"),
    ];
    const nodes = partitions.flatMap((partition) => partition.nodes);
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const nodeByQualifiedName = new Map<string, typeof nodes[number]>();
    for (const node of nodes) {
      if (nodeByQualifiedName.has(node.qualifiedName)) {
        throw new Error(`V06_FIXTURE_AMBIGUOUS_SYMBOL: ${node.qualifiedName}`);
      }
      nodeByQualifiedName.set(node.qualifiedName, node);
    }
    const unresolved = app.database.getExistingRelations().unresolved.map((item) => item.reference);
    const results: CaseResult[] = [];

    for (const fixtureCase of fixture.cases) {
      const source = nodeByQualifiedName.get(fixtureCase.sourceQualifiedName);
      if (!source) throw new Error(`V06_FIXTURE_SOURCE_NOT_FOUND: ${fixtureCase.sourceQualifiedName}`);
      const traceEnvelope = await app.traceCode({
        symbolId: source.id,
        direction: "out",
        edgeKinds: [fixtureCase.edgeKind],
        depth: 1,
        limit: 100,
      }) as Envelope<TraceResult>;
      const actualByKey = new Map<string, ActualTarget>();
      for (const edge of traceEnvelope.data.edges) {
        if (edge.sourceId !== source.id || edge.kind !== fixtureCase.edgeKind || edge.status === "rejected") continue;
        const target = nodeById.get(edge.targetId);
        if (!target) continue;
        for (const item of edge.evidence ?? []) {
          if (!item.details) continue;
          const boundary = boundaryDetails(item.details);
          if (!boundary) continue;
          const actual: ActualTarget = {
            qualifiedName: target.qualifiedName,
            ...boundary,
            status: edge.status,
            confirmed: edge.status === "resolved" && edge.confidence >= 0.9,
          };
          actualByKey.set(boundaryTargetKey(actual), actual);
        }
      }
      const actualTargets = [...actualByKey.values()].sort((left, right) => actualTargetKey(left).localeCompare(actualTargetKey(right)));
      const expectedKeys = new Set(fixtureCase.expectedTargets.map(boundaryTargetKey));
      const actualKeys = new Set(actualTargets.map(boundaryTargetKey));
      const unexpectedTargets = actualTargets.filter((item) => !expectedKeys.has(boundaryTargetKey(item)));
      const missingTargets = fixtureCase.expectedTargets.filter((item) => !actualKeys.has(boundaryTargetKey(item)));
      const unresolvedMatches = unresolved.filter((item) =>
        item.sourceNodeId === source.id &&
        item.kind === fixtureCase.expectedUnresolved?.kind &&
        item.rawName === fixtureCase.expectedUnresolved?.rawName);
      const candidateCount = Math.max(0, ...unresolvedMatches.map((item) => item.candidates.length));
      const unresolvedObserved = fixtureCase.expectedUnresolved
        ? unresolvedMatches.length > 0 && candidateCount >= fixtureCase.expectedUnresolved.minimumCandidates
        : unresolved.filter((item) => item.sourceNodeId === source.id && /_BOUNDARY_/.test(item.kind)).length === 0;
      const impact = buildImpactEnvelope(traceEnvelope, {
        symbolId: source.id,
        direction: "out",
        edgeKinds: [fixtureCase.edgeKind],
        depth: 1,
        limit: 100,
        tokenBudget: 8000,
      });
      const impactConfirmedTargets = impact.data.affected
        .filter((item) => item.confirmed && item.boundaries.length > 0)
        .map((item) => item.qualifiedName)
        .sort();
      const expectedQualifiedNames = fixtureCase.expectedTargets.map((item) => item.qualifiedName).sort();
      const impactPassed = stableStringify(impactConfirmedTargets) === stableStringify(expectedQualifiedNames);
      const targetsPassed = unexpectedTargets.length === 0 && missingTargets.length === 0 &&
        actualTargets.every((item) => item.status === "resolved" && item.confirmed);
      results.push({
        id: fixtureCase.id,
        sourceQualifiedName: fixtureCase.sourceQualifiedName,
        edgeKind: fixtureCase.edgeKind,
        expectedTargets: [...fixtureCase.expectedTargets].sort((a, b) => boundaryTargetKey(a).localeCompare(boundaryTargetKey(b))),
        actualTargets,
        unexpectedTargets,
        missingTargets,
        unresolved: {
          expected: fixtureCase.expectedUnresolved,
          observed: unresolvedObserved,
          candidateCount,
        },
        impactConfirmedTargets,
        passed: targetsPassed && unresolvedObserved && impactPassed,
      });
    }
    return results;
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
}

const fixture = loadFixture();
const runs = runCount(fixture);
const source = sourceEvidence();
const runResults: CaseResult[][] = [];
for (let run = 0; run < runs; run += 1) runResults.push(await evaluateOnce(fixture));
const signatures = runResults.map((result) => digest(result));
const caseResults = runResults[0] ?? [];
const expectedResolved = fixture.cases.flatMap((item) => item.expectedTargets).length;
const actualResolved = caseResults.flatMap((item) => item.actualTargets).length;
const truePositive = caseResults.flatMap((item) => item.actualTargets)
  .filter((target) => fixture.cases.some((item) => item.expectedTargets.some((expected) => boundaryTargetKey(expected) === boundaryTargetKey(target))))
  .length;
const falsePositive = Math.max(0, actualResolved - truePositive);
const falseNegative = Math.max(0, expectedResolved - truePositive);
const precision = actualResolved === 0 ? (expectedResolved === 0 ? 1 : 0) : truePositive / actualResolved;
const recall = expectedResolved === 0 ? 1 : truePositive / expectedResolved;
const deterministic = new Set(signatures).size === 1;
const passed = deterministic && caseResults.length === fixture.cases.length && caseResults.every((item) => item.passed) &&
  precision >= fixture.thresholds.resolvedPrecision && recall >= fixture.thresholds.resolvedRecall;
const artifact = {
  schemaVersion: 1,
  release: "v0.6",
  fixture: {
    id: fixture.id,
    digest: PINNED_FIXTURE_DIGEST,
    caseCount: fixture.cases.length,
    immutable: fixture.immutable,
    provenance: fixture.provenance,
  },
  source,
  runner: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  },
  runs,
  deterministic,
  signatures,
  metrics: {
    expectedResolved,
    actualResolved,
    truePositive,
    falsePositive,
    falseNegative,
    precision,
    recall,
  },
  thresholds: fixture.thresholds,
  caseResults,
  passed,
};
const output = outputPath();
if (output) {
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
if (!passed) process.exitCode = 1;
