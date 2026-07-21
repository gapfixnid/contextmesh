import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ContextMeshApp } from "../src/app.js";
import { probeRustAnalyzerRuntime } from "../src/code/languages/rust-precision.js";
import type { CodeEdgeRecord, CodeNodeRecord, UnresolvedReferenceRecord } from "../src/contracts.js";
import type { StoredGraphPartition } from "../src/storage/database.js";
import {
  stableStringify,
  V04_SOURCE_CONTRACT,
  v04CanonicalSourceEvidence,
  v04SourceDifferencePaths,
  type V04SourceEvidence,
} from "./v04-artifact-contract.js";

type Tier1Language = "typescript" | "python" | "go" | "rust";

interface FixtureFile {
  upstreamPath: string;
  corpusPath: string;
  sha256: string;
}

interface FixtureCase {
  id: string;
  repositoryId: string;
  language: Tier1Language;
  sourceQualifiedName: string;
  sourceStartLine: number;
  expectedCallEdges: Array<{
    target: string;
    targetStartLine: number;
    status: "candidate" | "rejected" | "resolved";
  }>;
  expectedUnresolved?: { rawName: string; minimumCandidates: number };
}

interface ExternalFixture {
  schemaVersion: 4;
  id: string;
  immutable: true;
  description: string;
  frozenAt: string;
  mutationPolicy: string;
  thresholds: { precision: number; recall: number; classificationCoverage: number };
  repositories: Array<{
    id: string;
    repository: string;
    url: string;
    tag: string;
    commit: string;
    license: string;
    profiles: string[];
    files: FixtureFile[];
  }>;
  harness: {
    description: string;
    files: Array<{ path: string; sha256: string; purpose: string }>;
  };
  cases: FixtureCase[];
}

interface CaseResult {
  id: string;
  repositoryId: string;
  language: Tier1Language;
  sourceQualifiedName: string;
  sourceStartLine: number;
  expectedCallEdges: FixtureCase["expectedCallEdges"];
  actualCallEdges: Array<{ target: string; targetStartLine: number; status: string }>;
  missingPaths: FixtureCase["expectedCallEdges"];
  unexpectedPaths: Array<{ target: string; targetStartLine: number; status: string }>;
  expectedUnresolved: FixtureCase["expectedUnresolved"] | null;
  unresolvedObserved: boolean | null;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  pathPassed: boolean;
  classificationPassed: boolean;
  passed: boolean;
}

const FIXTURE_PATH = path.join(process.cwd(), "evaluation", "fixtures", "v051-external-holdout-v4.json");
const CORPUS_ROOT = path.join(process.cwd(), "evaluation", "fixtures", "v051-external-corpus-v1");
const PINNED_FIXTURE_DIGEST = "2f880eeebc580634d1460f14d528e7a2de3c15ef6ffbe072865ea762079a595c";
const LANGUAGES: readonly Tier1Language[] = ["typescript", "python", "go", "rust"];
const REQUIRED_PROFILES = ["complex-src-layout", "generated-code", "large-monorepo", "multi-binary-workspace"];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function fileDigest(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`V051_EXTERNAL_FIXTURE_INVALID: ${message}`);
}

function sourceEvidence(): V04SourceEvidence {
  if (existsSync(path.join(process.cwd(), ".git"))) {
    const evidence = v04CanonicalSourceEvidence();
    if (evidence.dirty) {
      throw new Error(`V051_SOURCE_WORKTREE_DIRTY: ${v04SourceDifferencePaths().join(", ") || "unknown difference"}`);
    }
    return evidence;
  }
  const sourceCommit = readFileSync(path.join(process.cwd(), "SOURCE_COMMIT"), "utf8").trim();
  const evidence = JSON.parse(
    readFileSync(path.join(process.cwd(), "SOURCE_EVIDENCE.json"), "utf8"),
  ) as V04SourceEvidence;
  requireCondition(evidence.contract === V04_SOURCE_CONTRACT, "archive source contract mismatch");
  requireCondition(evidence.headCommit === sourceCommit, "archive source commit mismatch");
  requireCondition(evidence.treeDigest === evidence.headTreeDigest && evidence.dirty === false, "archive source is not clean");
  return evidence;
}

