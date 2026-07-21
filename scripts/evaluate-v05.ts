import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContextMeshApp } from "../src/app.js";
import { probeRustAnalyzerRuntime } from "../src/code/languages/rust-precision.js";
import type { CodeEdgeKind, CodeEdgeRecord, CodeNodeRecord, ExtractedGraph, UnresolvedReferenceRecord } from "../src/contracts.js";
import type { StoredGraphPartition } from "../src/storage/database.js";
import {
  stableStringify,
  V04_SOURCE_CONTRACT,
  v04CanonicalSourceEvidence,
  v04SourceDifferencePaths,
  type V04SourceEvidence,
} from "./v04-artifact-contract.js";

type Tier1Language = "typescript" | "python" | "go" | "rust";
type CaseCategory = "positive" | "negative" | "ambiguous";
type CaseSplit = "development" | "holdout";

interface QualityFixture {
  schemaVersion: 6;
  id: string;
  immutable: true;
  description: string;
  provenance: { origin: string; authoredAgainst: string; frozenAt: string; mutationPolicy: string };
  thresholds: { precision: number; recall: number };
  files: Array<{ path: string; content: string }>;
  cases: Array<{
    id: string;
    language: Tier1Language;
    split: CaseSplit;
    category: CaseCategory;
    sourceQualifiedName: string;
    syntaxForm?: string;
    expectedResolvedTargets: string[];
    expectedCallEdges: Array<{ target: string; status: "candidate" | "rejected" | "resolved" }>;
    expectedUnresolved?: { rawName: string; minimumCandidates: number };
  }>;
}

interface CaseResult {
  id: string;
  language: Tier1Language;
  split: CaseSplit;
  category: CaseCategory;
  sourceQualifiedName: string;
  expectedResolvedTargets: string[];
  actualResolvedTargets: string[];
  actualStatuses: string[];
  actualEdges: Array<{ target: string; status: string }>;
  expectedCallEdges: Array<{ target: string; status: string }>;
  unexpectedPaths: Array<{ target: string; status: string }>;
  missingPaths: Array<{ target: string; status: string }>;
  pathPassed: boolean;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  unresolvedObserved: boolean | null;
  unresolvedCandidates: number | null;
  passed: boolean;
}

interface SemanticFixture {
  schemaVersion: 3;
  id: string;
  immutable: true;
  description: string;
  provenance: { origin: string; authoredAgainst: string; frozenAt: string; mutationPolicy: string };
  files: Array<{ path: string; content: string }>;
  cases: Array<{
    id: string;
    language: "python" | "go";
    sourceQualifiedName: string;
    edgeKind: CodeEdgeKind;
    expectedEdges: Array<{
      targetQualifiedName: string;
      targetSignatureIncludes?: string;
      status: "candidate" | "rejected" | "resolved";
    }>;
  }>;
  providerExpectations: Array<{
    provider: string;
    statuses: Array<"ready" | "partial">;
    providerVersionPattern?: string;
    lastErrorIncludes?: string[];
  }>;
}

interface SemanticEdgeResult {
  targetQualifiedName: string;
  targetSignature: string;
  status: string;
}

interface SemanticCaseResult {
  id: string;
  language: "python" | "go";
  sourceQualifiedName: string;
  edgeKind: CodeEdgeKind;
  expectedEdges: SemanticFixture["cases"][number]["expectedEdges"];
  actualEdges: SemanticEdgeResult[];
  unexpectedEdges: SemanticEdgeResult[];
  missingEdges: SemanticFixture["cases"][number]["expectedEdges"];
  passed: boolean;
}

const FIXTURE_PATH = path.join(process.cwd(), "evaluation", "fixtures", "v05-quality-v6.json");
const PINNED_FIXTURE_DIGEST = "b10244eecf79b967a2b55415deded60cc2c6f3e63e44fd699d0373f067338d03";
const SEMANTIC_FIXTURE_PATH = path.join(process.cwd(), "evaluation", "fixtures", "v05-semantic-conformance-v3.json");
const PINNED_SEMANTIC_FIXTURE_DIGEST = "61e3f30443a15f3fa128e304db09cdc5c271443164833f061901ddf54c2d2e52";
const TIER1_LANGUAGES: readonly Tier1Language[] = ["typescript", "python", "go", "rust"];

