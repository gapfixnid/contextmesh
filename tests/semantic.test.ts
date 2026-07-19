import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope, MemoryFragmentRecord } from "../src/contracts.js";
import type { EmbeddingBackend, SemanticRuntimeDiagnostics } from "../src/semantic/backend.js";
import { encodeEntityIds } from "../src/semantic/exact-scan.js";
import {
  APPROVED_MODEL_KEY,
  APPROVED_MODEL_MANIFEST,
  SemanticModelValidationError,
} from "../src/semantic/manifest.js";
import { decodeVectorInto } from "../src/semantic/vector-codec.js";
import type { CodeSearchResult, SemanticStateRecord } from "../src/storage/database.js";
import { createFixtureWorkspace, removeFixtureWorkspace, writeWorkspaceFile } from "./helpers.js";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) removeFixtureWorkspace(workspace);
});

function normalizedVector(text: string): Float32Array {
  const concepts: Record<string, string> = {
    doubles: "multiply",
    double: "multiply",
    twice: "multiply",
    temporary: "transient",
    errors: "failure",
    error: "failure",
    retries: "retry",
    numeric: "number",
    value: "number",
  };
  const tokens =
    text
      .normalize("NFC")
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}]+/gu)
      ?.map((token) => concepts[token] ?? token) ?? [];
  const vector = new Float32Array(APPROVED_MODEL_MANIFEST.model.dimensions);
  for (const token of tokens) {
    const digest = createHash("sha256").update(token).digest();
    const index = digest.readUInt16LE(0) % vector.length;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  if (tokens.length === 0) vector[0] = 1;
  let squaredNorm = 0;
  for (const value of vector) squaredNorm += value * value;
  const norm = Math.sqrt(squaredNorm);
  for (let index = 0; index < vector.length; index += 1) vector[index] = (vector[index] ?? 0) / norm;
  return vector;
}

class FakeEmbeddingBackend implements EmbeddingBackend {
  readonly modelKey = APPROVED_MODEL_KEY;
  readonly dimensions = APPROVED_MODEL_MANIFEST.model.dimensions;
  readonly manifest = APPROVED_MODEL_MANIFEST;
  readonly diagnostics: SemanticRuntimeDiagnostics = {
    requestedSessionOptions: APPROVED_MODEL_MANIFEST.backend.requestedSessionOptions,
    resolvedBackend: "fake-deterministic",
    requestedExecutionProviders: APPROVED_MODEL_MANIFEST.backend.requestedExecutionProviders,
    effectiveExecutionProvider: "cpu",
    effectiveIntraOpThreads: 4,
    effectiveInterOpThreads: "not_applicable",
    verificationMethod: ["fake_backend"],
    observedModelPath: "fake/model_quantized.onnx",
    observedModelSha256: APPROVED_MODEL_MANIFEST.files[0]!.sha256,
  };
  passageCalls = 0;
  queryCalls = 0;
  disposed = false;
  passageStarted: (() => void) | null = null;
  passageGate: Promise<void> | null = null;

  async embedQuery(text: string): Promise<Float32Array> {
    this.queryCalls += 1;
    return normalizedVector(text);
  }

