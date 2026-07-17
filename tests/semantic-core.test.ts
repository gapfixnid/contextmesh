import { describe, expect, it } from "vitest";

import { encodeEntityIds, scanNormalizedMatrix, writeSha256Hex } from "../src/semantic/exact-scan.js";
import {
  fuseAndDiversify,
  rankScore,
  rankingRedundancy,
  textRedundancy,
} from "../src/semantic/ranking.js";
import { PipelineCooldownError, PipelineLifecycle } from "../src/semantic/pipeline-lifecycle.js";
import { MAX_EXACT_SCAN_ENTITIES, SemanticService } from "../src/semantic/service.js";
import { decodeVector, encodeVector } from "../src/semantic/vector-codec.js";
import type { ContextMeshStorage, SemanticStateRecord } from "../src/storage/database.js";

describe("semantic vector codec", () => {
  it("round-trips normalized Float32 values in explicit little-endian order", () => {
    const value = Math.fround(1 / Math.sqrt(2));
    const vector = new Float32Array([value, value]);
    const bytes = encodeVector(vector, 2);
    expect([...bytes.slice(0, 4)]).toEqual([243, 4, 53, 63]);
    expect([...decodeVector(bytes, 2)]).toEqual([...vector]);
  });

  it("rejects corrupt and non-normalized vectors", () => {
    expect(() => decodeVector(new Uint8Array(3), 2)).toThrow(/byte length mismatch/);
    expect(() => encodeVector(new Float32Array([1, 1]), 2)).toThrow(/not L2-normalized/);
  });
});

describe("hybrid ranking", () => {
  it("normalizes RRF, pins exact matches, and uses canonical IDs for ties", () => {
    const ranked = fuseAndDiversify(
      [
        {
          weight: 1,
          items: [
            { id: "b", value: "b", text: "beta" },
            { id: "a", value: "a", text: "alpha" },
          ],
        },
        {
          weight: 1,
          items: [
            { id: "a", value: "a", text: "alpha" },
            { id: "b", value: "b", text: "beta" },
          ],
        },
      ],
      ["b"],
    );
    expect(ranked[0]).toMatchObject({ id: "b", relevance: 1, mmrScore: 1 });
    expect(ranked[1]?.relevance).toBeGreaterThan(0);
  });

  it("uses the versioned short-text fallback and keeps distinct empty entities non-duplicates", () => {
    expect(textRedundancy("", "", false)).toBe(0);
    expect(textRedundancy("Alpha beta", "alpha beta", false)).toBe(1);
    expect(textRedundancy("alpha beta", "alpha gamma", false)).toBeCloseTo(1 / 3);
  });

  it("uses cosine only for same-model vectors and lets pinned text remove a later vectorless duplicate", () => {
    const left = { id: "left", value: null, text: "alpha beta", vector: new Float32Array([1, 0]), vectorModelKey: "a" };
    const right = { id: "right", value: null, text: "alpha gamma", vector: new Float32Array([1, 0]), vectorModelKey: "b" };
    expect(rankingRedundancy(left, right)).toBeCloseTo(1 / 3);
    const ranked = fuseAndDiversify(
      [{ weight: 1, items: [{ id: "duplicate", value: "duplicate", text: "alpha beta" }] }],
      ["pinned"],
      [{ id: "pinned", value: "pinned", text: "alpha beta" }],
    );
    expect(ranked.map((candidate) => candidate.id)).toEqual(["pinned"]);
  });

  it("uses a 1e-5 internal ordering bucket while preserving 1e-6 public score precision", () => {
    expect(rankScore(0.500001)).toBe(rankScore(0.500004));
    expect(rankScore(0.500006)).toBeGreaterThan(rankScore(0.500004));
  });
});

