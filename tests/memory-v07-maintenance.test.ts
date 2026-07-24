import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope } from "../src/contracts.js";
import type { MemoryMaintenanceRun } from "../src/storage/database.js";
import { createFixtureWorkspace, removeFixtureWorkspace } from "./helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeFixtureWorkspace(root);
});

describe("v0.7 deterministic maintenance and memory revision", () => {
  it("keeps dry runs stable, no-op revisions fixed, and graph jobs unique", async () => {
    const root = createFixtureWorkspace();
    roots.push(root);
    const app = new ContextMeshApp(root, undefined, {
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    try {
      await app.indexWorkspace({ mode: "full" });
      const audit = new DatabaseSync(app.database.dbPath, { readOnly: true });
      const queued = audit.prepare(
        "SELECT count(*) AS count FROM memory_maintenance_jobs WHERE job_key='revalidate_links:1'",
      ).get()?.count;
      audit.close();
      expect(queued).toBe(1);
      const before = app.database.getMemoryRevision();
      const signatures = new Set<string>();
      for (let index = 0; index < 20; index += 1) {
        const result = app.reviewMemories({
          action: "run_maintenance",
          kinds: ["recompute_utility"],
          maxItems: 100,
          dryRun: true,
          tokenBudget: 2000,
        }) as Envelope<{ run: MemoryMaintenanceRun }>;
        signatures.add(result.data.run.signature);
      }
      expect(signatures.size).toBe(1);
      expect(app.database.getMemoryRevision()).toBe(before);

      const remembered = await app.remember({
        content: "revision changes once",
        topic: "revision",
        type: "decision",
        sourceSymbolIds: [],
      });
      expect(remembered.snapshot?.memoryRevision).toBe(before + 1);
      const duplicate = await app.remember({
        content: "revision changes once",
        topic: "revision",
        type: "decision",
        sourceSymbolIds: [],
      });
      expect(duplicate.snapshot?.memoryRevision).toBe(before + 1);
    } finally {
      await app.close();
    }
  });

  it.each([501, 1001])(
    "continues link revalidation for %i items without rewriting no-op rows",
    async (linkCount) => {
    const root = createFixtureWorkspace();
    roots.push(root);
    let now = new Date("2026-01-01T00:00:00.000Z");
    const app = new ContextMeshApp(root, undefined, { clock: () => now });
    try {
      await app.indexWorkspace({ mode: "full" });
      const symbol = await app.searchCode({ query: "double", kinds: ["function"] }) as Envelope<{
        results: Array<{ id: string }>;
      }>;
      const symbolId = symbol.data.results[0]!.id;
      for (let index = 0; index < linkCount; index += 1) {
        await app.remember({
          content: `cursor coverage memory ${index}`,
          topic: `cursor-${index}`,
          type: "fact",
          sourceSymbolIds: [symbolId],
        });
      }
      let normalizationCursor: string | undefined;
      do {
        const normalized = app.reviewMemories({
          action: "run_maintenance",
          kinds: ["revalidate_links"],
          maxItems: 500,
          dryRun: false,
          ...(normalizationCursor ? { continuationCursor: normalizationCursor } : {}),
          tokenBudget: 4000,
        }) as Envelope<{ run: MemoryMaintenanceRun }>;
        normalizationCursor = normalized.data.run.continuationCursor ?? undefined;
      } while (normalizationCursor);
      const audit = new DatabaseSync(app.database.dbPath, { readOnly: true });
      const before = audit.prepare(
        "SELECT validated_at FROM memory_code_link_validations ORDER BY link_id LIMIT 1",
      ).get()?.validated_at;
      audit.close();
      const revision = app.database.getMemoryRevision();
      now = new Date("2026-01-02T00:00:00.000Z");

      const processed = new Set<string>();
      let continuationCursor: string | undefined;
      const pageSizes: number[] = [];
      do {
        const result = app.reviewMemories({
          action: "run_maintenance",
          kinds: ["revalidate_links"],
          maxItems: 500,
          dryRun: false,
          ...(continuationCursor ? { continuationCursor } : {}),
          tokenBudget: 4000,
        }) as Envelope<{ run: MemoryMaintenanceRun }>;
        pageSizes.push(result.data.run.processedIds.length);
        for (const id of result.data.run.processedIds) processed.add(id);
        continuationCursor = result.data.run.continuationCursor ?? undefined;
      } while (continuationCursor);

      expect(pageSizes).toEqual(linkCount === 501 ? [500, 1] : [500, 500, 1]);
      expect(processed.size).toBe(linkCount);
      expect(app.database.getMemoryRevision()).toBe(revision);
      const verified = new DatabaseSync(app.database.dbPath, { readOnly: true });
      const after = verified.prepare(
        "SELECT validated_at FROM memory_code_link_validations ORDER BY link_id LIMIT 1",
      ).get()?.validated_at;
      const checked = verified.prepare(
        "SELECT count(*) AS count FROM memory_code_link_validations WHERE checked_generation=1",
      ).get()?.count;
      verified.close();
      expect(after).toBe(before);
      expect(checked).toBe(linkCount);
    } finally {
      await app.close();
    }
    },
    30_000,
  );

  it("takes over an expired maintenance lease and preserves graph generation on failure", async () => {
    const root = createFixtureWorkspace();
    roots.push(root);
    const app = new ContextMeshApp(root, undefined, {
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    try {
      await app.indexWorkspace({ mode: "full" });
      const symbol = await app.searchCode({ query: "double", kinds: ["function"] }) as Envelope<{
        results: Array<{ id: string }>;
      }>;
      await app.remember({
        content: "maintenance lease takeover",
        topic: "lease",
        type: "fact",
        sourceSymbolIds: [symbol.data.results[0]!.id],
      });
      const writable = new DatabaseSync(app.database.dbPath);
      writable.prepare("UPDATE memory_code_link_validations SET checked_generation=0").run();
      writable.prepare(
        `UPDATE memory_maintenance_jobs SET state='running',cursor_json='{}',
         lease_owner='dead-worker',lease_token='dead-token',lease_expires_epoch=0,
         completed_at=NULL WHERE job_type='revalidate_links'`,
      ).run();
      const attemptsBefore = Number(writable.prepare(
        "SELECT attempt_count FROM memory_maintenance_jobs WHERE job_type='revalidate_links'",
      ).get()?.attempt_count ?? 0);
      writable.close();

      app.reviewMemories({
        action: "run_maintenance",
        kinds: ["revalidate_links"],
        maxItems: 500,
        dryRun: false,
        tokenBudget: 4000,
      });
      const takenOver = new DatabaseSync(app.database.dbPath);
      const job = takenOver.prepare(
        "SELECT state,attempt_count,lease_owner,cursor_json FROM memory_maintenance_jobs WHERE job_type='revalidate_links'",
      ).get();
      expect(job).toMatchObject({
        state: "succeeded",
        attempt_count: attemptsBefore + 1,
        lease_owner: null,
        cursor_json: "{}",
      });

      const generation = app.database.getWorkspace().currentGeneration;
      takenOver.prepare("UPDATE memory_code_link_validations SET checked_generation=0").run();
      takenOver.prepare(
        `UPDATE memory_maintenance_jobs SET state='pending',cursor_json='{}',
         completed_at=NULL,last_error=NULL WHERE job_type='revalidate_links'`,
      ).run();
      takenOver.exec(
        `CREATE TRIGGER fail_v07_validation_update
         BEFORE UPDATE ON memory_code_link_validations
         BEGIN SELECT RAISE(ABORT,'injected maintenance failure'); END;`,
      );
      takenOver.close();
      expect(() => app.reviewMemories({
        action: "run_maintenance",
        kinds: ["revalidate_links"],
        maxItems: 500,
        dryRun: false,
        tokenBudget: 4000,
      })).toThrow(/injected maintenance failure/);

      const failed = new DatabaseSync(app.database.dbPath);
      failed.exec("DROP TRIGGER fail_v07_validation_update");
      expect(failed.prepare(
        "SELECT state,last_error FROM memory_maintenance_jobs WHERE job_type='revalidate_links'",
      ).get()).toMatchObject({
        state: "failed",
        last_error: expect.stringMatching(/injected maintenance failure/),
      });
      failed.close();
      expect(app.database.getWorkspace().currentGeneration).toBe(generation);
    } finally {
      await app.close();
    }
  });

  it("creates duplicate/conflict candidates without merging and resolves only explicitly", async () => {
    const root = createFixtureWorkspace();
    roots.push(root);
    const app = new ContextMeshApp(root, undefined, {
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    try {
      const common = "Always run the ContextMesh index before changing public API contracts";
      await app.remember({
        content: common,
        topic: "release",
        type: "decision",
        sourceSymbolIds: [],
        claims: [{ namespace: "custom", key: "release.mode", operator: "eq", value: "safe" }],
      });
      await app.remember({
        content: `${common} locally`,
        topic: "release",
        type: "decision",
        sourceSymbolIds: [],
        claims: [{ namespace: "custom", key: "release.mode", operator: "eq", value: "fast" }],
      });
      const run = app.reviewMemories({
        action: "run_maintenance",
        kinds: ["detect_duplicates", "detect_conflicts"],
        maxItems: 100,
        dryRun: false,
        tokenBudget: 4000,
      }) as Envelope<{ run: MemoryMaintenanceRun }>;
      expect(run.data.run.candidateIds).toHaveLength(2);
      const review = app.reviewMemories({
        action: "list",
        candidateTypes: ["duplicate", "conflict"],
        limit: 20,
        offset: 0,
        tokenBudget: 4000,
      }) as Envelope<{ items: Array<{ candidates: Array<{ id: string; type: string }> }> }>;
      const candidates = review.data.items.flatMap((item) => item.candidates);
      expect(new Set(candidates.map((candidate) => candidate.type))).toEqual(new Set(["duplicate", "conflict"]));
      const revision = app.database.getMemoryRevision();
      const dismissed = candidates.find((candidate) => candidate.type === "duplicate")!;
      app.reviewMemories({
        action: "resolve",
        candidateId: dismissed.id,
        decision: "dismiss",
        reason: "both decisions remain useful",
        tokenBudget: 2000,
      });
      expect(app.database.getMemoryRevision()).toBe(revision + 1);
      expect((app.database.getStatus().counts as { memories: number }).memories).toBe(2);
    } finally {
      await app.close();
    }
  });
});
