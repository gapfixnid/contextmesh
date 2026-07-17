import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { ContextMeshApp } from "../src/app.js";
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
  for (let fileIndex = 0; fileIndex < 64; fileIndex += 1) {
    const declarations = Array.from({ length: 16 }, (_, functionIndex) => {
      const id = fileIndex * 16 + functionIndex;
      return `/** Computes cached pricing value ${id}. */\nexport function computeValue${id}(input: number): number { return input + ${id}; }`;
    });
    writeFileSync(path.join(sourceDirectory, `values-${fileIndex}.ts`), `${declarations.join("\n\n")}\n`, "utf8");
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
    await semanticApp.remember({
      content: "Cached pricing values are retained for this semantic context benchmark.",
      topic: "semantic benchmark memory",
      type: "fact",
      keywords: ["cached", "pricing"],
      sourceSymbolIds: [],
    });

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
        query: "how are cached pricing values retained",
        include: ["memory"],
        tokenBudget: 2000,
      });
      if (index >= 5) contextDurations.push(performance.now() - contextStarted);
    }
    warmSemanticSearchP95Ms = percentile95(searchDurations);
    warmGetContextP95Ms = percentile95(contextDurations);
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
