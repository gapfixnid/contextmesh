import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope, MemoryFragmentRecord } from "../src/contracts.js";
import type { ContextCodeItem, ContextMemoryItem } from "../src/context/assembler.js";
import { APPROVED_MODEL_KEY, APPROVED_MODEL_MANIFEST } from "../src/semantic/manifest.js";
import type { CodeSearchResult } from "../src/storage/database.js";
import {
  addBaselineDigest,
  canonicalControlJson,
  metricsForGateGroup,
  normalizedFixtureDigest,
  requiredChallengeRecall,
  requiredNdcg,
  runEvaluationContractSelfTest,
  serializeCanonicalArtifact,
  sha256Bytes,
  sourceDateEpochIso,
  type CanonicalJsonValue,
} from "./evaluation-contract.js";
import { installNetworkDenyGuard } from "./network-deny.js";

interface GoldEntry {
  key: string;
  grade: 0 | 1 | 2 | 3;
  span?: { path: string; startLine: number; endLine: number };
}

interface RankedQuery {
  id: string;
  query: string;
  k: number;
  gateGroup?: string;
  gold: GoldEntry[];
  includeAnchors?: boolean;
}

interface ContextQuery {
  id: string;
  query: string;
  tokenBudget: number;
  gateGroup?: string;
  gold: GoldEntry[];
}

interface FixtureFile {
  path: string;
  content: string;
}

interface FixtureMemory {
  key: string;
  draft: {
    content: string;
    topic: string;
    type: "fact" | "decision" | "error" | "preference" | "procedure" | "relation" | "episode";
    keywords: string[];
    importance: number;
    anchor: boolean;
    assertionStatus: "observed" | "inferred" | "verified" | "rejected";
    sourceLocalKeys: string[];
  };
}

interface EvaluationFixture {
  version: number;
  name: string;
  immutable: boolean;
  extends?: string;
  querySelection?: { code: string[]; memory: string[]; context: string[] };
  corpus?: { files: FixtureFile[]; memories: FixtureMemory[] };
  queries: { code: RankedQuery[]; memory: RankedQuery[]; context: ContextQuery[] };
}

interface RankedMetric {
  id: string;
  gateGroup: string;
  returned: string[];
  relevantReturned: number;
  relevantTotal: number;
  recall: number;
  reciprocalRank: number;
  ndcg: number;
  deterministic: boolean;
  scoreMicro: number[];
}

interface BaselineEvaluation {
  baseline: { commit?: string; phase3SourceCommit?: string };
  evaluation: {
    code: { queries: RankedMetric[] };
    memory?: { queries: RankedMetric[] };
    context: { macroEvidenceCoverage: number; macroDuplicateWaste: number };
  };
}

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const FIXTURE_DIRECTORY = path.join(PROJECT_ROOT, "evaluation", "fixtures");
const BASELINE_V1_PATH = path.join(PROJECT_ROOT, "evaluation", "baselines", "phase3-lexical-7b70d06.json");
const BASELINE_V2_PATH = path.join(PROJECT_ROOT, "evaluation", "baselines", "phase3-lexical-v2.json");

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function legacyGateGroup(id: string): string {
  if (id.includes("exact")) return "exact";
  if (id.includes("semantic")) return "semantic_challenge_en";
  return "lexical";
}

