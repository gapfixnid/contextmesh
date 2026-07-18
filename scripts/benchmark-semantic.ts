import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope, MemoryFragmentRecord } from "../src/contracts.js";
import {
  scanNormalizedMatrix,
  type EncodedEntityIds,
} from "../src/semantic/exact-scan.js";
import { APPROVED_MODEL_KEY, APPROVED_MODEL_MANIFEST } from "../src/semantic/manifest.js";
import { createTransformersEmbeddingBackend } from "../src/semantic/transformers-backend.js";
import { decodeVectorInto, encodeVector } from "../src/semantic/vector-codec.js";

const ENTITY_COUNT = 50_000;
const DIMENSIONS = APPROVED_MODEL_MANIFEST.model.dimensions;
const MIB = 1024 * 1024;
const limits = {
  scanP95Ms: 150,
  hydrationMs: 2_000,
  cacheRssMiB: 100,
  coldModelLoadMs: 10_000,
  modelRssMiB: 500,
  coldSemanticIndexMs: 45_000,
  readyNoOpMs: 2_000,
  warmSemanticSearchP95Ms: 250,
  warmGetContextP95Ms: 350,
  embeddingDbBytesPerEntity: 2_048,
};

function percentile95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function semanticStorageStats(databasePath: string): {
  pageSize: number;
  embeddingTableBytes: number;
  embeddingPayloadBytes: number;
  embeddingPages: number;
} {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const pageSize = database.prepare("PRAGMA page_size").get() as { page_size: number };
    const row = database
      .prepare(
        `SELECT coalesce(sum(pgsize), 0) AS bytes,
                coalesce(sum(payload), 0) AS payload_bytes,
                count(*) AS pages
         FROM dbstat WHERE name = 'semantic_embeddings'`,
      )
      .get() as { bytes: number; payload_bytes: number; pages: number };
    return {
      pageSize: pageSize.page_size,
      embeddingTableBytes: row.bytes,
      embeddingPayloadBytes: row.payload_bytes,
      embeddingPages: row.pages,
    };
  } finally {
    database.close();
  }
}

function modelPathArgument(): string | null {
  const index = process.argv.indexOf("--model-path");
  const value = index >= 0 ? process.argv[index + 1] : process.env.CONTEXTMESH_SEMANTIC_MODEL;
  return value ? path.resolve(value) : null;
}

globalThis.gc?.();
const rssBeforeCache = process.memoryUsage().rss;
const entityIdBytes = new Uint8Array(ENTITY_COUNT * 64);
entityIdBytes.fill("0".charCodeAt(0));
const entityIdOffsets = new Uint32Array(ENTITY_COUNT + 1);
for (let index = 0; index < ENTITY_COUNT; index += 1) {
  const hex = index.toString(16);
  const offset = index * 64;
  for (let character = 0; character < hex.length; character += 1) {
    entityIdBytes[offset + 64 - hex.length + character] = hex.charCodeAt(character);
  }
  entityIdOffsets[index + 1] = offset + 64;
}
const entityIds: EncodedEntityIds = {
  bytes: entityIdBytes,
  offsets: entityIdOffsets,
  count: ENTITY_COUNT,
};
const sourceHashBytes = new Uint8Array(ENTITY_COUNT * 32);
for (let index = 0; index < ENTITY_COUNT; index += 1) {
  let value = index + ENTITY_COUNT;
  for (let byte = 31; byte >= 0 && value > 0; byte -= 1) {
    sourceHashBytes[index * 32 + byte] = value & 0xff;
    value = Math.floor(value / 256);
  }
}
const row = new Float32Array(DIMENSIONS);
row[0] = Math.fround(1 / Math.sqrt(2));
row[1] = Math.fround(1 / Math.sqrt(2));
const encoded = encodeVector(row, DIMENSIONS);
const hydrationStarted = performance.now();
const matrix = new Float32Array(ENTITY_COUNT * DIMENSIONS);
for (let index = 0; index < ENTITY_COUNT; index += 1) {
  decodeVectorInto(encoded, DIMENSIONS, matrix, index * DIMENSIONS);
}
const hydrationMs = performance.now() - hydrationStarted;
globalThis.gc?.();
const cacheRssMiB = (process.memoryUsage().rss - rssBeforeCache) / MIB;
const sourceHashes = Array.from({ length: ENTITY_COUNT }, (_, index) =>
  (index + ENTITY_COUNT).toString(16).padStart(64, "0"),
);
const eligible = new Map(
  sourceHashes.map((sourceHash, index) => [index.toString(16).padStart(64, "0"), sourceHash]),
);