function loadFixture(): ExternalFixture {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as ExternalFixture;
  requireCondition(fixture.schemaVersion === 4, "schema version");
  requireCondition(fixture.id === "contextmesh-v051-external-holdout-v4", "fixture id");
  requireCondition(fixture.immutable === true, "fixture must be immutable");
  requireCondition(digest(fixture) === PINNED_FIXTURE_DIGEST, "fixture digest mismatch");
  requireCondition(fixture.repositories.length === 4, "four repositories are required");
  requireCondition(new Set(fixture.repositories.map((item) => item.id)).size === 4, "repository ids must be unique");
  requireCondition(new Set(fixture.cases.map((item) => item.id)).size === fixture.cases.length, "case ids must be unique");
  requireCondition(
    canonical([...new Set(fixture.repositories.flatMap((item) => item.profiles))].sort()) === canonical(REQUIRED_PROFILES),
    "required repository profiles are missing",
  );
  for (const repository of fixture.repositories) {
    requireCondition(/^[0-9a-f]{40}$/.test(repository.commit), `${repository.id} commit must be full SHA`);
    requireCondition(["MIT", "BSD-3-Clause", "Apache-2.0"].includes(repository.license), `${repository.id} license`);
    requireCondition(repository.files.length >= 3, `${repository.id} must pin at least three files`);
    for (const file of repository.files) {
      const source = path.resolve(CORPUS_ROOT, file.corpusPath);
      requireCondition(source.startsWith(path.resolve(CORPUS_ROOT) + path.sep), `${file.corpusPath} escapes corpus`);
      requireCondition(existsSync(source), `${file.corpusPath} is missing`);
      requireCondition(fileDigest(source) === file.sha256, `${file.corpusPath} digest mismatch`);
    }
  }
  for (const file of fixture.harness.files) {
    const source = path.resolve(CORPUS_ROOT, file.path);
    requireCondition(source.startsWith(path.resolve(CORPUS_ROOT) + path.sep), `${file.path} escapes corpus`);
    requireCondition(existsSync(source) && fileDigest(source) === file.sha256, `${file.path} harness digest mismatch`);
  }
  for (const language of LANGUAGES) {
    const cases = fixture.cases.filter((item) => item.language === language);
    requireCondition(cases.length >= 6, `${language} must have at least six cases`);
    requireCondition(cases.some((item) => item.expectedCallEdges.length > 0), `${language} needs resolved gold`);
    requireCondition(cases.some((item) => item.expectedUnresolved), `${language} needs unresolved gold`);
  }
  return fixture;
}

function materializeCorpus(root: string, fixture: ExternalFixture): void {
  const paths = [
    ...fixture.repositories.flatMap((repository) => repository.files.map((file) => file.corpusPath)),
    ...fixture.harness.files.map((file) => file.path),
  ];
  for (const relative of paths) {
    const source = path.join(CORPUS_ROOT, relative);
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

function currentGraph(app: ContextMeshApp): StoredGraphPartition {
  const partitions = [
    app.database.getStoredGraphPartition("non-python"),
    app.database.getStoredGraphPartition("python"),
  ];
  return {
    nodes: partitions.flatMap((partition) => partition.nodes),
    edges: partitions.flatMap((partition) => partition.edges),
    unresolvedReferences: partitions.flatMap((partition) => partition.unresolvedReferences),
  };
}

function edgeKey(edge: { target: string; targetStartLine: number; status: string }): string {
  return `${edge.status}\0${edge.target}\0${edge.targetStartLine}`;
}

function scoreCases(
  fixture: ExternalFixture,
  nodes: CodeNodeRecord[],
  edges: CodeEdgeRecord[],
  unresolved: UnresolvedReferenceRecord[],
): CaseResult[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return fixture.cases.map((item) => {
    const sources = nodes.filter((node) =>
      node.language === item.language &&
      node.qualifiedName === item.sourceQualifiedName &&
      node.startLine === item.sourceStartLine);
    if (sources.length !== 1 || !sources[0]) {
      throw new Error(`V051_EXTERNAL_FIXTURE_MISMATCH: ${item.id} expected one source, found ${sources.length}`);
    }
    const source = sources[0];
    const actualCallEdges = edges
      .filter((edge) => edge.sourceId === source.id && edge.kind === "CALLS")
      .map((edge) => {
        const target = nodeById.get(edge.targetId);
        return {
          target: target?.qualifiedName ?? `missing:${edge.targetId}`,
          targetStartLine: target?.startLine ?? -1,
          status: edge.status ?? "resolved",
        };
      })
      .sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)));
    const expectedKeys = new Set(item.expectedCallEdges.map(edgeKey));
    const actualKeys = new Set(actualCallEdges.map(edgeKey));
    const missingPaths = item.expectedCallEdges.filter((edge) => !actualKeys.has(edgeKey(edge)));
    const unexpectedPaths = actualCallEdges.filter((edge) => !expectedKeys.has(edgeKey(edge)));
    const expectedResolved = item.expectedCallEdges.filter((edge) => edge.status === "resolved");
    const actualResolved = actualCallEdges.filter((edge) => edge.status === "resolved");
    const expectedResolvedKeys = new Set(expectedResolved.map(edgeKey));
    const actualResolvedKeys = new Set(actualResolved.map(edgeKey));
    const truePositive = actualResolved.filter((edge) => expectedResolvedKeys.has(edgeKey(edge))).length;
    const falsePositive = actualResolved.filter((edge) => !expectedResolvedKeys.has(edgeKey(edge))).length;
    const falseNegative = expectedResolved.filter((edge) => !actualResolvedKeys.has(edgeKey(edge))).length;
    const unresolvedMatches = item.expectedUnresolved
      ? unresolved.filter((reference) =>
          reference.sourceNodeId === source.id &&
          reference.rawName === item.expectedUnresolved!.rawName &&
          reference.candidates.length >= item.expectedUnresolved!.minimumCandidates)
      : [];
    const unresolvedObserved = item.expectedUnresolved ? unresolvedMatches.length > 0 : null;
    const pathPassed = missingPaths.length === 0 && unexpectedPaths.length === 0;
    const classificationPassed = item.expectedCallEdges.length > 0 ? pathPassed : unresolvedObserved === true;
    return {
      id: item.id,
      repositoryId: item.repositoryId,
      language: item.language,
      sourceQualifiedName: item.sourceQualifiedName,
      sourceStartLine: item.sourceStartLine,
      expectedCallEdges: item.expectedCallEdges,
      actualCallEdges,
      missingPaths,
      unexpectedPaths,
      expectedUnresolved: item.expectedUnresolved ?? null,
      unresolvedObserved,
      truePositive,
      falsePositive,
      falseNegative,
      pathPassed,
      classificationPassed,
      passed: pathPassed && unresolvedObserved !== false && falsePositive === 0 && falseNegative === 0,
    };
  });
}

