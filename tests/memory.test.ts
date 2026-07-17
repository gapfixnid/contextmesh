import { renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope, MemoryFragmentRecord } from "../src/contracts.js";
import type { CodeSearchResult } from "../src/storage/database.js";
import { createFixtureWorkspace, removeFixtureWorkspace, writeWorkspaceFile } from "./helpers.js";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) removeFixtureWorkspace(workspace);
});

describe("long-term memory lifecycle", () => {
  it("deduplicates, supersedes, links, reflects, forgets, and persists memories", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    let app = new ContextMeshApp(root);
    let durableId = "";
    try {
      await app.indexWorkspace({ mode: "full" });
      const code = await app.searchCode({ query: "Calculator", kinds: ["class"] }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      const calculatorId = code.data.results[0]?.id;
      expect(calculatorId).toBeTruthy();

      const remembered = await app.remember({
        content: "Use Calculator for numeric operations.",
        topic: "architecture",
        type: "decision",
        keywords: ["calculator", "numeric"],
        importance: 5,
        anchor: true,
        sourceSymbolIds: [calculatorId],
      }) as Envelope<{ fragment: MemoryFragmentRecord; duplicate: boolean }>;
      durableId = remembered.data.fragment.id;
      expect(remembered.data.duplicate).toBe(false);

      const duplicate = await app.remember({
        content: "Use Calculator for numeric operations.",
        topic: "architecture",
        type: "decision",
        keywords: ["calculator"],
        importance: 3,
        sourceSymbolIds: [],
      }) as Envelope<{ fragment: MemoryFragmentRecord; duplicate: boolean }>;
      expect(duplicate.data.duplicate).toBe(true);
      expect(duplicate.data.fragment.id).toBe(durableId);

      const context = await app.getContext({ query: "Calculator", tokenBudget: 2000 }) as Envelope<{
        code: CodeSearchResult[];
        memories: MemoryFragmentRecord[];
      }>;
      expect(context.data.code.some((node) => node.name === "Calculator")).toBe(true);
      expect(context.data.memories.some((memory) => memory.id === durableId)).toBe(true);
      expect(context.estimatedTokens).toBeLessThanOrEqual(2000);

      const replacement = await app.remember({
        content: "Use Calculator only for synchronous numeric operations.",
        topic: "architecture",
        type: "decision",
        keywords: ["calculator", "synchronous"],
        importance: 5,
        anchor: true,
        sourceSymbolIds: [calculatorId],
        supersedesId: durableId,
      }) as Envelope<{ fragment: MemoryFragmentRecord }>;
      const replacementId = replacement.data.fragment.id;
      const recalled = await app.recall({
        query: "Calculator",
        includeAnchors: true,
        tokenBudget: 2000,
      }) as Envelope<{
        fragments: MemoryFragmentRecord[];
      }>;
      expect(recalled.data.fragments.some((memory) => memory.id === durableId)).toBe(false);
      expect(recalled.data.fragments.some((memory) => memory.id === replacementId)).toBe(true);
      expect((recalled.data.fragments[0] as MemoryFragmentRecord & { untrusted: boolean }).untrusted).toBe(true);
      expect(
        (
          recalled.data.fragments[0] as MemoryFragmentRecord & {
            provenance: { codeLinks: Array<{ codeNodeId: string | null }> };
          }
        ).provenance.codeLinks[0]?.codeNodeId,
      ).toBe(calculatorId);

      const reflection = await app.reflect({
        sessionId: "session-test-1",
        summary: "Implemented and verified numeric code intelligence.",
        clientName: "vitest",
        learnings: [
          {
            content: "Run the indexer after changing public symbols.",
            topic: "workflow",
            type: "procedure",
            keywords: ["indexer"],
            importance: 4,
            sourceSymbolIds: [],
          },
        ],
      }) as Envelope<{ episode: MemoryFragmentRecord; learnings: MemoryFragmentRecord[] }>;
      expect(reflection.data.episode.type).toBe("episode");
      expect(reflection.data.learnings).toHaveLength(1);
      const reflectedContext = await app.getContext({
        query: "Run the indexer",
        include: ["memory"],
        tokenBudget: 2000,
      }) as Envelope<{ memories: MemoryFragmentRecord[] }>;
      expect(reflectedContext.data.memories.some((memory) => memory.id === reflection.data.episode.id)).toBe(true);

      const forgottenId = reflection.data.learnings[0]?.id;
      expect(forgottenId).toBeTruthy();
      app.forget({ fragmentId: forgottenId, reason: "Covered by automated startup indexing" });
      const forgottenRecall = await app.recall({ query: "Run the indexer", tokenBudget: 1000 }) as Envelope<{
        fragments: MemoryFragmentRecord[];
      }>;
      expect(forgottenRecall.data.fragments.some((memory) => memory.id === forgottenId)).toBe(false);

      durableId = replacementId;
    } finally {
      app.close();
    }

    app = new ContextMeshApp(root);
    try {
      const afterRestart = await app.recall({
        query: "synchronous numeric",
        includeAnchors: true,
        tokenBudget: 1000,
      }) as Envelope<{
        fragments: MemoryFragmentRecord[];
      }>;
      expect(afterRestart.data.fragments.some((memory) => memory.id === durableId)).toBe(true);
    } finally {
      app.close();
    }
  });

  it("relinks a memory to a uniquely matching symbol after its source file is renamed", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const before = await app.searchCode({ query: "Calculator", kinds: ["class"] }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      const oldSymbolId = before.data.results[0]?.id;
      expect(oldSymbolId).toBeTruthy();
      const remembered = await app.remember({
        content: "This note must remain attached after a source file rename.",
        topic: "provenance",
        type: "fact",
        keywords: ["rename-link"],
        importance: 4,
        sourceSymbolIds: [oldSymbolId],
      }) as Envelope<{ fragment: MemoryFragmentRecord }>;

      renameSync(path.join(root, "src/service.ts"), path.join(root, "src/calculator.ts"));
      writeWorkspaceFile(
        root,
        "src/index.ts",
        `import { Calculator } from "./calculator.js";\n\nexport const compute = (value: number): number => new Calculator().run(value);\n`,
      );
      await app.indexWorkspace({ mode: "incremental" });

      const after = await app.searchCode({ query: "Calculator", kinds: ["class"] }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      const newSymbolId = after.data.results[0]?.id;
      expect(newSymbolId).toBeTruthy();
      expect(newSymbolId).not.toBe(oldSymbolId);
      const context = await app.getContext({
        query: "no-lexical-memory-match",
        symbolId: newSymbolId,
        tokenBudget: 2000,
        include: ["memory"],
      }) as Envelope<{
        memories: Array<
          MemoryFragmentRecord & {
            source: string;
            provenance: { codeLinks: Array<{ codeNodeId: string | null; confidence: number }> };
          }
        >;
      }>;
      expect(context.data.memories).toContainEqual(
        expect.objectContaining({ id: remembered.data.fragment.id, source: "linked" }),
      );
      const relinked = context.data.memories.find((memory) => memory.id === remembered.data.fragment.id);
      expect(relinked?.provenance.codeLinks[0]?.codeNodeId).toBe(newSymbolId);
      expect(relinked?.provenance.codeLinks[0]?.confidence).toBe(0.95);
    } finally {
      app.close();
    }
  });

  it("paginates deterministic recall results", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const app = new ContextMeshApp(root);
    try {
      for (const suffix of ["alpha", "beta", "gamma"]) {
        await app.remember({
          content: `Pagination memory ${suffix}`,
          topic: "pagination",
          type: "fact",
          keywords: ["pageable"],
          importance: 3,
          sourceSymbolIds: [],
        });
      }
      const first = await app.recall({ query: "Pagination memory", tokenBudget: 1000, limit: 1, offset: 0 }) as Envelope<{
        fragments: MemoryFragmentRecord[];
        nextOffset: number | null;
      }>;
      const second = await app.recall({ query: "Pagination memory", tokenBudget: 1000, limit: 1, offset: 1 }) as Envelope<{
        fragments: MemoryFragmentRecord[];
        nextOffset: number | null;
      }>;
      expect(first.truncated).toBe(true);
      expect(first.data.nextOffset).toBe(1);
      expect(second.data.fragments[0]?.id).not.toBe(first.data.fragments[0]?.id);
    } finally {
      app.close();
    }
  });

  it("expires TTL memories lazily and records the lifecycle event", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    let app: ContextMeshApp | null = new ContextMeshApp(root);
    const databasePath = path.join(root, ".contextmesh", "contextmesh.sqlite3");
    try {
      const remembered = await app.remember({
        content: "This temporary memory should expire.",
        topic: "ttl",
        type: "fact",
        keywords: ["temporary"],
        importance: 2,
        ttlDays: 1,
        sourceSymbolIds: [],
      }) as Envelope<{ fragment: MemoryFragmentRecord }>;
      const fragmentId = remembered.data.fragment.id;
      await app.close();
      app = null;

      const raw = new DatabaseSync(databasePath);
      raw.prepare("UPDATE memory_fragments SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", fragmentId);
      raw.close();

      app = new ContextMeshApp(root);
      const recall = await app.recall({ query: "temporary memory", tokenBudget: 1000 }) as Envelope<{
        fragments: MemoryFragmentRecord[];
      }>;
      expect(recall.data.fragments.some((fragment) => fragment.id === fragmentId)).toBe(false);
      await app.close();
      app = null;

      const audit = new DatabaseSync(databasePath, { readOnly: true });
      const event = audit
        .prepare("SELECT count(*) AS count FROM memory_events WHERE fragment_id = ? AND event_type = 'expired'")
        .get(fragmentId) as { count: number };
      audit.close();
      expect(event.count).toBe(1);
    } finally {
      app?.close();
    }
  });
});
