import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope } from "../src/contracts.js";
import type { ContextCodeItem, ContextMemoryItem } from "../src/context/assembler.js";
import {
  APPROVED_MODEL_KEY,
  APPROVED_MODEL_MANIFEST,
  modelMaterialFingerprint,
} from "../src/semantic/manifest.js";
import { createTransformersEmbeddingBackend } from "../src/semantic/transformers-backend.js";

const FILE_COUNT = 1_000;
const MEMORY_COUNT = 64;
const WARMUPS = 5;
const SAMPLES = 50;
const limits = { searchCodeP95Ms: 100, getContextP95Ms: 150 };

function modelPathArgument(): string {
  const index = process.argv.indexOf("--model-path");
  const configured = index >= 0 ? process.argv[index + 1] : process.env.CONTEXTMESH_SEMANTIC_MODEL;
  if (!configured) {
    throw new Error("Pass --model-path or set CONTEXTMESH_SEMANTIC_MODEL for the material-corruption benchmark");
  }
  return path.resolve(configured);
}

function searchRankingState(result: Envelope<{ results: Array<{ id: string; score: number }>; nextOffset: number | null }>): string {
  return JSON.stringify({
    results: result.data.results.map((node) => [node.id, node.score]),
    nextOffset: result.data.nextOffset,
    truncated: result.truncated,
  });
}

function contextRankingState(result: Envelope<{
  code: ContextCodeItem[];
  memories: ContextMemoryItem[];
  relationships: Array<{ sourceId: string; targetId: string; kind: string; depth: number }>;
}>): string {
  return JSON.stringify({
    code: result.data.code.map((node) => [node.id, node.score, node.source]),
    memories: result.data.memories.map((memory) => [memory.id, memory.source]),
    relationships: result.data.relationships.map((edge) => [edge.sourceId, edge.targetId, edge.kind, edge.depth]),
    truncated: result.truncated,
  });
}

function p95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-unavailable-benchmark-"));
const sourceDirectory = path.join(root, "src");
mkdirSync(sourceDirectory, { recursive: true });
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
for (let index = 0; index < FILE_COUNT; index += 1) {
  const content =
    index === 0
      ? "export function symbol0(value: number): number { return value; }\n"
      : index === FILE_COUNT - 1
        ? `import { symbol${index - 1} } from "./file${index - 1}.js";\n` +
          `export function localStep${index}(value: number): number { return value + 1; }\n` +
          `/** Computes retry fallback chain value ${index}. */\n` +
          `export function symbol${index}(value: number): number { return localStep${index}(symbol${index - 1}(value)); }\n`
        : `import { symbol${index - 1} } from "./file${index - 1}.js";\n` +
        `/** Computes retry fallback chain value ${index}. */\n` +
        `export function symbol${index}(value: number): number { return symbol${index - 1}(value) + 1; }\n`;
  writeFileSync(path.join(sourceDirectory, `file${index}.ts`), content, "utf8");
}