function validateV2Fixture(fixture: EvaluationFixture): void {
  if (fixture.version !== 2 || !fixture.immutable || !fixture.corpus) {
    throw new Error("Acceptance-v2 must be immutable, version 2, and contain a corpus");
  }
  const { files, memories } = fixture.corpus;
  if (files.length !== 30 || memories.length !== 42) {
    throw new Error(`Acceptance-v2 corpus must contain 30 files and 42 memories; received ${files.length}/${memories.length}`);
  }
  if (fixture.queries.code.length !== 30 || fixture.queries.memory.length !== 30 || fixture.queries.context.length !== 20) {
    throw new Error("Acceptance-v2 must contain 30 code, 30 memory, and 20 context queries");
  }
  for (const [plane, queries] of [
    ["code", fixture.queries.code],
    ["memory", fixture.queries.memory],
    ["context", fixture.queries.context],
  ] as const) {
    if (queries.some((query) => !query.gateGroup)) throw new Error(`Every acceptance-v2 ${plane} query needs gateGroup`);
  }
  for (const plane of [fixture.queries.code, fixture.queries.memory]) {
    const challengeCount = plane.filter((query) =>
      query.gateGroup === "semantic_challenge_en" || query.gateGroup === "semantic_challenge_ko_en"
    ).length;
    if (challengeCount !== 20) throw new Error("Each ranked plane must contain exactly 20 semantic challenge queries");
  }
}

function loadFixture(name: string): { fixture: EvaluationFixture; checksum: string } {
  const fileName = name.endsWith(".json") ? name : `${name}.json`;
  const fixturePath = path.join(FIXTURE_DIRECTORY, fileName);
  const raw = readFileSync(fixturePath);
  const fixture = JSON.parse(raw.toString("utf8")) as EvaluationFixture;
  if (fixture.extends) {
    const base = loadFixture(fixture.extends).fixture;
    if (!base.corpus) throw new Error(`Base fixture ${fixture.extends} has no corpus`);
    fixture.corpus = base.corpus;
    if (fixture.querySelection) {
      fixture.queries = {
        code: base.queries.code.filter((query) => fixture.querySelection!.code.includes(query.id)),
        memory: base.queries.memory.filter((query) => fixture.querySelection!.memory.includes(query.id)),
        context: base.queries.context.filter((query) => fixture.querySelection!.context.includes(query.id)),
      };
    }
  }
  if (!fixture.corpus) throw new Error(`Fixture ${name} has no corpus`);
  if (fixture.version === 2 && fixture.immutable) validateV2Fixture(fixture);
  return { fixture, checksum: fixture.version === 2 ? normalizedFixtureDigest(raw) : sha256(raw) };
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
}

function rankedMetric(
  query: RankedQuery,
  returned: string[],
  deterministic: boolean,
  scores: readonly number[] = [],
): RankedMetric {
  const grades = new Map(query.gold.map((entry) => [entry.key, entry.grade]));
  const relevant = query.gold.filter((entry) => entry.grade >= 2);
  const limited = returned.slice(0, query.k);
  const relevantReturned = limited.filter((key) => (grades.get(key) ?? 0) >= 2).length;
  const firstRelevant = limited.findIndex((key) => (grades.get(key) ?? 0) >= 2);
  const dcg = limited.reduce((sum, key, index) => {
    const grade = grades.get(key) ?? 0;
    return sum + (2 ** grade - 1) / Math.log2(index + 2);
  }, 0);
  const ideal = [...query.gold]
    .sort((left, right) => right.grade - left.grade || left.key.localeCompare(right.key))
    .slice(0, query.k)
    .reduce((sum, entry, index) => sum + (2 ** entry.grade - 1) / Math.log2(index + 2), 0);
  return {
    id: query.id,
    gateGroup: query.gateGroup ?? legacyGateGroup(query.id),
    returned: limited,
    relevantReturned,
    relevantTotal: relevant.length,
    recall: round(relevant.length === 0 ? 1 : relevantReturned / relevant.length),
    reciprocalRank: round(firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1)),
    ndcg: round(ideal === 0 ? 1 : dcg / ideal),
    deterministic,
    scoreMicro: scores.slice(0, query.k).map((score) => Math.round(score * 1_000_000)),
  };
}

function average(values: number[]): number {
  return round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length));
}

