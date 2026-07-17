import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { ContextMeshApp } from "../src/app.js";
import type { EmbeddingBackend, SemanticRuntimeDiagnostics } from "../src/semantic/backend.js";
import { APPROVED_MODEL_KEY, APPROVED_MODEL_MANIFEST } from "../src/semantic/manifest.js";
import { encodeVector } from "../src/semantic/vector-codec.js";

function integerArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const parsed = index >= 0 ? Number(process.argv[index + 1]) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

const ENTITY_COUNT = integerArgument("--entities", 50_000);
const SAMPLE_COUNT = integerArgument("--samples", 50);
const LIMIT_MS = 2_000;
const LIMIT_RSS_MIB = 100;
const MIB = 1024 * 1024;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function p95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

class HydrationBackend implements EmbeddingBackend {
  readonly modelKey = APPROVED_MODEL_KEY;
  readonly dimensions = APPROVED_MODEL_MANIFEST.model.dimensions;
  readonly manifest = APPROVED_MODEL_MANIFEST;
  readonly diagnostics: SemanticRuntimeDiagnostics = {
    requestedSessionOptions: APPROVED_MODEL_MANIFEST.backend.requestedSessionOptions,
    resolvedBackend: "fake-hydration",
    requestedExecutionProviders: APPROVED_MODEL_MANIFEST.backend.requestedExecutionProviders,
    effectiveExecutionProvider: "cpu",
    effectiveIntraOpThreads: 4,
    effectiveInterOpThreads: "not_applicable",
    verificationMethod: ["fake_backend", "sqlite_application_cold_hydration"],
    observedModelPath: "fake/model_quantized.onnx",
    observedModelSha256: APPROVED_MODEL_MANIFEST.files[0]!.sha256,
  };

  async embedQuery(): Promise<Float32Array> {
    const vector = new Float32Array(this.dimensions);
    vector[0] = 1;
    return vector;
  }

  async embedPassages(): Promise<Float32Array[]> {
    throw new Error("Hydration benchmark must not backfill a ready plane");
  }

  async dispose(): Promise<void> {}
}

async function hydrateOnce(root: string, databasePath: string): Promise<number> {
  const started = performance.now();
  const app = new ContextMeshApp(root, databasePath, {
    semantic: { modelPath: "fake", backendFactory: async () => new HydrationBackend() },
  });
  let duration = 0;
  try {
    const result = app.semantic!.warmCache("memory");
    if (result.validEmbeddingCount !== ENTITY_COUNT || result.invalidRows !== 0) {
      throw new Error("Application-cold hydration did not load the expected SQLite rows");
    }
    duration = performance.now() - started;
  } finally {
    await app.close();
  }
  return duration;
}