function languageResults(results: CaseResult[]) {
  return LANGUAGES.map((language) => {
    const cases = results.filter((item) => item.language === language);
    const truePositive = cases.reduce((sum, item) => sum + item.truePositive, 0);
    const falsePositive = cases.reduce((sum, item) => sum + item.falsePositive, 0);
    const falseNegative = cases.reduce((sum, item) => sum + item.falseNegative, 0);
    const predicted = truePositive + falsePositive;
    const gold = truePositive + falseNegative;
    return {
      language,
      cases: cases.length,
      truePositive,
      falsePositive,
      falseNegative,
      precision: predicted === 0 ? 0 : truePositive / predicted,
      recall: gold === 0 ? 0 : truePositive / gold,
      classifiedCases: cases.filter((item) => item.classificationPassed).length,
      classificationCoverage: cases.filter((item) => item.classificationPassed).length / cases.length,
    };
  });
}

function graphFingerprint(
  graph: StoredGraphPartition,
  cases: CaseResult[],
  providers: ReturnType<typeof providerStateSnapshot>,
  root: string,
): string {
  const byId = new Map(graph.nodes.map((node) => [node.id, {
    language: node.language ?? null,
    ecosystem: node.ecosystem ?? null,
    kind: node.kind,
    nativeKind: node.nativeKind ?? null,
    name: node.name,
    qualifiedName: node.qualifiedName,
    signature: node.signature,
    doc: node.doc,
    isExported: node.isExported,
    startByte: node.startByte,
    endByte: node.endByte,
    startLine: node.startLine,
    startColumn: node.startColumn,
    endLine: node.endLine,
    endColumn: node.endColumn,
    contentHash: node.contentHash,
    metadata: node.metadata,
    analysisLevel: node.analysisLevel ?? null,
  }]));
  const normalizedRoot = root.replaceAll("\\", "/");
  const normalizeValue = (value: unknown): unknown => {
    if (typeof value === "string") {
      const node = byId.get(value);
      if (node) return node;
      let normalized = value.replace(/ws_[0-9a-f-]{36}/gi, "<workspace>");
      for (const variant of [root, normalizedRoot, root.toLowerCase(), normalizedRoot.toLowerCase()]) {
        normalized = normalized.split(variant).join("<fixture>");
      }
      return normalized;
    }
    if (Array.isArray(value)) return value.map(normalizeValue);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "workspaceId" && key !== "generation")
        .map(([key, item]) => [key, normalizeValue(item)]));
    }
    return value;
  };
  const normalized = {
    nodes: [...byId.values()].map(normalizeValue)
      .sort((left, right) => canonical(left).localeCompare(canonical(right))),
    edges: graph.edges.map((edge) => ({
      source: byId.get(edge.sourceId) ?? edge.sourceId,
      target: byId.get(edge.targetId) ?? edge.targetId,
      kind: edge.kind,
      status: edge.status ?? "resolved",
      confidence: edge.confidence,
      resolutionKind: edge.resolutionKind,
      metadata: normalizeValue(edge.metadata),
      evidence: normalizeValue(edge.evidence ?? []),
    })).map(normalizeValue).sort((left, right) => canonical(left).localeCompare(canonical(right))),
    unresolved: graph.unresolvedReferences.map((reference) => ({
      source: reference.sourceNodeId ? byId.get(reference.sourceNodeId) ?? reference.sourceNodeId : null,
      kind: reference.kind,
      rawName: reference.rawName,
      qualifier: reference.qualifier,
      line: reference.line,
      column: reference.column,
      candidates: reference.candidates.map((id) => byId.get(id) ?? id),
      confidence: reference.confidence ?? null,
      evidence: normalizeValue(reference.evidence ?? []),
    })).map(normalizeValue).sort((left, right) => canonical(left).localeCompare(canonical(right))),
    cases: normalizeValue(cases),
    providers: normalizeValue(providers),
  };
  return digest(normalized);
}