function aggregateRanked(metrics: RankedMetric[]): Record<string, number> {
  const count = Math.max(1, metrics.length);
  const relevantReturned = metrics.reduce((sum, metric) => sum + metric.relevantReturned, 0);
  const relevantTotal = metrics.reduce((sum, metric) => sum + metric.relevantTotal, 0);
  return {
    macroRecall: round(metrics.reduce((sum, metric) => sum + metric.recall, 0) / count),
    macroMrr: round(metrics.reduce((sum, metric) => sum + metric.reciprocalRank, 0) / count),
    macroNdcg: round(metrics.reduce((sum, metric) => sum + metric.ndcg, 0) / count),
    microRecall: round(relevantTotal === 0 ? 1 : relevantReturned / relevantTotal),
  };
}

function normalizedTokens(value: string): string[] {
  return value
    .normalize("NFC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function shingles(tokens: string[], width = 5): Set<string> {
  if (tokens.length < width) return new Set(tokens.length > 0 ? [tokens.join(" ")] : []);
  const result = new Set<string>();
  for (let index = 0; index <= tokens.length - width; index += 1) {
    result.add(tokens.slice(index, index + width).join(" "));
  }
  return result;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function duplicateWaste(values: string[]): number {
  const prior: Array<{ tokens: string[]; shingles: Set<string> }> = [];
  let totalTokens = 0;
  let wastedTokens = 0;
  for (const value of values) {
    const tokens = normalizedTokens(value);
    const tokenShingles = shingles(tokens);
    totalTokens += tokens.length;
    const nearDuplicate = prior.find((candidate) => jaccard(candidate.shingles, tokenShingles) >= 0.8);
    if (nearDuplicate) {
      const priorTokens = new Set(nearDuplicate.tokens);
      wastedTokens += tokens.filter((token) => priorTokens.has(token)).length;
    }
    prior.push({ tokens, shingles: tokenShingles });
  }
  return round(totalTokens === 0 ? 0 : wastedTokens / totalTokens);
}

async function measure(operation: () => Promise<void>): Promise<number> {
  for (let index = 0; index < 5; index += 1) await operation();
  const durations: number[] = [];
  for (let index = 0; index < 50; index += 1) {
    const started = performance.now();
    await operation();
    durations.push(performance.now() - started);
  }
  return round(percentile95(durations));
}

if (process.argv.includes("--self-test-v2")) {
  runEvaluationContractSelfTest();
  process.stdout.write("acceptance-v2 evaluation contract: ok\n");
} else {
const selectedFixture = argument("--fixture", "acceptance-v1");
const semanticModelPath = argument("--semantic-model", "");
const baselineToolCommit = argument("--baseline-tool-commit", "");
const fixtureCommit = argument("--fixture-commit", "");
const explicitSourceCommit = argument("--source-commit", "");
const outputPath = argument("--output", "");
const defaultBaselinePath = selectedFixture.includes("v2") ? BASELINE_V2_PATH : BASELINE_V1_PATH;
const baselinePath = path.resolve(argument("--baseline", defaultBaselinePath));
const lexicalBaseline = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, "utf8")) as BaselineEvaluation
  : null;
if (semanticModelPath && !lexicalBaseline) {
  throw new Error(`Semantic quality evaluation requires a lexical baseline: ${baselinePath}`);
}
const { fixture, checksum } = loadFixture(selectedFixture);
const corpus = fixture.corpus;
if (!corpus) throw new Error("Evaluation corpus is missing");
const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-evaluation-"));
writeFileSync(
  path.join(root, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
    },
    include: ["src/**/*.ts"],
  }),
  "utf8",
);
for (const file of corpus.files) {
  const target = path.join(root, file.path);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, file.content, "utf8");
}