async function rssChild(root: string, databasePath: string): Promise<void> {
  const app = new ContextMeshApp(root, databasePath, {
    semantic: { modelPath: "fake", backendFactory: async () => new HydrationBackend() },
  });
  try {
    // The release contract measures the resident increment of one hydrated plane,
    // not Node, SQLite, migrations, or the application shell itself.
    for (let pass = 0; pass < 3; pass += 1) {
      globalThis.gc?.();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const before = process.memoryUsage();
    const result = app.semantic!.warmCache("memory");
    if (result.validEmbeddingCount !== ENTITY_COUNT || result.invalidRows !== 0) {
      throw new Error("RSS hydration did not load the expected SQLite rows");
    }
    for (let pass = 0; pass < 5; pass += 1) {
      globalThis.gc?.();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const after = process.memoryUsage();
    process.stdout.write(JSON.stringify({
      rssMiB: (after.rss - before.rss) / MIB,
      heapUsedMiB: (after.heapUsed - before.heapUsed) / MIB,
      externalMiB: (after.external - before.external) / MIB,
      arrayBuffersMiB: (after.arrayBuffers - before.arrayBuffers) / MIB,
    }));
  } finally {
    await app.close();
  }
}

if (process.argv.includes("--rss-child")) {
  const root = process.argv[process.argv.indexOf("--rss-child") + 1];
  const databasePath = process.argv[process.argv.indexOf("--rss-child") + 2];
  if (!root || !databasePath) throw new Error("RSS child requires root and database path");
  await rssChild(root, databasePath);
} else {
  const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-hydration-benchmark-"));
  const databasePath = path.join(root, "hydration.sqlite3");
  try {
    const bootstrap = new ContextMeshApp(root, databasePath, {
      semantic: { modelPath: "fake", backendFactory: async () => new HydrationBackend() },
    });
    await bootstrap.close();
    const database = new DatabaseSync(databasePath, { readBigInts: true });
    try {
      const workspace = database.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string };
      const semanticWorkspace = database.prepare("SELECT workspace_key FROM semantic_workspaces LIMIT 1").get() as {
        workspace_key: bigint;
      };
      const model = database.prepare("SELECT model_id FROM semantic_models WHERE model_key = ?").get(APPROVED_MODEL_KEY) as {
        model_id: bigint;
      };
      const vector = new Float32Array(APPROVED_MODEL_MANIFEST.model.dimensions);
      vector[0] = 1;
      const encoded = encodeVector(vector);
      const insertMemory = database.prepare(
        `INSERT INTO memory_fragments(
           id, workspace_id, type, topic, content, keywords_json, importance, is_anchor,
           assertion_status, state, content_hash, created_at, updated_at, semantic_source_hash
         ) VALUES (?, ?, 'fact', 'hydration', ?, '["vector"]', 3, 0, 'observed', 'active', ?, ?, ?, ?)`,
      );
      const insertEmbedding = database.prepare(
        `INSERT INTO semantic_embeddings(
           workspace_key, plane, entity_key, source_hash, model_id, generation, vector
         ) VALUES (?, 'memory', ?, ?, ?, NULL, ?)`,
      );
      const timestamp = "2026-01-01T00:00:00.000Z";
      database.exec("BEGIN IMMEDIATE");
      try {
        for (let index = 0; index < ENTITY_COUNT; index += 1) {
          const id = `hydration-${index.toString().padStart(5, "0")}`;
          const content = `hydration vector ${index}`;
          const passage = `type: fact\ntopic: hydration\nkeywords: vector\ncontent: ${content}\nassertion_status: observed`;
          const sourceHash = sha256(passage);
          insertMemory.run(id, workspace.id, content, sha256(content), timestamp, timestamp, sourceHash);
          insertEmbedding.run(
            semanticWorkspace.workspace_key,
            Buffer.from(id, "utf8"),
            Buffer.from(sourceHash, "hex"),
            model.model_id,
            encoded,
          );
        }
        database.prepare(
          `UPDATE workspace_semantic_state SET semantic_revision = 1, status = 'ready',
             eligible_entity_count = ?, valid_embedding_count = ?, last_error = NULL,
             failure_class = NULL, normalized_error_code = NULL, failure_fingerprint = NULL,
             diagnostics_json = '[]'
           WHERE plane = 'memory'`,
        ).run(ENTITY_COUNT, ENTITY_COUNT);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }

    const firstHydrationMs = await hydrateOnce(root, databasePath);
    const samples: number[] = [];
    for (let index = 0; index < SAMPLE_COUNT; index += 1) samples.push(await hydrateOnce(root, databasePath));
    const scriptPath = fileURLToPath(import.meta.url);
    const rss = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--expose-gc",
          "--import",
          "tsx",
          scriptPath,
          "--rss-child",
          root,
          databasePath,
          "--entities",
          String(ENTITY_COUNT),
          "--samples",
          "1",
        ],
        { encoding: "utf8" },
      ),
    ) as { rssMiB: number; heapUsedMiB: number; externalMiB: number; arrayBuffersMiB: number };
    const result = {
      entities: ENTITY_COUNT,
      dimensions: APPROVED_MODEL_MANIFEST.model.dimensions,
      cacheMode: "new ContextMeshApp + new SemanticService + new SQLite connection per sample",
      firstHydrationMs: round(firstHydrationMs),
      coldHydrationP95Ms: round(p95(samples)),
      samples: SAMPLE_COUNT,
      rssMeasurement: "fresh child process, plane-cache delta after app/SQLite initialization, stabilized after gc",
      cacheRssMiB: round(rss.rssMiB),
      cacheMemoryBreakdownMiB: {
        heapUsed: round(rss.heapUsedMiB),
        external: round(rss.externalMiB),
        arrayBuffers: round(rss.arrayBuffersMiB),
      },
      limits: { coldHydrationP95Ms: LIMIT_MS, cacheRssMiB: LIMIT_RSS_MIB },
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (p95(samples) > LIMIT_MS || rss.rssMiB > LIMIT_RSS_MIB) {
      throw new Error("SQLite application-cold hydration exceeded a Phase 4 release limit");
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
}
