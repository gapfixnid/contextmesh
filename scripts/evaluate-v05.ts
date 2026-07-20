import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContextMeshApp } from "../src/app.js";
import type { CodeEdgeRecord, CodeNodeRecord, UnresolvedReferenceRecord } from "../src/contracts.js";
import { v04SourceEvidence } from "./v04-artifact-contract.js";

type Tier1Language = "typescript" | "python" | "go";
type CaseCategory = "positive" | "negative" | "ambiguous";
type CaseSplit = "development" | "holdout";

interface QualityFixture {
  schemaVersion: 2;
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

const FIXTURE_PATH = path.join(process.cwd(), "evaluation", "fixtures", "v05-quality-v2.json");
const PINNED_FIXTURE_DIGEST = "01022b01e3eb1cb869dfa2e063dfe6e964c151b90df689768f33f218b75a5823";
const TIER1_LANGUAGES: readonly Tier1Language[] = ["typescript", "python", "go"];

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
    fixture.schemaVersion !== 2 ||
    fixture.id !== "contextmesh-v05-tier1-resolved-edge-v2" ||
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
  return fixture;
}

function writeFixture(root: string, fixture: QualityFixture): void {
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

const fixture = loadFixture();
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v05-quality-"));
let app: ContextMeshApp | null = null;
try {
  writeFixture(fixtureRoot, fixture);
  app = new ContextMeshApp(fixtureRoot);
  const indexed = await app.indexWorkspace({ mode: "full" });
  const syntax = await app.code.indexer.evaluationGraph("syntax");
  const partitions = [
    app.database.getStoredGraphPartition("non-python"),
    app.database.getStoredGraphPartition("python"),
  ];
  const nodes = partitions.flatMap((partition) => partition.nodes);
  const edges = partitions.flatMap((partition) => partition.edges);
  const unresolved = partitions.flatMap((partition) => partition.unresolvedReferences);
  const caseResults = scoreCases(fixture, nodes, edges, unresolved);
  const perLanguage = languageResults(caseResults);
  const baseLanguages = [...new Set(
    syntax.nodes.map((node) => node.language).filter((language) => language !== undefined),
  )].sort();
  const statusCoverage = [...new Set(caseResults.flatMap((item) => item.actualStatuses))].sort();

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

  const absenceSpecifications = [
    { language: "typescript", environment: "CONTEXTMESH_TYPESCRIPT_PRECISION_DISABLE", provider: "typescript_type_checker", partition: "non-python" as const },
    { language: "python", environment: "CONTEXTMESH_PYTHON_PRECISION_DISABLE", provider: "contextmesh_python_resolver", partition: "python" as const },
    { language: "go", environment: "CONTEXTMESH_GO_TYPES_DISABLE", provider: "go_types", partition: "non-python" as const },
  ] as const;
  const providerAbsence: Array<{ language: Tier1Language; provider: string; providerState: string; preservesBase: boolean }> = [];
  for (const specification of absenceSpecifications) {
    const root = mkdtempSync(path.join(os.tmpdir(), `contextmesh-v05-${specification.language}-provider-absent-`));
    const prior = process.env[specification.environment];
    let absentApp: ContextMeshApp | null = null;
    try {
      process.env[specification.environment] = "1";
      writeFixture(root, fixture);
      absentApp = new ContextMeshApp(root);
      const absentIndex = await absentApp.indexWorkspace({ mode: "full" });
      const absentGraph = absentApp.database.getStoredGraphPartition(specification.partition);
      const state = absentApp.database.getPrecisionProviderStates().find((item) => item.provider === specification.provider);
      const capability = absentApp.code.indexer.coordinator.capabilities(root)
        .find((item) => item.language === (specification.language === "typescript" ? "typescript/javascript" : specification.language));
      const providerState = state?.status ?? (capability?.precisionProvider === null ? "not_configured" : "missing");
      providerAbsence.push({
        language: specification.language,
        provider: specification.provider,
        providerState,
        preservesBase: absentIndex.generation > 0
          && absentGraph.nodes.some((node) => node.language === specification.language)
          && providerState === "not_configured",
      });
    } finally {
      await absentApp?.close();
      if (prior === undefined) delete process.env[specification.environment];
      else process.env[specification.environment] = prior;
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
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
    baseGraphWithoutPrecision: TIER1_LANGUAGES.every((language) => baseLanguages.includes(language)),
    optionalProviderAbsencePreservesBase: providerAbsence.length === 3 && providerAbsence.every((item) => item.preservesBase),
    providerUpdatePreservesGeneration: generationBeforeProviderUpdate === generationAfterProviderUpdate,
    providerUpdateAdvancesPrecisionRevision: revisionAfterProviderUpdate === revisionBeforeProviderUpdate + 1,
    providerStatesHealthy: ["typescript_type_checker", "contextmesh_python_resolver", "go_types"].every((provider) =>
      providerStates.some((state) => state.provider === provider && (state.status === "ready" || state.status === "partial"))),
  };
  const goVersion = spawnSync("go", ["version"], { encoding: "utf8", windowsHide: true });
  const artifact = {
    schemaVersion: 3,
    release: "v0.5",
    source: v04SourceEvidence(),
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
    runner: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      go: goVersion.status === 0 ? goVersion.stdout.trim() : "unavailable",
    },
    generation: indexed.generation,
    precisionRevision: revisionAfterProviderUpdate,
    languageResults: perLanguage,
    caseResults,
    statusCoverage,
    baseLanguages,
    providerStates,
    providerAbsence,
    checks,
    passed: Object.values(checks).every(Boolean) && caseResults.every((item) => item.passed),
  };
  const target = outputPath();
  if (target) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  if (!artifact.passed) {
    throw new Error(
      `v0.5 quality gate failed: ${Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name).join(", ")}`,
    );
  }
} finally {
  await app?.close();
  rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 3 });
}