function evaluationSourceEvidence(root = process.cwd()): V04SourceEvidence {
  if (existsSync(path.join(root, ".git"))) {
    const evidence = v04CanonicalSourceEvidence(root);
    if (evidence.dirty) {
      throw new Error(`V05_SOURCE_WORKTREE_DIRTY: ${v04SourceDifferencePaths(root).join(", ") || "unknown difference"}`);
    }
    return evidence;
  }
  const sourceCommitPath = path.join(root, "SOURCE_COMMIT");
  const sourceEvidencePath = path.join(root, "SOURCE_EVIDENCE.json");
  if (!existsSync(sourceCommitPath) || !existsSync(sourceEvidencePath)) {
    throw new Error("V05_SOURCE_EVIDENCE_MISSING: Git metadata or signed source-archive evidence is required");
  }
  const sourceCommit = readFileSync(sourceCommitPath, "utf8").trim();
  const evidence = JSON.parse(readFileSync(sourceEvidencePath, "utf8")) as V04SourceEvidence;
  if (
    evidence.contract !== V04_SOURCE_CONTRACT ||
    !/^[0-9a-f]{40}$/.test(sourceCommit) ||
    evidence.headCommit !== sourceCommit ||
    !/^[0-9a-f]{64}$/.test(evidence.treeDigest) ||
    evidence.headTreeDigest !== evidence.treeDigest ||
    !Number.isSafeInteger(evidence.files) || evidence.files <= 0 ||
    evidence.dirty !== false
  ) {
    throw new Error("V05_SOURCE_EVIDENCE_INVALID: source-archive evidence does not identify a clean exact source snapshot");
  }
  return evidence;
}

function outputPath(): string | null {
  const index = process.argv.indexOf("--output");
  return index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]!) : null;
}

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

function loadFixture(): QualityFixture {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as QualityFixture;
  if (
    fixture.schemaVersion !== 6 ||
    fixture.id !== "contextmesh-v05-tier1-resolved-edge-v6" ||
    fixture.immutable !== true ||
    !fixture.provenance?.origin ||
    !fixture.provenance.authoredAgainst ||
    !fixture.provenance.mutationPolicy ||
    !Array.isArray(fixture.files) ||
    !Array.isArray(fixture.cases) ||
    digest(fixture) !== PINNED_FIXTURE_DIGEST
  ) {
    throw new Error("V05_FIXTURE_INVALID: immutable fixture identity or digest mismatch");
  }
  if (new Set(fixture.cases.map((item) => item.id)).size !== fixture.cases.length) {
    throw new Error("V05_FIXTURE_INVALID: case ids must be unique");
  }
  for (const language of TIER1_LANGUAGES) {
    const languageCases = fixture.cases.filter((item) => item.language === language);
    if (languageCases.length < 6 || languageCases.some((item) => !Array.isArray(item.expectedCallEdges))) {
      throw new Error(`V05_FIXTURE_INVALID: ${language} must contain at least six exact-path cases`);
    }
    for (const split of ["development", "holdout"] as const) {
      const categories = new Set(languageCases.filter((item) => item.split === split).map((item) => item.category));
      if (categories.size !== 3 || !categories.has("positive") || !categories.has("negative") || !categories.has("ambiguous")) {
        throw new Error(`V05_FIXTURE_INVALID: ${language}/${split} must contain positive, negative, and ambiguous cases`);
      }
    }
  }
  const pythonPositiveCases = fixture.cases.filter((item) => item.language === "python" && item.category === "positive");
  const pythonPositiveForms = new Set(pythonPositiveCases.map((item) => item.syntaxForm));
  if (!pythonPositiveForms.has("single-line-from-import-alias") || !pythonPositiveForms.has("parenthesized-from-import")) {
    throw new Error("V05_FIXTURE_INVALID: Python positive splits must cover distinct single-line alias and parenthesized import forms");
  }
  const parenthesized = pythonPositiveCases.find((item) => item.syntaxForm === "parenthesized-from-import");
  const parenthesizedPath = parenthesized?.sourceQualifiedName.split("#", 1)[0];
  const parenthesizedSource = fixture.files.find((item) => item.path === parenthesizedPath)?.content ?? "";
  if (!/^from\s+[.\w]+\s+import\s*\([\s\S]*?\)/m.test(parenthesizedSource)) {
    throw new Error("V05_FIXTURE_INVALID: parenthesized Python positive must contain a real parenthesized from-import");
  }
  return fixture;
}