let app = new ContextMeshApp(root);
try {
  await app.indexWorkspace({ mode: "full" });
  const terminal = app.database.searchCode(`symbol${FILE_COUNT - 1}`, ["function"], 1)[0];
  if (!terminal) throw new Error("Unavailable benchmark could not find the terminal symbol");
  const memoryTypes = ["fact", "decision", "error", "preference", "procedure", "relation", "episode"] as const;
  for (let index = 0; index < MEMORY_COUNT; index += 1) {
    const type = memoryTypes[index % memoryTypes.length]!;
    await app.remember({
      content:
        index % 2 === 0
          ? `The symbol999 retry fallback chain retains operational ${type} evidence variant ${index}.`
          : `Operational ${type} evidence ${index} is retained for the terminal retry chain symbol999.`,
      topic: `symbol999 unavailable fallback ${type}`,
      type,
      keywords: ["symbol999", "retry", "fallback", type],
      importance: 3,
      sourceSymbolIds: [terminal.id],
    });
  }
  const baselineSearch = await app.searchCode({ query: "symbol999 retry fallback", limit: 20 }) as Envelope<{
    results: Array<{ id: string; score: number }>;
    nextOffset: number | null;
  }>;
  const baselineContext = await app.getContext({
    query: "symbol999",
    symbolId: terminal.id,
    include: ["code", "memory"],
    tokenBudget: 8_000,
  }) as Envelope<{
    code: ContextCodeItem[];
    memories: ContextMemoryItem[];
    relationships: Array<{ sourceId: string; targetId: string; kind: string; depth: number }>;
  }>;
  const expectedSearchState = searchRankingState(baselineSearch);
  const expectedContextState = contextRankingState(baselineContext);
  const databasePath = app.database.dbPath;
  await app.close();

  const corruptedModelPath = path.join(root, "corrupted-approved-model");
  cpSync(modelPathArgument(), corruptedModelPath, { recursive: true });
  const corruptionTarget = APPROVED_MODEL_MANIFEST.files.at(-1)!;
  const corruptionPath = path.join(corruptedModelPath, corruptionTarget.path);
  const corruptedBytes = readFileSync(corruptionPath);
  if (corruptedBytes.length !== corruptionTarget.sizeBytes || corruptedBytes.length === 0) {
    throw new Error(`Approved corruption target is not valid: ${corruptionTarget.path}`);
  }
  corruptedBytes[0] = (corruptedBytes[0] ?? 0) ^ 0xff;
  writeFileSync(corruptionPath, corruptedBytes);

  let fullValidationCount = 0;
  let metadataProbeCount = 0;
  app = new ContextMeshApp(root, databasePath, {
    semantic: {
      modelPath: corruptedModelPath,
      backendFactory: async (modelPath) => {
        fullValidationCount += 1;
        return createTransformersEmbeddingBackend(modelPath);
      },
      materialFingerprint: async (modelPath) => {
        metadataProbeCount += 1;
        return modelMaterialFingerprint(modelPath);
      },
    },
  });
  const searchOperation = async (): Promise<void> => {
    const result = await app.searchCode({ query: "symbol999 retry fallback", limit: 20 });
    if (!result.warnings.some((warning) => warning.startsWith("SEMANTIC_UNAVAILABLE"))) {
      throw new Error("Configured-unavailable search omitted the semantic warning");
    }
    if (searchRankingState(result as typeof baselineSearch) !== expectedSearchState) {
      throw new Error("Configured-unavailable search diverged from semantic-off ranking state");
    }
  };
  const contextOperation = async (): Promise<void> => {
    const result = await app.getContext({
      query: "symbol999",
      symbolId: terminal.id,
      include: ["code", "memory"],
      tokenBudget: 8_000,
    }) as Envelope<{
      code: ContextCodeItem[];
      memories: ContextMemoryItem[];
      relationships: Array<{ sourceId: string; targetId: string; kind: string; depth: number }>;
    }>;
    if (!result.warnings.some((warning) => warning.startsWith("SEMANTIC_UNAVAILABLE"))) {
      throw new Error("Configured-unavailable context omitted the semantic warning");
    }
    if (contextRankingState(result) !== expectedContextState) {
      throw new Error("Configured-unavailable context diverged from semantic-off ranking state");
    }
    if (result.data.code.length === 0 || result.data.memories.length === 0 || result.data.relationships.length === 0) {
      const rawTrace = app.database.traceCode(terminal.id, "both", undefined, 1, 50);
      throw new Error(
        `Configured-unavailable context did not preserve fallback results: ${JSON.stringify({
          code: result.data.code.map((node) => node.id),
          memories: result.data.memories.length,
          relationships: result.data.relationships.length,
          rawTraceEdges: rawTrace.edges.map((edge) => [edge.sourceId, edge.targetId]),
          rawTraceNodes: rawTrace.nodes.map((node) => node.id),
        })}`,
      );
    }
  };
  for (let index = 0; index < WARMUPS; index += 1) {
    await searchOperation();
    await contextOperation();
  }
  const stateSnapshot = () => ({
    codeRevision: app.database.getSemanticState("code")?.semanticRevision ?? 0,
    memoryRevision: app.database.getSemanticState("memory")?.semanticRevision ?? 0,
    cacheRevision: [
      app.database.getSemanticState("code")?.semanticRevision ?? 0,
      app.database.getSemanticState("memory")?.semanticRevision ?? 0,
    ],
    embeddingCount:
      app.database.loadSemanticEmbeddings("code", APPROVED_MODEL_KEY).length +
      app.database.loadSemanticEmbeddings("memory", APPROVED_MODEL_KEY).length,
    fullValidationCount,
    metadataProbeCount,
    serviceMaterialProbeCount: app.semantic?.materialProbeDiagnostics().total ?? 0,
    reconciliationClaimCount:
      app.database.getSemanticClaimDiagnostics("code").claimCount +
      app.database.getSemanticClaimDiagnostics("memory").claimCount,
    reconciliationTakeoverCount:
      app.database.getSemanticClaimDiagnostics("code").takeoverCount +
      app.database.getSemanticClaimDiagnostics("memory").takeoverCount,
    reconciliationSupersedeCount:
      app.database.getSemanticClaimDiagnostics("code").supersedeCount +
      app.database.getSemanticClaimDiagnostics("memory").supersedeCount,
  });
  const invariantBefore = stateSnapshot();
  for (let index = 0; index < 20; index += 1) await searchOperation();
  const invariantAfter = stateSnapshot();
  if (JSON.stringify(invariantAfter) !== JSON.stringify(invariantBefore)) {
    throw new Error(`Configured-unavailable control state changed: ${JSON.stringify({ invariantBefore, invariantAfter })}`);
  }
  const searchDurations: number[] = [];
  const contextDurations: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const started = performance.now();
    await searchOperation();
    searchDurations.push(performance.now() - started);
  }
  for (let index = 0; index < SAMPLES; index += 1) {
    const started = performance.now();
    await contextOperation();
    contextDurations.push(performance.now() - started);
  }
  const status = await app.workspaceStatus() as Envelope<{
    counts: { files: number; nodes: number; edges: number; memories: number };
  }>;
  const ftsCandidates = app.database.searchCode("symbol999 retry fallback", undefined, 100).length;
  const searchCodeP95Ms = p95(searchDurations);
  const getContextP95Ms = p95(contextDurations);
  const result = {
    workload: "configured-unavailable-material-sticky",
    files: status.data.counts.files,
    codeNodes: status.data.counts.nodes,
    graphEdges: status.data.counts.edges,
    memories: status.data.counts.memories,
    memoryTypes: 7,
    ftsCandidates,
    warmups: WARMUPS,
    samples: SAMPLES,
    p95Method: "sort-ascending-index-floor(n*0.95)",
    corruptedApprovedFile: corruptionTarget.path,
    searchCodeP95Ms: round(searchCodeP95Ms),
    getContextP95Ms: round(getContextP95Ms),
    invariantBefore,
    invariantAfter,
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      cpu: os.cpus()[0]?.model ?? "unknown",
      logicalCpuCount: os.cpus().length,
      availableRamBytes: os.freemem(),
      totalRamBytes: os.totalmem(),
      powerMode: process.env.CONTEXTMESH_POWER_MODE ?? "not_recorded",
      runnerClass: process.env.CONTEXTMESH_RUNNER_CLASS ?? "unclassified",
    },
    limits,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (searchCodeP95Ms > limits.searchCodeP95Ms || getContextP95Ms > limits.getContextP95Ms) {
    throw new Error("Configured-unavailable benchmark exceeded a Phase 4 fallback limit");
  }
} finally {
  await app.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}