function providerStateSnapshot(app: ContextMeshApp, root: string) {
  return app.database.getPrecisionProviderStates().map((state) => ({
    language: state.language,
    provider: state.provider,
    providerVersion: state.providerVersion,
    status: state.status,
    eligibleEdges: state.eligibleEdges,
    resolvedEdges: state.resolvedEdges,
    rejectedEdges: state.rejectedEdges,
    coverage: state.coverage,
    lastError: state.lastError?.split(root).join("<fixture>") ?? null,
  })).sort((left, right) => left.provider.localeCompare(right.provider));
}

function outputPath(): string | null {
  const index = process.argv.indexOf("--output");
  return index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]!) : null;
}

async function runDeterminismChild(): Promise<void> {
  const fixture = loadFixture();
  const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v051-determinism-"));
  const app = new ContextMeshApp(root);
  try {
    materializeCorpus(root, fixture);
    await app.indexWorkspace({ mode: "full" });
    const graph = currentGraph(app);
    const cases = scoreCases(fixture, graph.nodes, graph.edges, graph.unresolvedReferences);
    const providers = providerStateSnapshot(app, root);
    process.stdout.write(`${JSON.stringify({ signature: graphFingerprint(graph, cases, providers, root) })}\n`);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

async function runEvaluation(): Promise<void> {
  const fixture = loadFixture();
  const rustAnalyzerRuntime = await probeRustAnalyzerRuntime();
  const rustcVersion = spawnSync("rustc", ["--version"], { encoding: "utf8", windowsHide: true });
  const rustcIdentity = rustcVersion.status === 0 ? rustcVersion.stdout.trim() : "unavailable";
  const analyzerIdentity = rustAnalyzerRuntime.version.match(/^rust-analyzer (\d+\.\d+\.\d+) \(([0-9a-f]{8,}) /);
  const compilerIdentity = rustcIdentity.match(/^rustc (\d+\.\d+\.\d+) \(([0-9a-f]{8,}) /);
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v051-external-"));
  let app: ContextMeshApp | null = null;
  try {
    materializeCorpus(fixtureRoot, fixture);
    app = new ContextMeshApp(fixtureRoot);
    await app.indexWorkspace({ mode: "full" });
    const graph = currentGraph(app);
    const caseResults = scoreCases(fixture, graph.nodes, graph.edges, graph.unresolvedReferences);
    const perLanguage = languageResults(caseResults);
    const providerStates = providerStateSnapshot(app, fixtureRoot);
    const scriptPath = fileURLToPath(import.meta.url);
    const signatures: string[] = [];
    for (let run = 0; run < 20; run += 1) {
      const output = execFileSync(
        process.execPath,
        ["--import", "tsx", scriptPath, "--determinism-child"],
        { encoding: "utf8", maxBuffer: 1024 * 1024, env: process.env },
      ).trim();
      signatures.push((JSON.parse(output) as { signature: string }).signature);
    }
    const profiles = [...new Set(fixture.repositories.flatMap((item) => item.profiles))].sort();
    const goVersion = spawnSync("go", ["version"], { encoding: "utf8", windowsHide: true });
    const checks = {
      immutableFixturePinned: digest(fixture) === PINNED_FIXTURE_DIGEST,
      externalRepositoryCount: fixture.repositories.length === 4,
      pinnedCommitsAndLicenses: fixture.repositories.every((item) =>
        /^[0-9a-f]{40}$/.test(item.commit) && ["MIT", "BSD-3-Clause", "Apache-2.0"].includes(item.license)),
      repositoryProfilesCovered: canonical(profiles) === canonical(REQUIRED_PROFILES),
      exactUpstreamBytesPinned: fixture.repositories.flatMap((item) => item.files)
        .every((file) => fileDigest(path.join(CORPUS_ROOT, file.corpusPath)) === file.sha256),
      harnessBytesPinned: fixture.harness.files
        .every((file) => fileDigest(path.join(CORPUS_ROOT, file.path)) === file.sha256),
      languageCaseMinimums: LANGUAGES.every((language) =>
        fixture.cases.filter((item) => item.language === language).length >= 6),
      precisionThreshold: perLanguage.every((item) => item.precision >= fixture.thresholds.precision),
      recallThreshold: perLanguage.every((item) => item.recall >= fixture.thresholds.recall),
      classificationCoverageThreshold: perLanguage.every((item) =>
        item.classificationCoverage >= fixture.thresholds.classificationCoverage),
      exactGoldPaths: caseResults.every((item) => item.pathPassed),
      explicitUnresolvedObserved: caseResults.filter((item) => item.expectedUnresolved)
        .every((item) => item.unresolvedObserved === true),
      generatedGoEvidence: caseResults.filter((item) => item.id.includes("generated"))
        .every((item) => item.passed),
      twentyRunDeterminism: signatures.length === 20 && new Set(signatures).size === 1,
      providersHealthy: ["typescript_type_checker", "contextmesh_python_resolver", "go_types", "rust_analyzer"].every((provider) =>
        providerStates.some((state) => state.provider === provider && ["ready", "partial"].includes(state.status))),
      rustAnalyzerMatchesPinnedToolchain: Boolean(analyzerIdentity && compilerIdentity &&
        analyzerIdentity[1] === compilerIdentity[1] && compilerIdentity[2]!.startsWith(analyzerIdentity[2]!)),
    };
    const artifact = {
      schemaVersion: 1,
      release: "v0.5.1",
      source: sourceEvidence(),
      fixture: {
        id: fixture.id,
        schemaVersion: fixture.schemaVersion,
        immutable: fixture.immutable,
        digest: digest(fixture),
        repositoryCount: fixture.repositories.length,
        fileCount: fixture.repositories.reduce((sum, item) => sum + item.files.length, 0),
        caseCount: fixture.cases.length,
        profiles,
        thresholds: fixture.thresholds,
        repositories: fixture.repositories.map((item) => ({
          id: item.id,
          repository: item.repository,
          tag: item.tag,
          commit: item.commit,
          license: item.license,
          fileCount: item.files.length,
        })),
      },
      runner: {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        go: goVersion.status === 0 ? goVersion.stdout.trim() : "unavailable",
        rustAnalyzer: rustAnalyzerRuntime.version,
        rustc: rustcIdentity,
      },
      generation: app.database.getWorkspace().currentGeneration,
      precisionRevision: app.database.getPrecisionRevision(),
      languageResults: perLanguage,
      caseResults,
      providerStates,
      determinism: {
        scope: "20 fresh Node processes with independent application, database, and materialized workspace instances",
        runs: signatures.length,
        identical: new Set(signatures).size === 1,
        signatures,
      },
      checks,
      passed: Object.values(checks).every(Boolean) && caseResults.every((item) => item.passed),
    };
    const text = `${JSON.stringify(JSON.parse(stableStringify(artifact)), null, 2)}\n`;
    const target = outputPath();
    if (target) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text, "utf8");
    }
    process.stdout.write(target
      ? `${JSON.stringify({ output: target, release: artifact.release, passed: artifact.passed })}\n`
      : text);
    if (!artifact.passed) {
      throw new Error(`v0.5.1 external holdout failed: ${Object.entries(checks)
        .filter(([, passed]) => !passed).map(([name]) => name).join(", ")}`);
    }
  } finally {
    await app?.close();
    rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

if (process.argv.includes("--determinism-child")) await runDeterminismChild();
else await runEvaluation();