function loadSemanticFixture(): SemanticFixture {
  const fixture = JSON.parse(readFileSync(SEMANTIC_FIXTURE_PATH, "utf8")) as SemanticFixture;
  if (
    fixture.schemaVersion !== 3 ||
    fixture.id !== "contextmesh-v05-semantic-conformance-v3" ||
    fixture.immutable !== true ||
    !fixture.provenance?.origin ||
    !fixture.provenance.authoredAgainst ||
    !fixture.provenance.mutationPolicy ||
    !Array.isArray(fixture.files) ||
    !Array.isArray(fixture.cases) ||
    !Array.isArray(fixture.providerExpectations) ||
    digest(fixture) !== PINNED_SEMANTIC_FIXTURE_DIGEST
  ) {
    throw new Error("V05_SEMANTIC_FIXTURE_INVALID: immutable fixture identity or digest mismatch");
  }
  if (new Set(fixture.cases.map((item) => item.id)).size !== fixture.cases.length) {
    throw new Error("V05_SEMANTIC_FIXTURE_INVALID: case ids must be unique");
  }
  const coveredKinds = new Set(fixture.cases.map((item) => item.edgeKind));
  const coveredLanguages = new Set(fixture.cases.map((item) => item.language));
  if (!coveredKinds.has("CALLS") || !coveredKinds.has("EXTENDS") || !coveredLanguages.has("python") || !coveredLanguages.has("go")) {
    throw new Error("V05_SEMANTIC_FIXTURE_INVALID: Python/Go CALLS and EXTENDS coverage is required");
  }
  return fixture;
}

function writeFixture(root: string, fixture: Pick<QualityFixture | SemanticFixture, "files">): void {
  for (const entry of fixture.files) {
    const target = path.resolve(root, entry.path);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`V05_FIXTURE_INVALID: path escapes fixture root (${entry.path})`);
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, entry.content, "utf8");
  }
}

function scoreSemanticCases(
  fixture: SemanticFixture,
  nodes: CodeNodeRecord[],
  edges: CodeEdgeRecord[],
): SemanticCaseResult[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return fixture.cases.map((item) => {
    const sources = nodes.filter((node) =>
      node.language === item.language && node.qualifiedName === item.sourceQualifiedName);
    if (sources.length !== 1 || !sources[0]) {
      throw new Error(`V05_SEMANTIC_FIXTURE_MISMATCH: expected one source node for ${item.id}, found ${sources.length}`);
    }
    const actualEdges = edges
      .filter((edge) => edge.sourceId === sources[0]!.id && edge.kind === item.edgeKind)
      .map((edge) => {
        const target = nodeById.get(edge.targetId);
        return {
          targetQualifiedName: target?.qualifiedName ?? `missing:${edge.targetId}`,
          targetSignature: target?.signature ?? "",
          status: edge.status ?? "resolved",
        };
      })
      .sort((left, right) => canonical(left).localeCompare(canonical(right)));
    const unmatched = [...actualEdges];
    const missingEdges = item.expectedEdges.filter((expected) => {
      const match = unmatched.findIndex((actual) =>
        actual.targetQualifiedName === expected.targetQualifiedName &&
        actual.status === expected.status &&
        (!expected.targetSignatureIncludes || actual.targetSignature.includes(expected.targetSignatureIncludes)));
      if (match < 0) return true;
      unmatched.splice(match, 1);
      return false;
    });
    return {
      id: item.id,
      language: item.language,
      sourceQualifiedName: item.sourceQualifiedName,
      edgeKind: item.edgeKind,
      expectedEdges: item.expectedEdges,
      actualEdges,
      unexpectedEdges: unmatched,
      missingEdges,
      passed: unmatched.length === 0 && missingEdges.length === 0,
    };
  });
}

