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