let evaluationNow = new Date();
const restoreNetwork = semanticModelPath ? installNetworkDenyGuard("NETWORK_DENIED_BY_ACCEPTANCE") : () => {};
const app = new ContextMeshApp(
  root,
  ":memory:",
  semanticModelPath
    ? { clock: () => evaluationNow, semantic: { modelPath: path.resolve(semanticModelPath) } }
    : { clock: () => evaluationNow },
);
try {
  await app.indexWorkspace({ mode: "full" });
  const codeNodes = app.database.searchCode("", undefined, 10_000);
  const codeIds = new Map(codeNodes.map((node) => [node.localKey, node.id]));
  const memoryIdToKey = new Map<string, string>();
  for (const memory of corpus.memories) {
    const sourceSymbolIds = memory.draft.sourceLocalKeys
      .map((key) => codeIds.get(key))
      .filter((id): id is string => Boolean(id));
    const result = await app.remember({ ...memory.draft, sourceSymbolIds }) as Envelope<{
      fragment: MemoryFragmentRecord;
    }>;
    memoryIdToKey.set(result.data.fragment.id, memory.key);
  }

  const codeMetrics: RankedMetric[] = [];
  for (const query of fixture.queries.code) {
    const result = await app.searchCode({ query: query.query, limit: query.k }) as Envelope<{
      results: CodeSearchResult[];
    }>;
    const signature = JSON.stringify(result.data.results.map((node) => [node.localKey, node.score]));
    let deterministic = true;
    for (let run = 1; run < 20; run += 1) {
      const repeated = await app.searchCode({ query: query.query, limit: query.k }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      if (JSON.stringify(repeated.data.results.map((node) => [node.localKey, node.score])) !== signature) {
        deterministic = false;
      }
    }
    codeMetrics.push(
      rankedMetric(
        query,
        result.data.results.map((node) => node.localKey),
        deterministic,
        result.data.results.map((node) => node.score),
      ),
    );
  }

  const memoryMetrics: RankedMetric[] = [];
  for (const query of fixture.queries.memory) {
    const result = await app.recall({
      query: query.query,
      includeAnchors: query.includeAnchors ?? false,
      limit: query.k,
      tokenBudget: 4000,
    }) as Envelope<{ fragments: MemoryFragmentRecord[] }>;
    const signature = JSON.stringify(result.data.fragments.map((memory) => memoryIdToKey.get(memory.id) ?? memory.id));
    let deterministic = true;
    for (let run = 1; run < 20; run += 1) {
      const repeated = await app.recall({
        query: query.query,
        includeAnchors: query.includeAnchors ?? false,
        limit: query.k,
        tokenBudget: 4000,
      }) as Envelope<{ fragments: MemoryFragmentRecord[] }>;
      if (
        JSON.stringify(repeated.data.fragments.map((memory) => memoryIdToKey.get(memory.id) ?? memory.id)) !==
        signature
      ) {
        deterministic = false;
      }
    }
    memoryMetrics.push(
      rankedMetric(
        query,
        result.data.fragments.map((memory) => memoryIdToKey.get(memory.id) ?? memory.id),
        deterministic,
      ),
    );
  }

  const contextMetrics: Array<Record<string, unknown>> = [];
  for (const query of fixture.queries.context) {
    const result = await app.getContext({
      query: query.query,
      tokenBudget: query.tokenBudget,
      include: ["code", "memory"],
    }) as Envelope<{ code: ContextCodeItem[]; memories: ContextMemoryItem[] }>;
    const returned = new Set([
      ...result.data.code.map((node) => node.localKey),
      ...result.data.memories.map((memory) => memoryIdToKey.get(memory.id) ?? memory.id),
    ]);
    const relevant = query.gold.filter((entry) => entry.grade >= 2);
    const covered = relevant.filter((entry) => {
      if (!entry.span) return returned.has(entry.key);
      return result.data.code.some(
        (node) =>
          node.localKey === entry.key &&
          node.relativePath === entry.span?.path &&
          node.startLine <= entry.span.endLine &&
          node.endLine >= entry.span.startLine &&
          node.snippet !== null,
      );
    });
    const texts = [
      ...result.data.code.map((node) => node.snippet ?? `${node.signature} ${node.doc}`),
      ...result.data.memories.map((memory) => memory.content),
    ];
    const signature = JSON.stringify({
      code: result.data.code.map((node) => [node.localKey, node.score]),
      memories: result.data.memories.map((memory) => memoryIdToKey.get(memory.id) ?? memory.id),
    });
    let deterministic = true;
    for (let run = 1; run < 20; run += 1) {
      const repeated = await app.getContext({
        query: query.query,
        tokenBudget: query.tokenBudget,
        include: ["code", "memory"],
      }) as Envelope<{ code: ContextCodeItem[]; memories: ContextMemoryItem[] }>;
      const repeatedSignature = JSON.stringify({
        code: repeated.data.code.map((node) => [node.localKey, node.score]),
        memories: repeated.data.memories.map((memory) => memoryIdToKey.get(memory.id) ?? memory.id),
      });
      if (repeatedSignature !== signature) deterministic = false;
    }
    contextMetrics.push({
      id: query.id,
      relevantCovered: covered.length,
      relevantTotal: relevant.length,
      evidenceCoverage: round(relevant.length === 0 ? 1 : covered.length / relevant.length),
      estimatedTokens: result.estimatedTokens,
      duplicateWaste: duplicateWaste(texts),
      deterministic,
      returned: [...returned],
      orderedCode: result.data.code.map((node) => ({
        id: node.localKey,
        scoreMicro: Math.round(node.score * 1_000_000),
      })),
      orderedMemory: result.data.memories.map((memory) => memoryIdToKey.get(memory.id) ?? memory.id),
    });
  }

  const contextRelevantCovered = contextMetrics.reduce(
    (sum, metric) => sum + Number(metric.relevantCovered),
    0,
  );
  const contextRelevantTotal = contextMetrics.reduce((sum, metric) => sum + Number(metric.relevantTotal), 0);
  const searchQuery = fixture.queries.code[0];
  const contextQuery = fixture.queries.context[0];
  const searchP95Ms = searchQuery
    ? await measure(async () => {
        await app.searchCode({ query: searchQuery.query, limit: searchQuery.k });
      })
    : 0;
  const getContextP95Ms = contextQuery
    ? await measure(async () => {
        await app.getContext({
          query: contextQuery.query,
          tokenBudget: contextQuery.tokenBudget,
          include: ["code", "memory"],
        });
      })
    : 0;
  const status = await app.workspaceStatus() as Envelope<{
    counts: { files: number; nodes: number; memories: number };
  }>;

  const inactiveIds: string[] = [];
  const forgotten = await app.remember({
    content: "Acceptance inactive forgotten marker cobalt-orchid.",
    topic: "acceptance forgotten marker",
    type: "fact",
    keywords: ["cobalt-orchid"],
    sourceSymbolIds: [],
  }) as Envelope<{ fragment: MemoryFragmentRecord }>;
  inactiveIds.push(forgotten.data.fragment.id);
  app.forget({ fragmentId: forgotten.data.fragment.id, reason: "acceptance lifecycle gate" });
  const superseded = await app.remember({
    content: "Acceptance inactive superseded marker amber-river.",
    topic: "acceptance superseded marker",
    type: "decision",
    keywords: ["amber-river"],
    sourceSymbolIds: [],
  }) as Envelope<{ fragment: MemoryFragmentRecord }>;
  inactiveIds.push(superseded.data.fragment.id);
  await app.remember({
    content: "Replacement decision intentionally omits the prior marker.",
    topic: "acceptance replacement",
    type: "decision",
    keywords: ["replacement"],
    supersedesId: superseded.data.fragment.id,
    sourceSymbolIds: [],
  });
  const expired = await app.remember({
    content: "Acceptance inactive expired marker silver-pine.",
    topic: "acceptance expired marker",
    type: "fact",
    keywords: ["silver-pine"],
    ttlDays: 1,
    sourceSymbolIds: [],
  }) as Envelope<{ fragment: MemoryFragmentRecord }>;
  inactiveIds.push(expired.data.fragment.id);
  evaluationNow = new Date(evaluationNow.getTime() + 2 * 86_400_000);
  const lifecycleQueries = ["cobalt-orchid", "amber-river", "silver-pine"];
  const returnedInactiveIds = new Set<string>();
  for (const query of lifecycleQueries) {
    const recalled = await app.recall({ query, tokenBudget: 4000, limit: 100 }) as Envelope<{
      fragments: MemoryFragmentRecord[];
    }>;
    for (const memory of recalled.data.fragments) {
      if (inactiveIds.includes(memory.id)) returnedInactiveIds.add(memory.id);
    }
    const context = await app.getContext({
      query,
      include: ["memory"],
      tokenBudget: 4000,
    }) as Envelope<{ memories: MemoryFragmentRecord[] }>;
    for (const memory of context.data.memories) {
      if (inactiveIds.includes(memory.id)) returnedInactiveIds.add(memory.id);
    }
  }
  const gitCommit = explicitSourceCommit ||
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/u.test(gitCommit)) throw new Error("Evaluation source commit must be a full Git SHA");
  const npmVersion = /(?:^|\s)npm\/([^\s]+)/.exec(process.env.npm_config_user_agent ?? "")?.[1] ?? "unknown";
  const runtime = app.semantic?.runtimeDiagnostics() ?? null;
  const withGateGroups = (metrics: RankedMetric[]): RankedMetric[] =>
    metrics.map((metric) => ({ ...metric, gateGroup: metric.gateGroup ?? legacyGateGroup(metric.id) }));
  const challengeMetrics = (metrics: RankedMetric[]): RankedMetric[] =>
    withGateGroups(metrics).filter(
      (metric) => metric.gateGroup === "semantic_challenge_en" || metric.gateGroup === "semantic_challenge_ko_en",
    );
  const baselineCode = withGateGroups(lexicalBaseline?.evaluation.code.queries ?? []);
  const baselineMemory = withGateGroups(lexicalBaseline?.evaluation.memory?.queries ?? []);
  const currentExact = metricsForGateGroup(codeMetrics, "exact");
  const baselineExact = metricsForGateGroup(baselineCode, "exact");
  const currentCodeChallenges = challengeMetrics(codeMetrics);
  const currentMemoryChallenges = challengeMetrics(memoryMetrics);
  const baselineCodeChallenges = challengeMetrics(baselineCode);
  const baselineMemoryChallenges = challengeMetrics(baselineMemory);
  const rankedGate = (current: RankedMetric[], baseline: RankedMetric[]) => {
    const baselineRecall = average(baseline.map((metric) => metric.recall));
    const actualRecall = average(current.map((metric) => metric.recall));
    const baselineNdcg = average(baseline.map((metric) => metric.ndcg));
    const actualNdcg = average(current.map((metric) => metric.ndcg));
    return {
      recall: {
        baseline: baselineRecall,
        required: requiredChallengeRecall(baselineRecall),
        actual: actualRecall,
        absoluteImprovement: round(actualRecall - baselineRecall),
        passed: actualRecall >= requiredChallengeRecall(baselineRecall),
      },
      ndcg: {
        baseline: baselineNdcg,
        required: requiredNdcg(baselineNdcg),
        actual: actualNdcg,
        absoluteImprovement: round(actualNdcg - baselineNdcg),
        passed: actualNdcg >= requiredNdcg(baselineNdcg),
      },
    };
  };
  const codeChallengeGate = rankedGate(currentCodeChallenges, baselineCodeChallenges);
  const memoryChallengeGate = rankedGate(currentMemoryChallenges, baselineMemoryChallenges);
  const combinedChallengeGate = rankedGate(
    [...currentCodeChallenges, ...currentMemoryChallenges],
    [...baselineCodeChallenges, ...baselineMemoryChallenges],
  );
  const macroEvidenceCoverage = round(
    contextMetrics.reduce((sum, metric) => sum + Number(metric.evidenceCoverage), 0) /
      Math.max(1, contextMetrics.length),
  );
  const macroDuplicateWaste = round(
    contextMetrics.reduce((sum, metric) => sum + Number(metric.duplicateWaste), 0) /
      Math.max(1, contextMetrics.length),
  );
  const deterministic = [
    ...codeMetrics.map((metric) => metric.deterministic),
    ...memoryMetrics.map((metric) => metric.deterministic),
    ...contextMetrics.map((metric) => Boolean(metric.deterministic)),
  ].every(Boolean);
  const baselineContext = lexicalBaseline?.evaluation.context;
  const gateChecks = semanticModelPath
    ? {
        exactRecallAt5: {
          actual: average(currentExact.map((metric) => metric.recall)),
          minimum: 1,
          passed: currentExact.length > 0 && currentExact.every((metric) => metric.recall === 1),
        },
        exactMrrNoRegression: {
          actual: average(currentExact.map((metric) => metric.reciprocalRank)),
          baseline: average(baselineExact.map((metric) => metric.reciprocalRank)),
          passed:
            average(currentExact.map((metric) => metric.reciprocalRank)) >=
            average(baselineExact.map((metric) => metric.reciprocalRank)),
        },
        codeSemanticChallengeRecallAt10: codeChallengeGate.recall,
        codeSemanticChallengeNdcgAt10: codeChallengeGate.ndcg,
        memorySemanticChallengeRecallAt10: memoryChallengeGate.recall,
        memorySemanticChallengeNdcgAt10: memoryChallengeGate.ndcg,
        combinedSemanticChallengeNdcgAt10: combinedChallengeGate.ndcg,
        contextEvidenceCoverageAt2000: {
          actual: macroEvidenceCoverage,
          baseline: baselineContext?.macroEvidenceCoverage ?? 0,
          minimum: 0.8,
          minimumDelta: 0.1,
          passed:
            macroEvidenceCoverage >= 0.8 &&
            macroEvidenceCoverage - (baselineContext?.macroEvidenceCoverage ?? 0) >= 0.1,
        },
        inactiveMemoryReturned: { actual: returnedInactiveIds.size, maximum: 0, passed: returnedInactiveIds.size === 0 },
        duplicateWaste: {
          actual: macroDuplicateWaste,
          baseline: baselineContext?.macroDuplicateWaste ?? 0,
          maximum: 0.1,
          minimumRelativeReduction:
            (baselineContext?.macroDuplicateWaste ?? 0) >= 0.01 ? 0.3 : "not_applicable",
          passed:
            macroDuplicateWaste <= 0.1 &&
            ((baselineContext?.macroDuplicateWaste ?? 0) < 0.01 ||
              macroDuplicateWaste <= (baselineContext?.macroDuplicateWaste ?? 0) * 0.7),
        },
        deterministic20Runs: { actual: deterministic, expected: true, passed: deterministic },
        warmSearchP95Ms: { actual: searchP95Ms, maximum: 250, passed: searchP95Ms <= 250 },
        warmGetContextP95Ms: { actual: getContextP95Ms, maximum: 350, passed: getContextP95Ms <= 350 },
      }
    : {};
  const gatesPassed = Object.values(gateChecks).every((check) => check.passed);
  const generatedAt = fixture.version === 2
    ? sourceDateEpochIso(process.env.SOURCE_DATE_EPOCH)
    : new Date().toISOString();
  const goldDigest = sha256Bytes(
    Buffer.from(canonicalControlJson(fixture.queries as unknown as CanonicalJsonValue), "utf8"),
  );
  const result = {
    schemaVersion: fixture.version === 2 ? 2 : 1,
    evaluatorVersion: fixture.version === 2 ? "acceptance-v2@2" : "acceptance-v1@1",
    fixture: {
      name: fixture.name,
      version: fixture.version,
      immutable: fixture.immutable,
      sha256: checksum,
      digestVersion: fixture.version === 2 ? "lf-normalized-v1" : "raw-v1",
      goldDigest,
    },
    baseline: {
      mode: semanticModelPath ? "semantic-enabled" : "semantic-disabled",
      commit: gitCommit,
      generatedAt,
      phase3SourceCommit:
        !semanticModelPath
          ? gitCommit
          : lexicalBaseline?.baseline.phase3SourceCommit ?? lexicalBaseline?.baseline.commit ?? null,
      baselineToolCommit: baselineToolCommit || null,
      fixtureCommit: fixtureCommit || null,
      lexicalReferenceCommit: lexicalBaseline?.baseline.commit ?? null,
      lexicalReferenceDigest:
        (lexicalBaseline as (BaselineEvaluation & { baselineDigest?: string }) | null)?.baselineDigest ?? null,
    },
    environment: {
      platform: process.platform,
      release: os.release(),
      architecture: process.arch,
      cpu: os.cpus()[0]?.model ?? "unknown",
      logicalCpuCount: os.cpus().length,
      ramBytes: os.totalmem(),
      node: process.version,
      npm: npmVersion,
      resolvedBackend: runtime?.resolvedBackend ?? "disabled",
      requestedSessionOptions: runtime?.requestedSessionOptions ?? null,
      requestedExecutionProviders: runtime?.requestedExecutionProviders ?? [],
      effectiveExecutionProvider: runtime?.effectiveExecutionProvider ?? "not_applicable",
      effectiveIntraOpThreads: runtime?.effectiveIntraOpThreads ?? "not_applicable",
      effectiveInterOpThreads: runtime?.effectiveInterOpThreads ?? "not_applicable",
      verificationMethod: [
        ...(runtime?.verificationMethod ?? ["semantic_disabled_control"]),
        ...(semanticModelPath ? ["network_denied"] : []),
      ],
      modelManifestDigest: semanticModelPath ? APPROVED_MODEL_KEY : null,
      transformersVersion: semanticModelPath ? APPROVED_MODEL_MANIFEST.backend.version : null,
      onnxruntimeNodeVersion: semanticModelPath ? APPROVED_MODEL_MANIFEST.backend.moduleVersion : null,
    },
    corpus: {
      checksum: sha256(corpus.files.map((file) => `${file.path}\0${file.content}`).join("\0")),
      files: status.data.counts.files,
      symbols: status.data.counts.nodes,
      memories: status.data.counts.memories,
      tokenEstimate: normalizedTokens(corpus.files.map((file) => file.content).join("\n")).length,
      embeddingTokens: semanticModelPath
        ? normalizedTokens(
            [
              ...corpus.files.map((file) => file.content),
              ...corpus.memories.map((memory) => memory.draft.content),
            ].join("\n"),
          ).length
        : 0,
    },
    evaluation: {
      relevanceThreshold: 2,
      ndcgGain: "2^grade-1",
      tieBreak: "rankScore(round(score*1e5)), then canonical-id-ascending; public scoreMicro=round(score*1e6)",
      code: { aggregate: aggregateRanked(codeMetrics), queries: codeMetrics },
      memory: { aggregate: aggregateRanked(memoryMetrics), queries: memoryMetrics },
      context: {
        macroEvidenceCoverage,
        microEvidenceCoverage: round(
          contextRelevantTotal === 0 ? 1 : contextRelevantCovered / contextRelevantTotal,
        ),
        macroDuplicateWaste,
        queries: contextMetrics,
      },
    },
    performance: {
      warmups: 5,
      samples: 50,
      p95Method: "sort-ascending-index-floor(n*0.95)",
      searchP95Ms,
      getContextP95Ms,
    },
    gates: {
      evaluated: Boolean(semanticModelPath),
      passed: semanticModelPath ? gatesPassed : null,
      checks: gateChecks,
    },
  };
  if (fixture.version === 2) {
    const digested = addBaselineDigest(result as unknown as Record<string, CanonicalJsonValue>);
    const serialized = serializeCanonicalArtifact(digested);
    if (outputPath) {
      mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
      writeFileSync(path.resolve(outputPath), serialized);
    } else {
      process.stdout.write(serialized);
    }
  } else {
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    if (outputPath) {
      mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
      writeFileSync(path.resolve(outputPath), serialized, "utf8");
    } else {
      process.stdout.write(serialized);
    }
  }
  if (semanticModelPath && !gatesPassed) throw new Error("Phase 4 acceptance quality gate failed");
} finally {
  await app.close();
  restoreNetwork();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}
}
