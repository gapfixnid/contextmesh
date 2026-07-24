import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope, MemoryFragmentRecord } from "../src/contracts.js";
import { createFixtureWorkspace, removeFixtureWorkspace } from "./helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeFixtureWorkspace(root);
});

describe("v0.7 temporal memory policy", () => {
  it("normalizes validity, excludes future/ended records, and keeps TTL lifecycle read-only", async () => {
    const root = createFixtureWorkspace();
    roots.push(root);
    let now = new Date("2026-01-01T00:00:00.000Z");
    const app = new ContextMeshApp(root, undefined, { clock: () => now });
    try {
      const current = await app.remember({
        content: "current temporal fact",
        topic: "temporal",
        type: "fact",
        sourceSymbolIds: [],
        validFrom: "2026-01-01T09:00:00+09:00",
      }) as Envelope<{ fragment: MemoryFragmentRecord }>;
      expect(current.data.fragment.validFrom).toBe("2026-01-01T00:00:00.000Z");
      expect(current.data.fragment.validFrom).toBe(current.data.fragment.createdAt);

      await app.remember({
        content: "future temporal fact",
        topic: "temporal",
        type: "fact",
        sourceSymbolIds: [],
        validFrom: "2026-02-01T00:00:00Z",
      });
      await app.remember({
        content: "ended temporal fact",
        topic: "temporal",
        type: "fact",
        sourceSymbolIds: [],
        validFrom: "2025-01-01T00:00:00Z",
        validTo: "2025-12-01T00:00:00Z",
      });
      const ttl = await app.remember({
        content: "ttl temporal fact",
        topic: "temporal",
        type: "fact",
        sourceSymbolIds: [],
        ttlDays: 1,
      }) as Envelope<{ fragment: MemoryFragmentRecord }>;
      now = new Date("2026-01-03T00:00:00.000Z");
      const recalled = await app.recall({ query: "temporal fact", tokenBudget: 2000 }) as Envelope<{
        fragments: MemoryFragmentRecord[];
      }>;
      expect(recalled.data.fragments.map((item) => item.content)).toEqual(["current temporal fact"]);
      const audit = new DatabaseSync(app.database.dbPath, { readOnly: true });
      expect(audit.prepare("SELECT state FROM memory_fragments WHERE id=?").get(ttl.data.fragment.id)?.state).toBe("active");
      audit.close();
    } finally {
      await app.close();
    }
  });

  it("rejects inverted validity intervals", async () => {
    const root = createFixtureWorkspace();
    roots.push(root);
    const app = new ContextMeshApp(root);
    try {
      await expect(app.remember({
        content: "invalid interval",
        topic: "temporal",
        type: "fact",
        sourceSymbolIds: [],
        validFrom: "2026-02-01T00:00:00Z",
        validTo: "2026-01-01T00:00:00Z",
      })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    } finally {
      await app.close();
    }
  });
});
