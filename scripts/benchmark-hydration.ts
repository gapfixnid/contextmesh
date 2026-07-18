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
import type { SemanticHydrationProfile } from "../src/semantic/service.js";
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
type BenchmarkPlane = "code" | "memory";

interface HydrationSample {
  durationMs: number;
  appSqliteInitMs: number;
  profile?: SemanticHydrationProfile;
}

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

async function hydrateOnce(root: string, databasePath: string, plane: BenchmarkPlane): Promise<HydrationSample> {
  const started = performance.now();
  const app = new ContextMeshApp(root, databasePath, {
    semantic: { modelPath: "fake", backendFactory: async () => new HydrationBackend() },
  });
  const appSqliteInitMs = performance.now() - started;
  let duration = 0;
  let profile: SemanticHydrationProfile | undefined;
  try {
    const result = app.semantic!.warmCache(plane);
    if (result.validEmbeddingCount !== ENTITY_COUNT || result.invalidRows !== 0) {
      throw new Error("Application-cold hydration did not load the expected SQLite rows");
    }
    duration = performance.now() - started;
    profile = result.profile;
  } finally {
    await app.close();
  }
  return { durationMs: duration, appSqliteInitMs, ...(profile ? { profile } : {}) };
}

async function rssChild(root: string, databasePath: string, plane: BenchmarkPlane): Promise<void> {
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
    const result = app.semantic!.warmCache(plane);
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

async function sampleChild(root: string, databasePath: string, plane: BenchmarkPlane): Promise<void> {
  process.stdout.write(JSON.stringify(await hydrateOnce(root, databasePath, plane)));
}

function hydrateInFreshProcess(
  scriptPath: string,
  root: string,
  databasePath: string,
  plane: BenchmarkPlane,
): HydrationSample {
  const output = execFileSync(
    process.execPath,
    ["--no-warnings", "--import", "tsx", scriptPath, "--sample-child", root, databasePath, plane],
    {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const parsed = JSON.parse(output) as HydrationSample;
  if (
    typeof parsed.durationMs !== "number" ||
    !Number.isFinite(parsed.durationMs) ||
    parsed.durationMs < 0 ||
    typeof parsed.appSqliteInitMs !== "number" ||
    !Number.isFinite(parsed.appSqliteInitMs) ||
    parsed.appSqliteInitMs < 0
  ) {
    throw new Error("Application-cold hydration sample child returned an invalid duration");
  }
  return parsed;
}

function benchmarkPlaneArgument(flag: "--rss-child" | "--sample-child"): BenchmarkPlane {
  const value = process.argv[process.argv.indexOf(flag) + 3];
  if (value !== "code" && value !== "memory") throw new Error(`${flag} requires a semantic plane`);
  return value;
}

if (process.argv.includes("--rss-child")) {
  const root = process.argv[process.argv.indexOf("--rss-child") + 1];
  const databasePath = process.argv[process.argv.indexOf("--rss-child") + 2];
  if (!root || !databasePath) throw new Error("RSS child requires root and database path");
  await rssChild(root, databasePath, benchmarkPlaneArgument("--rss-child"));
} else if (process.argv.includes("--sample-child")) {
  const root = process.argv[process.argv.indexOf("--sample-child") + 1];
  const databasePath = process.argv[process.argv.indexOf("--sample-child") + 2];
  if (!root || !databasePath) throw new Error("Hydration sample child requires root and database path");
  await sampleChild(root, databasePath, benchmarkPlaneArgument("--sample-child"));
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
      const insertMemoryEmbedding = database.prepare(
        `INSERT INTO semantic_embeddings(
           workspace_key, plane, entity_key, source_hash, model_id, generation, vector
         ) VALUES (?, 'memory', ?, ?, ?, NULL, ?)`,
      );
      const insertCode = database.prepare(
        `INSERT INTO code_nodes(
           id, workspace_id, kind, name, qualified_name, local_key,
           content_hash, generation, semantic_source_hash
         ) VALUES (?, ?, 'function', ?, ?, ?, ?, 1, ?)`,
      );
      const insertCodeEmbedding = database.prepare(
        `INSERT INTO semantic_embeddings(
           workspace_key, plane, entity_key, source_hash, model_id, generation, vector
         ) VALUES (?, 'code', ?, ?, ?, 1, ?)`,
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
          insertMemoryEmbedding.run(
            semanticWorkspace.workspace_key,
            Buffer.from(id, "utf8"),
            Buffer.from(sourceHash, "hex"),
            model.model_id,
            encoded,
          );
          const codeId = sha256(`hydration-code-${index}`);
          const codeName = `hydrationCode${index}`;
          const codeSourceHash = sha256(`name: ${codeName}\nqualifiedName: ${codeName}\nsignature: () => void\ndoc: hydration`);
          insertCode.run(
            codeId,
            workspace.id,
            codeName,
            codeName,
            `benchmark:${index}`,
            sha256(codeName),
            codeSourceHash,
          );
          insertCodeEmbedding.run(
            semanticWorkspace.workspace_key,
            Buffer.from(codeId, "hex"),
            Buffer.from(codeSourceHash, "hex"),
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
        database.prepare("UPDATE workspaces SET current_generation = 1").run();
        database.prepare(
          `UPDATE workspace_semantic_state SET graph_generation = 1, semantic_revision = 1, status = 'ready',
             eligible_entity_count = ?, valid_embedding_count = ?, last_error = NULL,
             failure_class = NULL, normalized_error_code = NULL, failure_fingerprint = NULL,
             diagnostics_json = '[]'
           WHERE plane = 'code'`,
        ).run(ENTITY_COUNT, ENTITY_COUNT);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }

    const scriptPath = fileURLToPath(import.meta.url);
    const summarizeDiagnostics = (first: HydrationSample, samples: HydrationSample[]) => {
      const profiles = samples
        .map((sample) => sample.profile)
        .filter((profile): profile is SemanticHydrationProfile => profile !== undefined);
      const coldP95 = (select: (sample: HydrationSample, profile: SemanticHydrationProfile) => number) =>
        p95(samples.flatMap((sample) => (sample.profile ? [select(sample, sample.profile)] : [])));
      return {
        first: {
          applicationColdTotalMs: first.durationMs,
          appSqliteInitMs: first.appSqliteInitMs,
          ...first.profile,
        },
        coldP95: profiles.length === 0
          ? null
          : {
              applicationColdTotalMs: p95(samples.map((sample) => sample.durationMs)),
              appSqliteInitMs: coldP95((sample) => sample.appSqliteInitMs),
              stateReadMs: coldP95((_sample, profile) => profile.stateReadMs),
              modelLookupMs: coldP95((_sample, profile) => profile.modelLookupMs),
              rowIterationMs: coldP95((_sample, profile) => profile.rowIterationMs),
              decodeValidationMs: coldP95((_sample, profile) => profile.decodeValidationMs),
              idHashPackingMs: coldP95((_sample, profile) => profile.idHashPackingMs),
              sqliteReleaseMs: coldP95((_sample, profile) => profile.sqliteReleaseMs),
              totalHydrationMs: coldP95((_sample, profile) => profile.totalHydrationMs),
            },
      };
    };
    const measureLatency = (plane: BenchmarkPlane) => {
      const firstHydrationMs = hydrateInFreshProcess(scriptPath, root, databasePath, plane);
      const samples: HydrationSample[] = [];
      for (let index = 0; index < SAMPLE_COUNT; index += 1) {
        samples.push(hydrateInFreshProcess(scriptPath, root, databasePath, plane));
      }
      const sampleDurations = samples.map((sample) => sample.durationMs);
      return {
        firstHydrationMs: firstHydrationMs.durationMs,
        samples: sampleDurations,
        coldHydrationP95Ms: p95(sampleDurations),
        ...(process.env.CONTEXTMESH_HYDRATION_PROFILE === "1"
          ? { diagnostics: summarizeDiagnostics(firstHydrationMs, samples) }
          : {}),
      };
    };
    const memoryLatency = measureLatency("memory");
    const codeLatency = measureLatency("code");
    if (process.env.CONTEXTMESH_HYDRATION_PROFILE === "1") {
      process.stderr.write(`${JSON.stringify({ memory: memoryLatency, code: codeLatency })}\n`);
    }
    const measureRss = (plane: BenchmarkPlane) =>
      JSON.parse(
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
            plane,
            "--entities",
            String(ENTITY_COUNT),
            "--samples",
            "1",
          ],
          { encoding: "utf8" },
        ),
      ) as { rssMiB: number; heapUsedMiB: number; externalMiB: number; arrayBuffersMiB: number };
    const memoryRss = measureRss("memory");
    const codeRss = measureRss("code");
    const planeResult = (
      latency: typeof memoryLatency,
      rss: typeof memoryRss,
    ) => ({
      firstHydrationMs: round(latency.firstHydrationMs),
      coldHydrationP95Ms: round(latency.coldHydrationP95Ms),
      cacheRssMiB: round(rss.rssMiB),
      cacheMemoryBreakdownMiB: {
        heapUsed: round(rss.heapUsedMiB),
        external: round(rss.externalMiB),
        arrayBuffers: round(rss.arrayBuffersMiB),
      },
    });
    const result = {
      entities: ENTITY_COUNT,
      dimensions: APPROVED_MODEL_MANIFEST.model.dimensions,
      cacheMode: "fresh process + new ContextMeshApp + new SemanticService + new SQLite connection per sample",
      samples: SAMPLE_COUNT,
      rssMeasurement: "fresh child process, plane-cache delta after app/SQLite initialization, stabilized after gc",
      planes: {
        memory: planeResult(memoryLatency, memoryRss),
        code: planeResult(codeLatency, codeRss),
      },
      limits: {
        firstHydrationMs: LIMIT_MS,
        coldHydrationP95Ms: LIMIT_MS,
        cacheRssMiB: LIMIT_RSS_MIB,
      },
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (
      [memoryLatency, codeLatency].some(
        (latency) => latency.firstHydrationMs > LIMIT_MS || latency.coldHydrationP95Ms > LIMIT_MS,
      ) ||
      [memoryRss, codeRss].some((rss) => rss.rssMiB > LIMIT_RSS_MIB)
    ) {
      throw new Error("SQLite application-cold hydration exceeded a Phase 4 release limit");
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
}