function scoreCases(
  fixture: QualityFixture,
  nodes: CodeNodeRecord[],
  edges: CodeEdgeRecord[],
  unresolved: UnresolvedReferenceRecord[],
): CaseResult[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return fixture.cases.map((item) => {
    const sources = nodes.filter(
      (node) => node.language === item.language && node.qualifiedName === item.sourceQualifiedName,
    );
    if (sources.length !== 1 || !sources[0]) {
      throw new Error(`V05_FIXTURE_MISMATCH: expected one source node for ${item.id}, found ${sources.length}`);
    }
    const source = sources[0];
    const actualEdges = edges
      .filter((edge) => edge.sourceId === source.id && edge.kind === "CALLS")
      .map((edge) => ({
        target: nodeById.get(edge.targetId)?.qualifiedName ?? `missing:${edge.targetId}`,
        status: edge.status ?? "resolved",
      }))
      .sort((left, right) => `${left.status}\0${left.target}`.localeCompare(`${right.status}\0${right.target}`));
    const expected = [...new Set(item.expectedResolvedTargets)].sort();
    const actual = [...new Set(
      actualEdges.filter((edge) => edge.status === "resolved").map((edge) => edge.target),
    )].sort();
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const pathKey = (edge: { target: string; status: string }): string => `${edge.status}\0${edge.target}`;
    const expectedCallEdges = [...item.expectedCallEdges]
      .sort((left, right) => pathKey(left).localeCompare(pathKey(right)));
    const expectedPathKeys = new Set(expectedCallEdges.map(pathKey));
    const actualPathKeys = new Set(actualEdges.map(pathKey));
    const unexpectedPaths = actualEdges.filter((edge) => !expectedPathKeys.has(pathKey(edge)));
    const missingPaths = expectedCallEdges.filter((edge) => !actualPathKeys.has(pathKey(edge)));
    const pathPassed = unexpectedPaths.length === 0 && missingPaths.length === 0;
    const truePositive = actual.filter((target) => expectedSet.has(target)).length;
    const falsePositive = actual.filter((target) => !expectedSet.has(target)).length;
    const falseNegative = expected.filter((target) => !actualSet.has(target)).length;
    const unresolvedMatches = item.expectedUnresolved
      ? unresolved.filter((reference) =>
          reference.sourceNodeId === source.id && reference.rawName === item.expectedUnresolved!.rawName)
      : [];
    const unresolvedCandidates = item.expectedUnresolved
      ? Math.max(-1, ...unresolvedMatches.map((reference) => reference.candidates.length))
      : null;
    const unresolvedObserved = item.expectedUnresolved
      ? unresolvedMatches.length > 0 && unresolvedCandidates! >= item.expectedUnresolved.minimumCandidates
      : null;
    return {
      id: item.id,
      language: item.language,
      split: item.split,
      category: item.category,
      sourceQualifiedName: item.sourceQualifiedName,
      expectedResolvedTargets: expected,
      actualResolvedTargets: actual,
      actualStatuses: [...new Set(actualEdges.map((edge) => edge.status))].sort(),
      actualEdges,
      expectedCallEdges,
      unexpectedPaths,
      missingPaths,
      pathPassed,
      truePositive,
      falsePositive,
      falseNegative,
      unresolvedObserved,
      unresolvedCandidates,
      passed: falsePositive === 0 && falseNegative === 0 && unresolvedObserved !== false && pathPassed,
    };
  });
}

function languageResults(caseResults: CaseResult[]) {
  return TIER1_LANGUAGES.map((language) => {
    const cases = caseResults.filter((item) => item.language === language);
    const truePositive = cases.reduce((sum, item) => sum + item.truePositive, 0);
    const falsePositive = cases.reduce((sum, item) => sum + item.falsePositive, 0);
    const falseNegative = cases.reduce((sum, item) => sum + item.falseNegative, 0);
    const predictedResolved = truePositive + falsePositive;
    const goldPositive = truePositive + falseNegative;
    return {
      language,
      cases: cases.length,
      goldPositive,
      predictedResolved,
      negativeCases: cases.filter((item) => item.category === "negative").length,
      ambiguousCases: cases.filter((item) => item.category === "ambiguous").length,
      developmentCases: cases.filter((item) => item.split === "development").length,
      holdoutCases: cases.filter((item) => item.split === "holdout").length,
      unexpectedPaths: cases.reduce((sum, item) => sum + item.unexpectedPaths.length, 0),
      missingPaths: cases.reduce((sum, item) => sum + item.missingPaths.length, 0),
      truePositive,
      falsePositive,
      falseNegative,
      precision: predictedResolved === 0 ? 0 : truePositive / predictedResolved,
      recall: goldPositive === 0 ? 0 : truePositive / goldPositive,
    };
  });
}