  async embedPassages(texts: string[]): Promise<Float32Array[]> {
    this.passageCalls += texts.length;
    this.passageStarted?.();
    if (this.passageGate) await this.passageGate;
    return texts.map(normalizedVector);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

describe("semantic indexing and retrieval", () => {
  it("migrates a Phase 3 database directly through 006 after creating a recoverable backup", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const databasePath = path.join(root, "phase3.sqlite3");
    const raw = new DatabaseSync(databasePath);
    raw.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    for (const name of [
      "001_initial.sql",
      "002_workspace_index_config.sql",
      "003_workspace_freshness.sql",
    ]) {
      raw.exec(readFileSync(path.join(process.cwd(), "migrations", name), "utf8"));
      raw.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(
        Number.parseInt(name.slice(0, 3), 10),
        name,
        "2026-01-01T00:00:00.000Z",
      );
    }
    raw.exec("PRAGMA journal_mode = WAL");
    raw.close();

    const app = new ContextMeshApp(root, databasePath);
    const doctor = app.doctor() as Envelope<{ schemaVersions: number[] }>;
    expect(doctor.data.schemaVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(
      readdirSync(root).filter((name) => name.startsWith("phase3.sqlite3.backup-")),
    ).toHaveLength(1);
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    const pageSize = migrated.prepare("PRAGMA page_size").get() as { page_size: number };
    const hydrationIndex = migrated
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_semantic_embeddings_hydration'")
      .get();
    migrated.close();
    expect(pageSize.page_size).toBe(8192);
    expect(hydrationIndex).toMatchObject({ name: "idx_semantic_embeddings_hydration" });
    await app.close();
  });

  it("migrates 004 through 006 without changing existing semantic BLOBs or state", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const databasePath = path.join(root, "phase4-004.sqlite3");
    const raw = new DatabaseSync(databasePath);
    raw.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    for (const name of [
      "001_initial.sql",
      "002_workspace_index_config.sql",
      "003_workspace_freshness.sql",
      "004_semantic_retrieval.sql",
    ]) {
      raw.exec(readFileSync(path.join(process.cwd(), "migrations", name), "utf8"));
      raw.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(
        Number.parseInt(name.slice(0, 3), 10),
        name,
        "2026-01-01T00:00:00.000Z",
      );
    }
    raw.prepare(
      `INSERT INTO workspaces(
         id, name, root_path, root_path_key, current_generation, created_at, updated_at,
         index_config_hash, freshness_stale, freshness_reasons_json
       ) VALUES ('workspace-004', 'fixture', ?, 'legacy-key', 1, ?, ?, NULL, 0, '[]')`,
    ).run(root, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    raw.prepare(
      `INSERT INTO semantic_models(model_id, model_key, manifest_digest, manifest_json, dimensions, vector_codec, created_at)
       VALUES (1, 'legacy-model', 'legacy-digest', '{}', 2, 'f32le-v1', ?)`,
    ).run("2026-01-01T00:00:00.000Z");
    raw.prepare("INSERT INTO semantic_workspaces(workspace_key, workspace_id) VALUES (42, 'workspace-004')").run();
    raw.prepare(
      `INSERT INTO workspace_semantic_state(
         workspace_id, plane, model_key, graph_generation, semantic_revision, status,
         eligible_entity_count, valid_embedding_count, last_error, updated_at
       ) VALUES ('workspace-004', 'code', 'legacy-model', 1, 7, 'partial', 2, 1, 'legacy-safe-error', ?)`,
    ).run("2026-01-01T00:00:00.000Z");
    const legacyVector = new Uint8Array([0, 0, 128, 63, 0, 0, 0, 0]);
    raw.prepare(
      `INSERT INTO semantic_embeddings(
         embedding_id, workspace_key, plane, entity_key, source_hash, model_id, generation, vector
       ) VALUES (9, 42, 'code', ?, ?, 1, 1, ?)`,
    ).run(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), legacyVector);
    raw.close();

    let app = new ContextMeshApp(root, databasePath);
    expect((app.doctor() as Envelope<{ schemaVersions: number[] }>).data.schemaVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await app.close();
    app = new ContextMeshApp(root, databasePath);
    await app.close();

    const verified = new DatabaseSync(databasePath, { readOnly: true });
    const stored = verified.prepare("SELECT vector FROM semantic_embeddings WHERE embedding_id = 9").get() as {
      vector: Uint8Array;
    };
    const state = verified.prepare(
      "SELECT semantic_revision, status, eligible_entity_count, valid_embedding_count, failure_class FROM workspace_semantic_state WHERE plane = 'code'",
    ).get() as Record<string, unknown>;
    verified.close();
    expect([...stored.vector]).toEqual([...legacyVector]);
    expect(state).toMatchObject({
      semantic_revision: 7,
      status: "partial",
      eligible_entity_count: 2,
      valid_embedding_count: 1,
      failure_class: null,
    });
  });

  it("indexes and reuses generation-stamped vectors without loading the backend on a ready no-op restart", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const firstBackend = new FakeEmbeddingBackend();
    let firstFactoryCalls = 0;
    let app = new ContextMeshApp(root, undefined, {
      semantic: {
        modelPath: "fake",
        backendFactory: async () => {
          firstFactoryCalls += 1;
          return firstBackend;
        },
      },
    });
    await app.indexWorkspace({ mode: "full" });
    expect(firstFactoryCalls).toBe(1);
    expect(app.database.getSemanticClaimDiagnostics("code")).toMatchObject({
      activeAttemptToken: null,
      claimCount: 1,
      takeoverCount: 0,
      supersedeCount: 0,
    });
    expect(app.database.getSemanticClaimDiagnostics("code").lastCompletedAttemptToken).toMatch(/^[0-9a-f]{64}$/);
    expect(app.database.getSemanticState("code")).toMatchObject({
      graphGeneration: 1,
      status: "ready",
    });
    const before = app.database.loadSemanticEmbeddings("code", APPROVED_MODEL_KEY);
    const doubleBefore = before.find((embedding) => {
      const node = app.database.getCodeNode(embedding.entityId);
      return node?.name === "double";
    });
    expect(doubleBefore?.generation).toBe(1);

    writeWorkspaceFile(root, "src/extra.ts", "export const extraSemanticNode = true;\n");
    await app.indexWorkspace({ mode: "incremental" });
    const after = app.database.loadSemanticEmbeddings("code", APPROVED_MODEL_KEY);
    const doubleAfter = after.find((embedding) => embedding.entityId === doubleBefore?.entityId);
    expect(doubleAfter?.generation).toBe(2);
    expect([...doubleAfter!.vector]).toEqual([...doubleBefore!.vector]);

    const extraNode = app.database.searchCode("extraSemanticNode", undefined, 1)[0];
    expect(extraNode).toBeDefined();
    writeWorkspaceFile(
      root,
      "src/math.ts",
      `/** Multiplies a numeric value by three. */
export function double(value: number): number {
  return value * 3;
}

export interface NumericOperation {
  run(value: number): number;
}
`,
    );
    rmSync(path.join(root, "src/extra.ts"));
    await app.indexWorkspace({ mode: "incremental" });
    const pruned = app.database.loadSemanticEmbeddings("code", APPROVED_MODEL_KEY);
    expect(pruned.some((embedding) => embedding.entityId === extraNode!.id)).toBe(false);
    const doubleChanged = pruned.find((embedding) => embedding.entityId === doubleBefore?.entityId);
    expect(doubleChanged?.generation).toBe(3);
    expect([...doubleChanged!.vector]).not.toEqual([...doubleBefore!.vector]);
    await app.close();

    const restartBackend = new FakeEmbeddingBackend();
    let restartFactoryCalls = 0;
    app = new ContextMeshApp(root, undefined, {
      semantic: {
        modelPath: "fake",
        backendFactory: async () => {
          restartFactoryCalls += 1;
          return restartBackend;
        },
      },
    });
    const noOp = await app.indexWorkspace({ mode: "incremental" }) as Envelope<{ noOp: boolean }>;
    expect(noOp.data.noOp).toBe(true);
    expect(restartFactoryCalls).toBe(0);

    const search = await app.searchCode({ query: "multiply a number twice", limit: 10 }) as Envelope<{
      results: CodeSearchResult[];
    }>;
    expect(search.data.results[0]?.name).toBe("double");
    expect(search.data.results[0]?.score).toBeGreaterThanOrEqual(0);
    expect(search.data.results[0]?.score).toBeLessThanOrEqual(1);
    expect(restartFactoryCalls).toBe(1);
    await app.close();
    expect(restartBackend.disposed).toBe(true);
  });

  it("hydrates raw code and memory rows into canonical bytes with corrupt-row handling", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const app = new ContextMeshApp(root, undefined, {
      semantic: { modelPath: "fake", backendFactory: async () => new FakeEmbeddingBackend() },
    });
    await app.indexWorkspace({ mode: "full" });
    await app.remember({
      content: "The hydration comparison memory remains active.",
      topic: "hydration equality",
      type: "fact",
      keywords: ["hydration", "equality"],
      ttlDays: 10,
      sourceSymbolIds: [],
    });

    type HydrationCache = {
      matrix: Float32Array;
      sourceHashBytes: Uint8Array;
      entityIds: { bytes: Uint8Array; offsets: Uint32Array; count: number };
      invalidRows: number;
    };
    const semantic = app.semantic as unknown as {
      hydrateCache(plane: "code" | "memory", state: SemanticStateRecord): HydrationCache;
    };
    const comparePlane = (plane: "code" | "memory") => {
      const state = app.database.getSemanticState(plane)!;
      const direct = semantic.hydrateCache(plane, state);
      const stored = app.database.loadSemanticEmbeddings(plane, APPROVED_MODEL_KEY);
      const expectedMatrix = new Float32Array(stored.length * APPROVED_MODEL_MANIFEST.model.dimensions);
      const expectedHashes = new Uint8Array(stored.length * 32);
      const expectedIds: string[] = [];
      let expectedInvalidRows = 0;
      for (const row of stored) {
        try {
          const hash = Buffer.from(row.sourceHash, "hex");
          if (hash.byteLength !== 32) throw new Error("invalid source hash");
          decodeVectorInto(
            row.vector,
            APPROVED_MODEL_MANIFEST.model.dimensions,
            expectedMatrix,
            expectedIds.length * APPROVED_MODEL_MANIFEST.model.dimensions,
          );
          expectedHashes.set(hash, expectedIds.length * 32);
          expectedIds.push(row.entityId);
        } catch {
          expectedInvalidRows += 1;
        }
      }
      const encodedIds = encodeEntityIds(expectedIds);
      expect(direct.invalidRows).toBe(expectedInvalidRows);
      expect(direct.entityIds.count).toBe(expectedIds.length);
      expect(direct.matrix).toEqual(
        expectedMatrix.subarray(0, expectedIds.length * APPROVED_MODEL_MANIFEST.model.dimensions),
      );
      expect(direct.sourceHashBytes).toEqual(expectedHashes.subarray(0, expectedIds.length * 32));
      expect(direct.entityIds.bytes).toEqual(encodedIds.bytes);
      expect(direct.entityIds.offsets).toEqual(encodedIds.offsets);
    };
    comparePlane("code");

    const corrupt = new Uint8Array(APPROVED_MODEL_MANIFEST.model.dimensions * Float32Array.BYTES_PER_ELEMENT);
    new DataView(corrupt.buffer).setFloat32(0, Number.NaN, true);
    const raw = new DatabaseSync(app.database.dbPath);
    raw.prepare("UPDATE semantic_embeddings SET vector = ? WHERE plane = 'memory'").run(corrupt);
    raw.close();
    comparePlane("memory");
    await app.close();
  });

  it("commits the graph without embeddings when another owner holds the code index lease", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const backend = new FakeEmbeddingBackend();
    let factoryCalls = 0;
    const app = new ContextMeshApp(root, undefined, {
      semantic: {
        modelPath: "fake",
        backendFactory: async () => {
          factoryCalls += 1;
          return backend;
        },
      },
    });
    const foreign = app.database.claimCodeIndexEmbedding(
      {
        expectedCurrentGeneration: 0,
        targetGeneration: 1,
        modelKey: APPROVED_MODEL_KEY,
        eligibleEntityCount: 1,
        documentSetDigest: "foreign-document-set",
        materialFingerprint: "foreign-material",
      },
      { ownerUuid: "foreign-index-owner", ownerPid: process.pid, ownerHostname: "lease-test" },
    );
    expect(foreign.reason).toBe("acquired");

    await app.indexWorkspace({ mode: "full" });
    expect(factoryCalls).toBe(0);
    expect(app.database.searchCode("Calculator", undefined, 5).length).toBeGreaterThan(0);
    expect(app.database.loadSemanticEmbeddings("code", APPROVED_MODEL_KEY)).toHaveLength(0);
    expect(app.database.getSemanticState("code")).toMatchObject({
      graphGeneration: 1,
      status: "needs_backfill",
      validEmbeddingCount: 0,
    });
    expect(app.database.getSemanticClaimDiagnostics("code")).toMatchObject({
      activeAttemptToken: null,
      claimCount: 1,
      supersedeCount: 1,
    });
    await app.close();
  });