describe("semantic exact scan", () => {
  it("applies the live source-hash mask before top-K and breaks score ties by canonical ID", () => {
    const ids = encodeEntityIds(["a", "b", "c"]);
    const hashes = ["01".repeat(32), "02".repeat(32), "03".repeat(32)];
    const sourceHashBytes = new Uint8Array(hashes.length * 32);
    hashes.forEach((hash, index) => writeSha256Hex(sourceHashBytes, index * 32, hash));
    const matrix = new Float32Array([
      1, 0,
      1, 0,
      0, 1,
    ]);
    const eligible = new Map([
      ["a", hashes[0]!],
      ["b", hashes[1]!],
      ["c", "ff".repeat(32)],
    ]);
    const result = scanNormalizedMatrix(matrix, ids, sourceHashBytes, eligible, new Float32Array([1, 0]), 2, 10);
    expect(result.validEmbeddingCount).toBe(2);
    expect(result.rows.map((row) => row.id)).toEqual(["a", "b"]);
    expect(result.rows.map((row) => row.score)).toEqual([1, 1]);
  });
});

describe("semantic scale gate", () => {
  it("skips an oversized exact scan without loading an embedding backend", async () => {
    const eligible = new Map<string, string>();
    for (let index = 0; index <= MAX_EXACT_SCAN_ENTITIES; index += 1) {
      eligible.set(`entity-${index}`, `hash-${index}`);
    }
    const state: SemanticStateRecord = {
      workspaceId: "workspace",
      plane: "code",
      modelKey: "configured",
      graphGeneration: 1,
      semanticRevision: 1,
      status: "ready",
      eligibleEntityCount: eligible.size,
      validEmbeddingCount: eligible.size,
      coverage: 1,
      lastError: null,
      failureClass: null,
      normalizedErrorCode: null,
      failureFingerprint: null,
      materialFingerprint: null,
      diagnostics: [],
      retryGeneration: 0,
      retryCount: 0,
      nextRetryEpoch: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    let backendFactoryCalls = 0;
    let unavailable = "";
    const storage = {
      configureSemanticModel: (registration: { modelKey: string }) => {
        state.modelKey = registration.modelKey;
      },
      backfillSemanticSourceHashes: () => undefined,
      getSemanticState: () => state,
      getWorkspace: () => ({ currentGeneration: 1 }),
      getEligibleSemanticEntityKeys: () => eligible,
      updateSemanticFailure: (_plane: string, failure: { code: string }) => {
        unavailable = failure.code;
      },
    } as unknown as ContextMeshStorage;
    const service = new SemanticService(storage, {
      modelPath: "unused",
      backendFactory: async () => {
        backendFactoryCalls += 1;
        throw new Error("backend must not load for scale limit");
      },
    });
    const result = await service.searchCode("oversized", undefined, 100);
    expect(result.candidates).toHaveLength(0);
    expect(result.warnings).toContainEqual(expect.stringContaining("SEMANTIC_UNAVAILABLE: SCALE_LIMIT"));
    expect(result.eligibleEntityCount).toBe(MAX_EXACT_SCAN_ENTITIES + 1);
    expect(backendFactoryCalls).toBe(0);
    expect(unavailable).toContain("SCALE_LIMIT");
    await service.dispose();
  });
});

describe("semantic pipeline lifecycle", () => {
  it("retires by generation and waits for all active references before disposal", async () => {
    let now = 0;
    let factoryCalls = 0;
    const disposed: number[] = [];
    const lifecycle = new PipelineLifecycle(
      async () => {
        const id = ++factoryCalls;
        return { id, dispose: async () => void disposed.push(id) };
      },
      5_000,
      () => now,
    );
    const first = await lifecycle.acquire();
    const concurrent = await lifecycle.acquire();
    expect(first.generation).toBe(concurrent.generation);
    first.retire();
    const firstRelease = first.release();
    expect(disposed).toEqual([]);
    await expect(lifecycle.acquire({ respectCooldown: true })).rejects.toBeInstanceOf(PipelineCooldownError);
    await concurrent.release();
    await firstRelease;
    expect(disposed).toEqual([1]);

    now = 5_001;
    const replacement = await lifecycle.acquire({ respectCooldown: true });
    expect(replacement.generation).toBeGreaterThan(first.generation);
    expect(factoryCalls).toBe(2);
    const closing = lifecycle.close();
    expect(disposed).toEqual([1]);
    await replacement.release();
    await closing;
    expect(disposed).toEqual([1, 2]);
    await expect(lifecycle.acquire()).rejects.toThrow(/closed/);
  });
});
