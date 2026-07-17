import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope, MemoryFragmentRecord } from "../src/contracts.js";
import type { EmbeddingBackend, SemanticRuntimeDiagnostics } from "../src/semantic/backend.js";
import { APPROVED_MODEL_KEY, APPROVED_MODEL_MANIFEST } from "../src/semantic/manifest.js";
import type { CodeSearchResult } from "../src/storage/database.js";
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
  it("migrates a Phase 3 database through 004 after creating a recoverable backup", async () => {
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
    expect(doctor.data.schemaVersions).toEqual([1, 2, 3, 4]);
    expect(
      readdirSync(root).filter((name) => name.startsWith("phase3.sqlite3.backup-")),
    ).toHaveLength(1);
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    const pageSize = migrated.prepare("PRAGMA page_size").get() as { page_size: number };
    migrated.close();
    expect(pageSize.page_size).toBe(8192);
    await app.close();
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