type GraphLike = Pick<ExtractedGraph, "nodes" | "edges" | "unresolvedReferences"> | StoredGraphPartition;

function graphFingerprint(graph: GraphLike, language?: Tier1Language): string {
  const selectedNodes = graph.nodes.filter((node) => language === undefined || node.language === language);
  const selectedIds = new Set(selectedNodes.map((node) => node.id));
  const nodeDescriptor = (node: CodeNodeRecord) => ({
    language: node.language ?? null,
    ecosystem: node.ecosystem ?? null,
    kind: node.kind,
    nativeKind: node.nativeKind ?? null,
    analysisLevel: node.analysisLevel ?? null,
    name: node.name,
    qualifiedName: node.qualifiedName,
    localKey: node.localKey,
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
  });
  const descriptorById = new Map(selectedNodes.map((node) => [node.id, nodeDescriptor(node)]));
  const nodeKey = (id: string): unknown => descriptorById.get(id) ?? { missingNode: id };
  const normalized = {
    nodes: selectedNodes.map(nodeDescriptor).sort((left, right) => canonical(left).localeCompare(canonical(right))),
    edges: graph.edges
      .filter((edge) => selectedIds.has(edge.sourceId) && selectedIds.has(edge.targetId))
      .map((edge) => ({
        source: nodeKey(edge.sourceId),
        target: nodeKey(edge.targetId),
        kind: edge.kind,
        confidence: edge.confidence,
        resolutionKind: edge.resolutionKind,
        metadata: edge.metadata,
        status: edge.status ?? "resolved",
        evidence: edge.evidence ?? [],
      }))
      .sort((left, right) => canonical(left).localeCompare(canonical(right))),
    unresolvedReferences: graph.unresolvedReferences
      .filter((reference) => reference.sourceNodeId !== null && selectedIds.has(reference.sourceNodeId))
      .map((reference) => ({
        source: reference.sourceNodeId ? nodeKey(reference.sourceNodeId) : null,
        kind: reference.kind,
        rawName: reference.rawName,
        qualifier: reference.qualifier,
        line: reference.line,
        column: reference.column,
        candidates: reference.candidates.map(nodeKey).sort((left, right) => canonical(left).localeCompare(canonical(right))),
        confidence: reference.confidence ?? null,
        evidence: reference.evidence ?? [],
      }))
      .sort((left, right) => canonical(left).localeCompare(canonical(right))),
  };
  return digest(normalized);
}

function currentEffectiveGraph(app: ContextMeshApp): StoredGraphPartition {
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

function stablePretty(value: unknown): string {
  return JSON.stringify(JSON.parse(stableStringify(value)), null, 2);
}

function removeTemporaryDirectory(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    process.stderr.write(`V05_TEMP_CLEANUP_DEFERRED: ${path.basename(root)}\n`);
  }
}