const query = new Float32Array(DIMENSIONS);
query[0] = 1;
for (let index = 0; index < 5; index += 1) {
  scanNormalizedMatrix(matrix, entityIds, sourceHashBytes, eligible, query, DIMENSIONS, 100);
}
const scanDurations: number[] = [];
for (let index = 0; index < 50; index += 1) {
  const started = performance.now();
  const result = scanNormalizedMatrix(matrix, entityIds, sourceHashBytes, eligible, query, DIMENSIONS, 100);
  if (result.validEmbeddingCount !== ENTITY_COUNT || result.rows.length !== 100) {
    throw new Error("The exact-scan benchmark did not scan the expected matrix");
  }
  scanDurations.push(performance.now() - started);
}
const scanP95Ms = percentile95(scanDurations);

const configuredModelPath = modelPathArgument();
let actualModel: Record<string, unknown> | null = null;
let actualModelGateFailed = false;
if (configuredModelPath) {
  globalThis.gc?.();
  const rssBeforeModel = process.memoryUsage().rss;
  const loadStarted = performance.now();
  const backend = await createTransformersEmbeddingBackend(configuredModelPath);
  const coldModelLoadMs = performance.now() - loadStarted;
  try {
    const inferenceStarted = performance.now();
    const vector = await backend.embedQuery("measure an offline semantic query");
    const inferenceMs = performance.now() - inferenceStarted;
    globalThis.gc?.();
    const modelRssMiB = (process.memoryUsage().rss - rssBeforeModel) / MIB;
    actualModel = {
      coldModelLoadMs: rounded(coldModelLoadMs),
      inferenceMs: rounded(inferenceMs),
      modelRssMiB: rounded(modelRssMiB),
      dimensions: vector.length,
      diagnostics: backend.diagnostics,
    };
    actualModelGateFailed ||= coldModelLoadMs > limits.coldModelLoadMs || modelRssMiB > limits.modelRssMiB;
  } finally {
    await backend.dispose();
  }

  const workspace = mkdtempSync(path.join(os.tmpdir(), "contextmesh-semantic-benchmark-"));
  try {
  const sourceDirectory = path.join(workspace, "src");
  mkdirSync(sourceDirectory, { recursive: true });
  writeFileSync(
    path.join(workspace, "tsconfig.json"),
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
  for (let fileIndex = 0; fileIndex < 1_000; fileIndex += 1) {
    const content = fileIndex === 0
      ? "/** Computes the root cached pricing value. */\nexport function computeValue0(input: number): number { return input; }\n"
      : `import { computeValue${fileIndex - 1} } from "./values-${fileIndex - 1}.js";\n` +
        `/** Computes cached pricing value ${fileIndex} through the dependency chain. */\n` +
        `export function computeValue${fileIndex}(input: number): number { return computeValue${fileIndex - 1}(input) + 1; }\n`;
    writeFileSync(path.join(sourceDirectory, `values-${fileIndex}.ts`), content, "utf8");
  }

  const lexicalDb = path.join(workspace, "lexical.sqlite3");
  const lexicalApp = new ContextMeshApp(workspace, lexicalDb);
  try {
    await lexicalApp.indexWorkspace({ mode: "full" });
  } finally {
    await lexicalApp.close();
  }
  const lexicalDbBytes = statSync(lexicalDb).size;

  const semanticDb = path.join(workspace, "semantic.sqlite3");
  copyFileSync(lexicalDb, semanticDb);
  const semanticBaselineDbBytes = statSync(semanticDb).size;
  const semanticBaselineStorage = semanticStorageStats(semanticDb);
  let coldSemanticIndexMs = 0;
  let readyNoOpMs = 0;
  let readyNoOpBackendFactoryCalls = 0;
  let warmSemanticSearchP95Ms = 0;
  let warmGetContextP95Ms = 0;
  let embeddingCount = 0;
  let semanticDbBytes = 0;
  let crossPlaneWorkload: Record<string, unknown> | null = null;
  const coldIndexStarted = performance.now();
  let semanticApp = new ContextMeshApp(workspace, semanticDb, {
    semantic: { modelPath: configuredModelPath },
  });
  try {
    await semanticApp.indexWorkspace({ mode: "incremental" });
    coldSemanticIndexMs = performance.now() - coldIndexStarted;
    embeddingCount = semanticApp.database.loadSemanticEmbeddings("code", APPROVED_MODEL_KEY).length;
  } finally {
    await semanticApp.close();
  }
  semanticDbBytes = statSync(semanticDb).size;
  const semanticStorage = semanticStorageStats(semanticDb);
  const embeddingDbBytesPerEntity =
    embeddingCount === 0 ? Number.POSITIVE_INFINITY : (semanticDbBytes - semanticBaselineDbBytes) / embeddingCount;

  semanticApp = new ContextMeshApp(workspace, semanticDb, {
    semantic: { modelPath: configuredModelPath },
  });
  try {
    const terminal = semanticApp.database.searchCode("computeValue999", ["function"], 1)[0];
    if (!terminal) throw new Error("Cross-plane benchmark could not find computeValue999");
    const crossPlaneQuery =
      "how does computeValue998 supply computeValue999 cached pricing retained dependency values";
    const memoryTypes = ["fact", "decision", "error", "preference", "procedure", "relation", "episode"] as const;
    const linkedMemoryIds: string[] = [];
    for (let index = 0; index < 64; index += 1) {
      const type = memoryTypes[index % memoryTypes.length]!;
      const remembered = await semanticApp.remember({
        content: index % 2 === 0
          ? `Cached pricing dependency values are retained by ${type} policy variant ${index}.`
          : `The ${type} record ${index} preserves retained values for the cached pricing chain.`,
        topic: `semantic benchmark ${type}`,
        type,
        keywords: ["cached", "pricing", "retained", type],
        sourceSymbolIds: [terminal.id],
      }) as Envelope<{ fragment: MemoryFragmentRecord }>;
      linkedMemoryIds.push(remembered.data.fragment.id);
    }
    await semanticApp.remember({
      content: `softreservationprobe ${"oversized-memory-padding ".repeat(150)}`,
      topic: "soft reservation pressure",
      type: "fact",
      keywords: ["softreservationprobe"],
      sourceSymbolIds: [],
    });

    let softReservationProbe: Record<string, unknown> | null = null;
    for (let tokenBudget = 256; tokenBudget <= 2_000; tokenBudget += 128) {
      const codeOnly = await semanticApp.getContext({
        query: "softreservationprobe",
        symbolId: terminal.id,
        include: ["code"],
        tokenBudget,
      }) as Envelope<{ code: Array<{ id: string }>; memories: unknown[] }>;
      if (!codeOnly.data.code.some((node) => node.id === terminal.id)) continue;
      const crossPlane = await semanticApp.getContext({
        query: "softreservationprobe",
        symbolId: terminal.id,
        include: ["code", "memory"],
        tokenBudget,
      }) as Envelope<{ code: Array<{ id: string }>; memories: unknown[] }>;
      const diagnostics = semanticApp.contextPackingDiagnostics();
      if (
        crossPlane.data.code.some((node) => node.id === terminal.id) &&
        crossPlane.data.memories.length === 0 &&
        crossPlane.truncated &&
        diagnostics.softReservationEvaluations > 0 &&
        diagnostics.softReservationBudgetRejections > 0
      ) {
        softReservationProbe = { tokenBudget, ...diagnostics };
        break;
      }
    }
    if (!softReservationProbe) {
      throw new Error("Cross-plane benchmark did not observe a pinned-safe soft-reservation budget rejection");
    }

    const searchDurations: number[] = [];
    const contextDurations: number[] = [];
    for (let index = 0; index < 55; index += 1) {
      const searchStarted = performance.now();
      await semanticApp.searchCode({ query: "compute cached pricing value 42", limit: 20 });
      if (index >= 5) searchDurations.push(performance.now() - searchStarted);
    }
    for (let index = 0; index < 55; index += 1) {
      const contextStarted = performance.now();
      await semanticApp.getContext({
        query: crossPlaneQuery,
        symbolId: terminal.id,
        include: ["code", "memory"],
        tokenBudget: 8000,
      });
      if (index >= 5) contextDurations.push(performance.now() - contextStarted);
    }
    warmSemanticSearchP95Ms = percentile95(searchDurations);
    warmGetContextP95Ms = percentile95(contextDurations);
    const semanticCandidates = await semanticApp.semantic!.searchContext(
      crossPlaneQuery,
      true,
      true,
      100,
    );
    const assembled = semanticApp.context.assembleDatabase(
      {
        query: crossPlaneQuery,
        symbolId: terminal.id,
        include: ["code", "memory"],
        tokenBudget: 8000,
      },
      semanticCandidates.code,
      semanticCandidates.memory,
    );
    const packed = await semanticApp.getContext({
      query: crossPlaneQuery,
      symbolId: terminal.id,
      include: ["code", "memory"],
      tokenBudget: 8000,
    }) as { data: { code: Array<{ snippet: string | null }>; memories: unknown[]; relationships: unknown[] } };
    const crossPlanePackingDiagnostics = semanticApp.contextPackingDiagnostics();
    const workspaceStatus = await semanticApp.workspaceStatus() as {
      data: { counts: { files: number; nodes: number; edges: number; memories: number } };
    };
    const paraphraseQuery = "persisted upstream results survive for later dependent calculations";
    const paraphraseCandidates = await semanticApp.semantic!.searchContext(paraphraseQuery, true, true, 100);
    const lexicalParaphraseIds = new Set(
      semanticApp.database.searchCode(paraphraseQuery, undefined, 100).map((candidate) => candidate.id),
    );
    const semanticOnlyParaphraseHits = (paraphraseCandidates.code?.candidates ?? []).filter(
      (candidate) => !lexicalParaphraseIds.has(candidate.id),
    ).length;
    const memoryVectorCount = semanticApp.database.loadSemanticEmbeddings("memory", APPROVED_MODEL_KEY).length;
    const finalPlanes = new Set(assembled.candidates.map((candidate) => candidate.kind));
    const codeMemoryRelationships = [...semanticApp.database.getMemoryCodeProvenance(linkedMemoryIds).values()]
      .reduce((count, links) => count + links.length, 0);
    const unifiedMmrCodeInputs = assembled.rankingDiagnostics.inputByNormalizationGroup.code ?? 0;
    const unifiedMmrMemoryInputs = assembled.rankingDiagnostics.inputByNormalizationGroup.memory ?? 0;
    const observedWorkload = {
      files: workspaceStatus.data.counts.files,
      memoryVectorCount,
      finalPlanes: [...finalPlanes].sort(),
      packedCode: packed.data.code.length,
      packedMemory: packed.data.memories.length,
      packedRelationships: packed.data.relationships.length,
      assembledCandidates: assembled.candidates.length,
      codeMemoryRelationships,
      rankingDiagnostics: assembled.rankingDiagnostics,
      semanticOnlyParaphraseHits,
      softReservationProbe,
      crossPlanePackingDiagnostics,
    };
    if (
      workspaceStatus.data.counts.files !== 1_000 ||
      memoryVectorCount < 64 ||
      !finalPlanes.has("code") ||
      !finalPlanes.has("memory") ||
      packed.data.code.length === 0 ||
      packed.data.memories.length === 0 ||
      packed.data.relationships.length === 0 ||
      codeMemoryRelationships !== linkedMemoryIds.length ||
      unifiedMmrCodeInputs === 0 ||
      unifiedMmrMemoryInputs === 0 ||
      assembled.rankingDiagnostics.nearDuplicatePairs === 0 ||
      semanticOnlyParaphraseHits === 0 ||
      crossPlanePackingDiagnostics.softReservationEvaluations === 0 ||
      crossPlanePackingDiagnostics.softReservationFits === 0
    ) {
      throw new Error(
        `Cross-plane get_context benchmark did not exercise its required workload: ${JSON.stringify(observedWorkload)}`,
      );
    }
    crossPlaneWorkload = {
      files: workspaceStatus.data.counts.files,
      codeNodes: workspaceStatus.data.counts.nodes,
      codeVectors: semanticApp.database.loadSemanticEmbeddings("code", APPROVED_MODEL_KEY).length,
      graphEdges: workspaceStatus.data.counts.edges,
      ftsCandidates: semanticApp.database.searchCode("computeValue999 cached pricing", undefined, 100).length,
      memoryVectors: memoryVectorCount,
      memoryTypes: memoryTypes.length,
      codeMemoryRelationships,
      unifiedMmrCandidates: assembled.candidates.length,
      unifiedMmrPlanes: [...finalPlanes].sort(),
      unifiedMmrInputByPlane: {
        code: unifiedMmrCodeInputs,
        memory: unifiedMmrMemoryInputs,
      },
      nearDuplicatePairs: assembled.rankingDiagnostics.nearDuplicatePairs,
      hardDeduplicatedCandidates: assembled.rankingDiagnostics.hardDeduplicatedCandidates,
      snippetHydrationCount: packed.data.code.filter((node) => node.snippet !== null).length,
      resultCodeCount: packed.data.code.length,
      resultMemoryCount: packed.data.memories.length,
      resultRelationshipCount: packed.data.relationships.length,
      semanticOnlyParaphraseHits,
      softReservationProbe,
      crossPlanePackingDiagnostics,
    };
  } finally {
    await semanticApp.close();
  }

  semanticApp = new ContextMeshApp(workspace, semanticDb, {
    semantic: {
      modelPath: configuredModelPath,
      backendFactory: async () => {
        readyNoOpBackendFactoryCalls += 1;
        throw new Error("ready/no-op unexpectedly loaded the semantic runtime");
      },
    },
  });
  try {
    const noOpStarted = performance.now();
    await semanticApp.indexWorkspace({ mode: "incremental" });
    readyNoOpMs = performance.now() - noOpStarted;
  } finally {
    await semanticApp.close();
  }

  actualModel = {
    ...actualModel,
    coldSemanticIndexMs: rounded(coldSemanticIndexMs),
    readyNoOpMs: rounded(readyNoOpMs),
    readyNoOpBackendFactoryCalls,
    warmSemanticSearchP95Ms: rounded(warmSemanticSearchP95Ms),
    warmGetContextP95Ms: rounded(warmGetContextP95Ms),
    lexicalDbBytes,
    semanticBaselineDbBytes,
    semanticDbBytes,
    semanticBaselineStorage,
    semanticStorage,
    embeddingCount,
    embeddingDbBytesPerEntity: rounded(embeddingDbBytesPerEntity),
    crossPlaneWorkload,
  };
  actualModelGateFailed ||=
    coldSemanticIndexMs > limits.coldSemanticIndexMs ||
    readyNoOpMs > limits.readyNoOpMs ||
    readyNoOpBackendFactoryCalls !== 0 ||
    warmSemanticSearchP95Ms > limits.warmSemanticSearchP95Ms ||
    warmGetContextP95Ms > limits.warmGetContextP95Ms ||
    embeddingDbBytesPerEntity > limits.embeddingDbBytesPerEntity;
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5 });
  }
}

const result = {
  entities: ENTITY_COUNT,
  dimensions: DIMENSIONS,
  warmups: 5,
  samples: 50,
  p95Method: "sort-ascending-index-floor(n*0.95)",
  hydrationMs: rounded(hydrationMs),
  scanP95Ms: rounded(scanP95Ms),
  cacheRssMiB: rounded(cacheRssMiB),
  actualModel,
  limits,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (
  hydrationMs > limits.hydrationMs ||
  scanP95Ms > limits.scanP95Ms ||
  cacheRssMiB > limits.cacheRssMiB ||
  actualModelGateFailed
) {
  throw new Error("The semantic matrix benchmark exceeded one or more Phase 4 limits");
}