  it("discards index vectors and still commits the graph when the code index lease is lost", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const backend = new FakeEmbeddingBackend();
    let releaseEmbedding!: () => void;
    backend.passageGate = new Promise<void>((resolve) => {
      releaseEmbedding = resolve;
    });
    let signalEmbedding!: () => void;
    const embeddingStarted = new Promise<void>((resolve) => {
      signalEmbedding = resolve;
    });
    backend.passageStarted = signalEmbedding;
    const app = new ContextMeshApp(root, undefined, {
      semantic: { modelPath: "fake", backendFactory: async () => backend },
    });

    const indexing = app.indexWorkspace({ mode: "full" });
    await embeddingStarted;
    const raw = new DatabaseSync(app.database.dbPath);
    raw.prepare(
      `UPDATE semantic_reconciliation_claims
       SET owner_uuid = 'replacement-owner', owner_pid = 42, owner_hostname = 'replacement-host'
       WHERE plane = 'code' AND active_attempt_token IS NOT NULL`,
    ).run();
    raw.close();
    releaseEmbedding();
    await indexing;

    expect(backend.passageCalls).toBeGreaterThan(0);
    expect(app.database.getWorkspace().currentGeneration).toBe(1);
    expect(app.database.searchCode("Calculator", undefined, 5).length).toBeGreaterThan(0);
    expect(app.database.loadSemanticEmbeddings("code", APPROVED_MODEL_KEY)).toHaveLength(0);
    expect(app.database.getSemanticState("code")).toMatchObject({
      graphGeneration: 1,
      status: "needs_backfill",
      validEmbeddingCount: 0,
    });
    expect(app.database.getSemanticClaimDiagnostics("code").activeAttemptToken).toBeNull();
    await app.close();
  });

  it("isolates backend failure while preserving graph and memory writes", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const app = new ContextMeshApp(root, undefined, {
      semantic: {
        modelPath: "missing",
        backendFactory: async () => {
          throw new Error("approved model unavailable");
        },
      },
    });
    const indexed = await app.indexWorkspace({ mode: "full" });
    expect(indexed.generation).toBe(1);
    expect(indexed.warnings).toContainEqual(expect.stringContaining("SEMANTIC_UNAVAILABLE"));
    const search = await app.searchCode({ query: "Calculator", limit: 5 }) as Envelope<{
      results: CodeSearchResult[];
    }>;
    expect(search.data.results.some((node) => node.name === "Calculator")).toBe(true);
    expect(search.warnings).toContainEqual(expect.stringContaining("SEMANTIC_UNAVAILABLE"));

    const remembered = await app.remember({
      content: "The durable write must survive a semantic outage.",
      topic: "failure isolation",
      type: "decision",
      keywords: ["durable"],
      sourceSymbolIds: [],
    }) as Envelope<{ fragment: MemoryFragmentRecord }>;
    expect(remembered.data.fragment.state).toBe("active");
    expect(remembered.warnings).toContainEqual(expect.stringContaining("SEMANTIC_UNAVAILABLE"));
    expect(app.database.getSemanticState("memory")?.status).toBe("unavailable");
    const codeState = app.database.getSemanticState("code")!;
    const memoryState = app.database.getSemanticState("memory")!;
    expect(codeState.eligibleEntityCount).toBeGreaterThan(0);
    expect(memoryState.eligibleEntityCount).toBeGreaterThan(0);
    const eligibleScan = vi.spyOn(app.database, "getEligibleSemanticEntityKeys");
    const context = await app.getContext({
      query: "durable write",
      include: ["code", "memory"],
      tokenBudget: 2_000,
    });
    expect(context.warnings).toContainEqual(expect.stringContaining("SEMANTIC_UNAVAILABLE"));
    expect(eligibleScan).not.toHaveBeenCalled();
    expect(app.database.getSemanticState("code")?.eligibleEntityCount).toBe(codeState.eligibleEntityCount);
    expect(app.database.getSemanticState("memory")?.eligibleEntityCount).toBe(memoryState.eligibleEntityCount);
    await app.close();
  });

  it("latches an unchanged material failure without repeated factory, revision, or claim work", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    let factoryCalls = 0;
    let metadataProbes = 0;
    let monotonicNow = 0;
    const app = new ContextMeshApp(root, undefined, {
      semantic: {
        modelPath: "unchanged-missing-model",
        monotonicNow: () => monotonicNow,
        materialFingerprint: async () => {
          metadataProbes += 1;
          return "unchanged-material-fingerprint";
        },
        backendFactory: async () => {
          factoryCalls += 1;
          throw new SemanticModelValidationError(
            "MODEL_FILE_HASH_MISMATCH",
            "local path must remain private",
          );
        },
      },
    });
    await app.indexWorkspace({ mode: "full" });
    // The first request completes and records the DB attempt token. Subsequent
    // requests are the configured-unavailable steady state measured by CI.
    await app.searchCode({ query: "Calculator", limit: 5 });
    const before = {
      factoryCalls,
      revision: app.database.getSemanticState("code")!.semanticRevision,
      embeddings: app.database.loadSemanticEmbeddings("code", APPROVED_MODEL_KEY).length,
      claims: app.database.getSemanticClaimDiagnostics("code").claimCount,
      metadataProbes,
    };
    for (let index = 0; index < 20; index += 1) {
      const result = await app.searchCode({ query: "Calculator", limit: 5 });
      expect(result.warnings).toContainEqual(expect.stringContaining("SEMANTIC_UNAVAILABLE"));
    }
    expect({
      factoryCalls,
      revision: app.database.getSemanticState("code")!.semanticRevision,
      embeddings: app.database.loadSemanticEmbeddings("code", APPROVED_MODEL_KEY).length,
      claims: app.database.getSemanticClaimDiagnostics("code").claimCount,
      metadataProbes,
    }).toEqual(before);
    monotonicNow = 10_000;
    await app.searchCode({ query: "Calculator", limit: 5 });
    expect(metadataProbes).toBe(before.metadataProbes + 1);
    const probesBeforeStatus = metadataProbes;
    const status = await app.workspaceStatus() as Envelope<{
      semantic: { code: { lastError: string } };
    }>;
    expect(metadataProbes).toBe(probesBeforeStatus + 2);
    expect(status.data.semantic.code.lastError).not.toContain(root);
    expect(status.warnings.join("\n")).not.toContain(root);
    await app.close();
  });

  it("discards a remembered-memory embedding when forget wins the CAS race", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const backend = new FakeEmbeddingBackend();
    let releasePassage!: () => void;
    backend.passageGate = new Promise<void>((resolve) => {
      releasePassage = resolve;
    });
    let passageStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      passageStarted = resolve;
    });
    backend.passageStarted = passageStarted;
    const app = new ContextMeshApp(root, undefined, {
      semantic: { modelPath: "fake", backendFactory: async () => backend },
    });
    const remembering = app.remember({
      content: "Forget this while its embedding is being calculated.",
      topic: "cas race",
      type: "fact",
      keywords: ["race"],
      sourceSymbolIds: [],
    });
    await started;
    const pending = app.database.recallSnapshot({
      query: "embedding calculated",
      tokenBudget: 1000,
      includeAnchors: false,
      limit: 10,
      offset: 0,
    }).fragments[0];
    expect(pending).toBeDefined();
    app.forget({ fragmentId: pending!.id, reason: "CAS test" });
    const revisionAfterForget = app.database.getSemanticState("memory")!.semanticRevision;
    releasePassage();
    const remembered = await remembering as Envelope<{ fragment: MemoryFragmentRecord }>;
    expect(remembered.data.fragment.id).toBe(pending!.id);
    expect(app.database.loadSemanticEmbeddings("memory", APPROVED_MODEL_KEY)).toHaveLength(0);
    expect(app.database.getSemanticState("memory")!.semanticRevision).toBe(revisionAfterForget);
    await app.close();
  });

  it("rejects a bulk memory commit when DB time expires an entity during inference", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    let app = new ContextMeshApp(root, undefined, {
      semantic: { modelPath: "fake", backendFactory: async () => new FakeEmbeddingBackend() },
    });
    const existing = await app.remember({
      content: "Expire this already-vectorized memory while bulk reconciliation is calculating.",
      topic: "bulk expiry fence",
      type: "fact",
      keywords: ["expiry", "bulk"],
      ttlDays: 10,
      sourceSymbolIds: [],
    }) as Envelope<{ fragment: MemoryFragmentRecord }>;
    expect(app.database.loadSemanticEmbeddings("memory", APPROVED_MODEL_KEY)).toHaveLength(1);
    const databasePath = app.database.dbPath;
    await app.close();

    app = new ContextMeshApp(root, databasePath);
    await app.remember({
      content: "This second memory requires the fenced bulk reconciliation pass.",
      topic: "bulk expiry fence pending",
      type: "fact",
      keywords: ["expiry", "bulk", "pending"],
      ttlDays: 10,
      sourceSymbolIds: [],
    });
    await app.close();

    const backend = new FakeEmbeddingBackend();
    let releasePassage!: () => void;
    backend.passageGate = new Promise<void>((resolve) => {
      releasePassage = resolve;
    });
    const started = new Promise<void>((resolve) => {
      backend.passageStarted = resolve;
    });
    app = new ContextMeshApp(root, databasePath, {
      semantic: { modelPath: "fake", backendFactory: async () => backend },
    });
    const recalling = app.recall({ query: "bulk expiry fence", tokenBudget: 1000 });
    await started;
    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE memory_fragments SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
      .run(existing.data.fragment.id);
    raw.close();
    releasePassage();
    const result = await recalling as Envelope<{ fragments: MemoryFragmentRecord[] }>;
    expect(result.data.fragments.some((memory) => memory.id === existing.data.fragment.id)).toBe(false);
    expect(
      app.database
        .loadSemanticEmbeddings("memory", APPROVED_MODEL_KEY)
        .some((embedding) => embedding.entityId === existing.data.fragment.id),
    ).toBe(false);
    expect(app.database.getSemanticClaimDiagnostics("memory").activeAttemptToken).toBeNull();
    await app.close();
  });

  it("filters an expired memory from a hydrated cache without changing semantic revision", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    let now = new Date("2026-01-01T00:00:00.000Z");
    const backend = new FakeEmbeddingBackend();
    const app = new ContextMeshApp(root, undefined, {
      clock: () => now,
      semantic: { modelPath: "fake", backendFactory: async () => backend },
    });
    const remembered = await app.remember({
      content: "This cache entry expires after one day.",
      topic: "expiry mask",
      type: "fact",
      keywords: ["expiry"],
      ttlDays: 1,
      sourceSymbolIds: [],
    }) as Envelope<{ fragment: MemoryFragmentRecord }>;
    const before = await app.getContext({
      query: "cache entry one day",
      include: ["memory"],
      tokenBudget: 1000,
    }) as Envelope<{ memories: MemoryFragmentRecord[] }>;
    expect(before.data.memories.some((memory) => memory.id === remembered.data.fragment.id)).toBe(true);
    const revision = app.database.getSemanticState("memory")!.semanticRevision;

    now = new Date("2026-01-02T00:00:01.000Z");
    const after = await app.getContext({
      query: "cache entry one day",
      include: ["memory"],
      tokenBudget: 1000,
    }) as Envelope<{ memories: MemoryFragmentRecord[] }>;
    expect(after.data.memories.some((memory) => memory.id === remembered.data.fragment.id)).toBe(false);
    expect(app.database.getSemanticState("memory")!.semanticRevision).toBe(revision);
    await app.close();
  });

  it("rolls semantic rows back with the graph transaction", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const app = new ContextMeshApp(root, undefined, {
      semantic: { modelPath: "fake", backendFactory: async () => new FakeEmbeddingBackend() },
    });
    await app.indexWorkspace({ mode: "full" });
    const before = app.database.loadSemanticEmbeddings("code", APPROVED_MODEL_KEY);
    const raw = new DatabaseSync(app.database.dbPath);
    raw.exec(`
      CREATE TRIGGER fail_semantic_graph_commit
      BEFORE UPDATE OF current_generation ON workspaces
      BEGIN
        SELECT RAISE(ABORT, 'forced semantic rollback');
      END;
    `);
    raw.close();
    writeWorkspaceFile(root, "src/rollback.ts", "export const rollbackProbe = true;\n");
    await expect(app.indexWorkspace({ mode: "incremental" })).rejects.toThrow(/forced semantic rollback/);
    expect(app.database.getWorkspace().currentGeneration).toBe(1);
    expect(app.database.getSemanticClaimDiagnostics("code")).toMatchObject({
      activeAttemptToken: null,
    });
    const after = app.database.loadSemanticEmbeddings("code", APPROVED_MODEL_KEY);
    expect(after.map((row) => [row.entityId, row.generation, [...row.vector]])).toEqual(
      before.map((row) => [row.entityId, row.generation, [...row.vector]]),
    );
    const cleanup = new DatabaseSync(app.database.dbPath);
    cleanup.exec("DROP TRIGGER fail_semantic_graph_commit");
    cleanup.close();
    await app.close();
  });

  it("keeps the workspace writer mutex through embedding and graph commit", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const firstBackend = new FakeEmbeddingBackend();
    const first = new ContextMeshApp(root, undefined, {
      semantic: { modelPath: "fake", backendFactory: async () => firstBackend },
    });
    await first.indexWorkspace({ mode: "full" });
    const secondBackend = new FakeEmbeddingBackend();
    const second = new ContextMeshApp(root, undefined, {
      semantic: { modelPath: "fake", backendFactory: async () => secondBackend },
    });

    let releaseEmbedding!: () => void;
    firstBackend.passageGate = new Promise<void>((resolve) => {
      releaseEmbedding = resolve;
    });
    let signalEmbedding!: () => void;
    const embeddingStarted = new Promise<void>((resolve) => {
      signalEmbedding = resolve;
    });
    firstBackend.passageStarted = signalEmbedding;
    writeWorkspaceFile(root, "src/writer.ts", "export const writerProbe = true;\n");
    const firstWrite = first.indexWorkspace({ mode: "incremental" });
    await embeddingStarted;
    const activeIndexAttempt = first.database.getSemanticClaimDiagnostics("code").activeAttemptToken;
    expect(activeIndexAttempt).toMatch(/^[0-9a-f]{64}$/);

    let secondEntered = false;
    const originalStart = second.database.startIndexRun.bind(second.database);
    second.database.startIndexRun = (mode) => {
      secondEntered = true;
      return originalStart(mode);
    };
    const secondWrite = second.indexWorkspace({ mode: "incremental" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondEntered).toBe(false);
    releaseEmbedding();
    await firstWrite;
    expect(first.database.getSemanticClaimDiagnostics("code")).toMatchObject({
      activeAttemptToken: null,
      lastCompletedAttemptToken: activeIndexAttempt,
      supersedeCount: 0,
    });
    await secondWrite;
    expect(secondEntered).toBe(true);
    expect(secondBackend.passageCalls).toBe(0);
    await second.close();
    await first.close();
  });

  it("detects a corrupt BLOB, reports partial coverage, and repairs it on reconciliation", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    let app = new ContextMeshApp(root, undefined, {
      semantic: { modelPath: "fake", backendFactory: async () => new FakeEmbeddingBackend() },
    });
    await app.indexWorkspace({ mode: "full" });
    const corruptId = app.database.loadSemanticEmbeddings("code", APPROVED_MODEL_KEY)[0]?.entityId;
    expect(corruptId).toBeDefined();
    const databasePath = app.database.dbPath;
    await app.close();

    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE semantic_embeddings SET vector = ? WHERE plane = 'code' AND entity_key = unhex(?)")
      .run(new Uint8Array([0, 1, 2]), corruptId!);
    raw.close();

    const repairBackend = new FakeEmbeddingBackend();
    app = new ContextMeshApp(root, undefined, {
      semantic: { modelPath: "fake", backendFactory: async () => repairBackend },
    });
    const degraded = await app.searchCode({ query: "Calculator", limit: 5 });
    expect(degraded.warnings).toContainEqual(expect.stringContaining("SEMANTIC_PARTIAL"));
    expect(app.database.getSemanticState("code")?.status).not.toBe("ready");
    await app.searchCode({ query: "Calculator", limit: 5 });
    const repaired = app.database.getSemanticState("code");
    expect(repaired).toMatchObject({ status: "ready" });
    expect(repaired?.validEmbeddingCount).toBe(repaired?.eligibleEntityCount);
    expect(repairBackend.passageCalls).toBeGreaterThan(0);
    await app.close();
  });

  it("serves valid vectors as partial when a runtime retry is cooling down", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const backend = new FakeEmbeddingBackend();
    const app = new ContextMeshApp(root, undefined, {
      semantic: {
        modelPath: "fake",
        backendFactory: async () => backend,
        materialFingerprint: async () => "runtime-material",
        monotonicNow: () => 0,
      },
    });
    await app.indexWorkspace({ mode: "full" });
    const raw = new DatabaseSync(app.database.dbPath);
    raw.prepare(
      `UPDATE workspace_semantic_state SET
         status = 'unavailable', failure_class = 'runtime_retryable',
         normalized_error_code = 'PIPELINE_RETRY_PENDING', failure_fingerprint = 'runtime-test',
         material_fingerprint = 'runtime-material',
         diagnostics_json = '[{"failureClass":"runtime_retryable","code":"PIPELINE_RETRY_PENDING","detailCode":"PIPELINE_RETRY_PENDING"}]',
         retry_count = 1, next_retry_epoch = unixepoch('now') + 3600
       WHERE plane = 'code'`,
    ).run();
    raw.close();

    const result = await app.searchCode({ query: "Calculator", limit: 5 }) as Envelope<{
      results: CodeSearchResult[];
    }>;
    expect(result.data.results.length).toBeGreaterThan(0);
    expect(result.warnings).toContainEqual(expect.stringContaining("SEMANTIC_PARTIAL"));
    const recovered = app.semantic!.status() as {
      code: { status: string; validEmbeddingCount: number };
    };
    expect(recovered.code.status).toBe("ready");
    expect(recovered.code.validEmbeddingCount).toBeGreaterThan(0);
    const status = await app.workspaceStatus() as Envelope<{
      semantic: { code: { status: string; validEmbeddingCount: number } };
    }>;
    expect(status.data.semantic.code.status).toBe("ready");
    expect(status.data.semantic.code.validEmbeddingCount).toBeGreaterThan(0);
    await app.close();
  });

  it("marks a source-hash mismatch partial and repairs the canonical hash before reuse", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const backend = new FakeEmbeddingBackend();
    const app = new ContextMeshApp(root, undefined, {
      semantic: { modelPath: "fake", backendFactory: async () => backend },
    });
    await app.indexWorkspace({ mode: "full" });
    const embedding = app.database.loadSemanticEmbeddings("code", APPROVED_MODEL_KEY)[0];
    expect(embedding).toBeDefined();
    const passageCalls = backend.passageCalls;

    const raw = new DatabaseSync(app.database.dbPath);
    raw.prepare("UPDATE code_nodes SET semantic_source_hash = ? WHERE id = ?")
      .run("ff".repeat(32), embedding!.entityId);
    raw.close();

    const degraded = await app.searchCode({ query: "Calculator", limit: 5 });
    expect(degraded.warnings).toContainEqual(expect.stringContaining("SEMANTIC_PARTIAL"));
    expect(app.database.getSemanticState("code")?.status).toBe("partial");

    await app.searchCode({ query: "Calculator", limit: 5 });
    expect(app.database.getSemanticState("code")?.status).toBe("ready");
    expect(backend.passageCalls).toBe(passageCalls);
    await app.close();
  });

  it("invalidates a second reader's warm memory cache after a committed revision", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const writer = new ContextMeshApp(root, undefined, {
      semantic: { modelPath: "fake", backendFactory: async () => new FakeEmbeddingBackend() },
    });
    const first = await writer.remember({
      content: "Double a value for the first cached memory.",
      topic: "reader cache one",
      type: "fact",
      keywords: ["double"],
      sourceSymbolIds: [],
    }) as Envelope<{ fragment: MemoryFragmentRecord }>;
    const readerBackend = new FakeEmbeddingBackend();
    const reader = new ContextMeshApp(root, undefined, {
      semantic: { modelPath: "fake", backendFactory: async () => readerBackend },
    });
    const before = await reader.recall({ query: "multiply", tokenBudget: 2000, limit: 10 }) as Envelope<{
      fragments: MemoryFragmentRecord[];
    }>;
    expect(before.data.fragments.map((memory) => memory.id)).toContain(first.data.fragment.id);
    const readerRevision = reader.database.getSemanticState("memory")!.semanticRevision;

    const second = await writer.remember({
      content: "Twice the input is the newly committed cached memory.",
      topic: "reader cache two",
      type: "fact",
      keywords: ["twice"],
      sourceSymbolIds: [],
    }) as Envelope<{ fragment: MemoryFragmentRecord }>;
    expect(writer.database.getSemanticState("memory")!.semanticRevision).toBeGreaterThan(readerRevision);
    const after = await reader.recall({ query: "multiply", tokenBudget: 2000, limit: 10 }) as Envelope<{
      fragments: MemoryFragmentRecord[];
    }>;
    expect(after.data.fragments.map((memory) => memory.id)).toContain(second.data.fragment.id);
    await reader.close();
    await writer.close();
  });

  it("invalidates persisted vectors when the configured model key changes", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    let app = new ContextMeshApp(root, undefined, {
      semantic: { modelPath: "fake", backendFactory: async () => new FakeEmbeddingBackend() },
    });
    await app.indexWorkspace({ mode: "full" });
    const originalRevision = app.database.getSemanticState("code")!.semanticRevision;
    app.database.configureSemanticModel({
      modelKey: "replacement-model-key",
      manifestDigest: "replacement-model-key",
      manifestJson: "{}",
      dimensions: APPROVED_MODEL_MANIFEST.model.dimensions,
      vectorCodec: "f32le-v1",
    });
    expect(app.database.getSemanticState("code")).toMatchObject({
      modelKey: "replacement-model-key",
      status: "needs_backfill",
    });
    expect(app.database.getSemanticState("code")!.semanticRevision).toBeGreaterThan(originalRevision);
    expect(app.database.loadSemanticEmbeddings("code", APPROVED_MODEL_KEY)).toHaveLength(0);
    await app.close();

    const backend = new FakeEmbeddingBackend();
    app = new ContextMeshApp(root, undefined, {
      semantic: { modelPath: "fake", backendFactory: async () => backend },
    });
    await app.searchCode({ query: "numeric operation", limit: 5 });
    expect(app.database.getSemanticState("code")).toMatchObject({
      modelKey: APPROVED_MODEL_KEY,
      status: "ready",
    });
    expect(backend.passageCalls).toBeGreaterThan(0);
    await app.close();
  });
});