const fixture = loadFixture();
const semanticFixture = loadSemanticFixture();
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v05-quality-"));
const rustAnalyzerRuntime = await probeRustAnalyzerRuntime();
const rustcVersion = spawnSync("rustc", ["--version"], { encoding: "utf8", windowsHide: true });
const rustcIdentity = rustcVersion.status === 0 ? rustcVersion.stdout.trim() : "unavailable";
const analyzerIdentity = rustAnalyzerRuntime.version.match(/^rust-analyzer (\d+\.\d+\.\d+) \(([0-9a-f]{7,}) /);
const compilerIdentity = rustcIdentity.match(/^rustc (\d+\.\d+\.\d+) \(([0-9a-f]{8,}) /);
let app: ContextMeshApp | null = null;
try {
  writeFixture(fixtureRoot, fixture);
  writeFixture(fixtureRoot, semanticFixture);
  app = new ContextMeshApp(fixtureRoot);
  await app.indexWorkspace({ mode: "full" });
  const syntax = await app.code.indexer.evaluationGraph("syntax");
  const partitions = [
    app.database.getStoredGraphPartition("non-python"),
    app.database.getStoredGraphPartition("python"),
  ];
  const nodes = partitions.flatMap((partition) => partition.nodes);
  const edges = partitions.flatMap((partition) => partition.edges);
  const unresolved = partitions.flatMap((partition) => partition.unresolvedReferences);
  const caseResults = scoreCases(fixture, nodes, edges, unresolved);
  const semanticCaseResults = scoreSemanticCases(semanticFixture, nodes, edges);
  const perLanguage = languageResults(caseResults);
  const baseLanguages = [...new Set(
    syntax.nodes.map((node) => node.language).filter((language) => language !== undefined),
  )].sort();
  const statusCoverage = [...new Set(caseResults.flatMap((item) => item.actualStatuses))].sort();

  const determinismSignatures = [graphFingerprint(currentEffectiveGraph(app))];
  for (let run = 1; run < 20; run += 1) {
    await app.indexWorkspace({ mode: "full" });
    determinismSignatures.push(graphFingerprint(currentEffectiveGraph(app)));
  }
  const determinism = {
    runs: determinismSignatures.length,
    identical: new Set(determinismSignatures).size === 1,
    signatures: determinismSignatures,
  };

  const generationBeforeProviderUpdate = app.database.getWorkspace().currentGeneration;
  const revisionBeforeProviderUpdate = app.database.getPrecisionRevision();
  const claim = app.database.claimPrecisionProvider({
    provider: "quality_update_probe",
    providerVersion: "2",
    language: "python",
    capability: "resolved",
    owner: "quality-gate",
  });
  if (!claim.claim || !app.database.commitPrecisionOverlay(claim.claim, {
    edges: [],
    eligibleEdges: 0,
    diagnostics: [],
  })) {
    throw new Error("v0.5 provider revision probe could not commit");
  }
  const generationAfterProviderUpdate = app.database.getWorkspace().currentGeneration;
  const revisionAfterProviderUpdate = app.database.getPrecisionRevision();
  const providerStates = app.database.getPrecisionProviderStates().map((state) => ({
    language: state.language,
    provider: state.provider,
    providerVersion: state.providerVersion,
    capability: state.capability,
    status: state.status,
    baseGeneration: state.baseGeneration,
    precisionRevision: state.precisionRevision,
    eligibleEdges: state.eligibleEdges,
    resolvedEdges: state.resolvedEdges,
    rejectedEdges: state.rejectedEdges,
    coverage: state.coverage,
    lastError: state.lastError?.split(fixtureRoot).join("<fixture>") ?? null,
  }));
  const providerConformance = semanticFixture.providerExpectations.map((expectation) => {
    const state = providerStates.find((item) => item.provider === expectation.provider);
    const statusMatches = Boolean(state && expectation.statuses.includes(state.status as "ready" | "partial"));
    const versionMatches = Boolean(state && (!expectation.providerVersionPattern
      || new RegExp(expectation.providerVersionPattern).test(state.providerVersion)));
    const diagnosticsMatch = Boolean(state && (expectation.lastErrorIncludes ?? [])
      .every((value) => state.lastError?.includes(value)));
    return {
      provider: expectation.provider,
      actualStatus: state?.status ?? "missing",
      actualVersion: state?.providerVersion ?? null,
      statusMatches,
      versionMatches,
      diagnosticsMatch,
      passed: statusMatches && versionMatches && diagnosticsMatch,
    };
  });

  const absenceSpecifications = [
    { language: "typescript", environment: "CONTEXTMESH_TYPESCRIPT_PRECISION_DISABLE", provider: "typescript_type_checker", partition: "non-python" as const },
    { language: "python", environment: "CONTEXTMESH_PYTHON_PRECISION_DISABLE", provider: "contextmesh_python_resolver", partition: "python" as const },
    { language: "go", environment: "CONTEXTMESH_GO_TYPES_DISABLE", provider: "go_types", partition: "non-python" as const },
    { language: "rust", environment: "CONTEXTMESH_RUST_ANALYZER_DISABLE", provider: "rust_analyzer", partition: "non-python" as const },
  ] as const;
  const providerAbsence: Array<{
    language: Tier1Language;
    provider: string;
    providerState: string;
    expectedBaseDigest: string;
    actualBaseDigest: string;
    exactBaseGraph: boolean;
    preservesBase: boolean;
  }> = [];
  for (const specification of absenceSpecifications) {
    const root = mkdtempSync(path.join(os.tmpdir(), `contextmesh-v05-${specification.language}-provider-absent-`));
    const prior = process.env[specification.environment];
    let absentApp: ContextMeshApp | null = null;
    try {
      process.env[specification.environment] = "1";
      writeFixture(root, fixture);
      writeFixture(root, semanticFixture);
      absentApp = new ContextMeshApp(root);
      const absentIndex = await absentApp.indexWorkspace({ mode: "full" });
      const absentGraph = absentApp.database.getStoredGraphPartition(specification.partition);
      const state = absentApp.database.getPrecisionProviderStates().find((item) => item.provider === specification.provider);
      const providerState = state?.status ?? "missing";
      const expectedBaseDigest = graphFingerprint(syntax, specification.language);
      const actualBaseDigest = graphFingerprint(absentGraph, specification.language);
      const exactBaseGraph = expectedBaseDigest === actualBaseDigest;
      providerAbsence.push({
        language: specification.language,
        provider: specification.provider,
        providerState,
        expectedBaseDigest,
        actualBaseDigest,
        exactBaseGraph,
        preservesBase: absentIndex.generation > 0 && exactBaseGraph && providerState === "not_configured",
      });
    } finally {
      await absentApp?.close();
      if (prior === undefined) delete process.env[specification.environment];
      else process.env[specification.environment] = prior;
      removeTemporaryDirectory(root);
    }
  }

  const categoriesByLanguage = Object.fromEntries(TIER1_LANGUAGES.map((language) => [
    language,
    [...new Set(fixture.cases.filter((item) => item.language === language).map((item) => item.category))].sort(),
  ]));
  const splitsByLanguage = Object.fromEntries(TIER1_LANGUAGES.map((language) => [
    language,
    Object.fromEntries((["development", "holdout"] as const).map((split) => [
      split,
      fixture.cases.filter((item) => item.language === language && item.split === split).length,
    ])),
  ]));
  const expectedStatusCoverage = [...new Set(fixture.cases.flatMap((item) => item.expectedCallEdges.map((edge) => edge.status)))].sort();
  const checks = {
    immutableFixturePinned: digest(fixture) === PINNED_FIXTURE_DIGEST,
    immutableSemanticFixturePinned: digest(semanticFixture) === PINNED_SEMANTIC_FIXTURE_DIGEST,
    fixtureProvenancePinned: Boolean(fixture.provenance.origin && fixture.provenance.authoredAgainst && fixture.provenance.mutationPolicy),
    tier1FixtureCoverage: TIER1_LANGUAGES.every((language) =>
      JSON.stringify(categoriesByLanguage[language]) === JSON.stringify(["ambiguous", "negative", "positive"])),
    developmentAndHoldoutCoverage: TIER1_LANGUAGES.every((language) =>
      (splitsByLanguage[language]?.development ?? 0) >= 3 && (splitsByLanguage[language]?.holdout ?? 0) >= 3),
    tier1Precision: perLanguage.every((item) => item.precision >= fixture.thresholds.precision),
    tier1Recall: perLanguage.every((item) => item.recall >= fixture.thresholds.recall),
    noFalsePositives: perLanguage.every((item) => item.falsePositive === 0),
    noFalseNegatives: perLanguage.every((item) => item.falseNegative === 0),
    exactCandidateRejectedResolvedPaths: caseResults.every((item) => item.pathPassed),
    noUnexpectedCandidateOrRejectedPaths: caseResults.every((item) =>
      item.unexpectedPaths.every((edge) => edge.status !== "candidate" && edge.status !== "rejected")),
    ambiguousCasesHandled: caseResults.filter((item) => item.category === "ambiguous")
      .every((item) => item.passed && item.unresolvedObserved === true),
    negativeCasesHandled: caseResults.filter((item) => item.category === "negative")
      .every((item) => item.passed && item.unresolvedObserved !== false),
    candidateRejectedResolvedCovered: JSON.stringify(statusCoverage) === JSON.stringify(["candidate", "rejected", "resolved"])
      && JSON.stringify(expectedStatusCoverage) === JSON.stringify(statusCoverage),
    semanticCallAndInheritanceConformance: semanticCaseResults.every((item) => item.passed),
    semanticProviderConformance: providerConformance.every((item) => item.passed),
    baseGraphWithoutPrecision: TIER1_LANGUAGES.every((language) => baseLanguages.includes(language)),
    optionalProviderAbsencePreservesBase: providerAbsence.length === TIER1_LANGUAGES.length && providerAbsence.every((item) => item.preservesBase),
    providerAbsenceExactBaseFingerprint: providerAbsence.length === TIER1_LANGUAGES.length && providerAbsence.every((item) => item.exactBaseGraph),
    twentyRunGraphDeterminism: determinism.runs === 20 && determinism.identical,
    providerUpdatePreservesGeneration: generationBeforeProviderUpdate === generationAfterProviderUpdate,
    providerUpdateAdvancesPrecisionRevision: revisionAfterProviderUpdate === revisionBeforeProviderUpdate + 1,
    providerStatesHealthy: ["typescript_type_checker", "contextmesh_python_resolver", "go_types", "rust_analyzer"].every((provider) =>
      providerStates.some((state) => state.provider === provider && (state.status === "ready" || state.status === "partial"))),
    rustAnalyzerMatchesPinnedToolchain: Boolean(analyzerIdentity && compilerIdentity &&
      analyzerIdentity[1] === compilerIdentity[1] && compilerIdentity[2]!.startsWith(analyzerIdentity[2]!)),
  };
  const goVersion = spawnSync("go", ["version"], { encoding: "utf8", windowsHide: true });
  const artifact = {
    schemaVersion: 4,
    release: "v0.5",
    source: evaluationSourceEvidence(),
    fixture: {
      id: fixture.id,
      schemaVersion: fixture.schemaVersion,
      immutable: fixture.immutable,
      digest: digest(fixture),
      caseCount: fixture.cases.length,
      categoriesByLanguage,
      splitsByLanguage,
      provenance: fixture.provenance,
      thresholds: fixture.thresholds,
    },
    semanticFixture: {
      id: semanticFixture.id,
      schemaVersion: semanticFixture.schemaVersion,
      immutable: semanticFixture.immutable,
      digest: digest(semanticFixture),
      caseCount: semanticFixture.cases.length,
      provenance: semanticFixture.provenance,
    },
    runner: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      go: goVersion.status === 0 ? goVersion.stdout.trim() : "unavailable",
      rustAnalyzer: rustAnalyzerRuntime.version,
      rustc: rustcIdentity,
    },
    generation: generationBeforeProviderUpdate,
    precisionRevision: revisionAfterProviderUpdate,
    languageResults: perLanguage,
    caseResults,
    semanticCaseResults,
    statusCoverage,
    baseLanguages,
    providerStates,
    providerConformance,
    providerAbsence,
    determinism,
    checks,
    passed: Object.values(checks).every(Boolean)
      && caseResults.every((item) => item.passed)
      && semanticCaseResults.every((item) => item.passed),
  };
  const target = outputPath();
  if (target) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${stablePretty(artifact)}\n`, "utf8");
  }
  process.stdout.write(target
    ? `${JSON.stringify({ output: target, release: artifact.release, passed: artifact.passed })}\n`
    : `${JSON.stringify(artifact, null, 2)}\n`);
  if (!artifact.passed) {
    throw new Error(
      `v0.5 quality gate failed: ${Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name).join(", ")}`,
    );
  }
} finally {
  await app?.close();
  removeTemporaryDirectory(fixtureRoot);
}
