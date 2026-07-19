import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope } from "../src/contracts.js";
import { ContextMeshError } from "../src/errors.js";
import type { CodeSearchResult } from "../src/storage/database.js";
import { createFixtureWorkspace, removeFixtureWorkspace, writeWorkspaceFile } from "./helpers.js";

const workspaces: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of workspaces.splice(0)) removeFixtureWorkspace(root);
});

describe("Phase 3 freshness coordination", () => {
  it("does not latch generation zero and strictly rebuilds a missing process baseline", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    let app = new ContextMeshApp(root);
    const unindexed = await app.workspaceStatus() as Envelope<{
      indexed: boolean;
      stale: boolean;
      freshness: { latch: boolean };
    }>;
    expect(unindexed.data).toMatchObject({ indexed: false, stale: false });
    expect(unindexed.data.freshness.latch).toBe(false);
    await expect(app.searchCode({ query: "double" })).rejects.toMatchObject({ code: "NOT_INDEXED" });

    await app.indexWorkspace({ mode: "full" });
    app.close();
    app = new ContextMeshApp(root);
    try {
      expect(app.database.getFreshnessState().lastStrictCheckAt).toBeNull();
      const search = await app.searchCode({ query: "double", kinds: ["function"] }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      expect(search.data.results[0]?.name).toBe("double");
      expect(search.warnings).not.toContainEqual(expect.stringContaining("INDEX_STALE"));
      expect(app.database.getFreshnessState().lastStrictCheckAt).not.toBeNull();
    } finally {
      app.close();
    }
  });

  it("uses a verified no-op success fence to invalidate an older failed run across restart", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    let app = new ContextMeshApp(root);
    await app.indexWorkspace({ mode: "full" });
    const failed = app.database.startIndexRun("incremental");
    app.database.failIndexRun(failed, ["simulated failure"]);
    app.close();

    app = new ContextMeshApp(root);
    try {
      const stale = await app.searchCode({ query: "double" });
      expect(stale.generation).toBe(1);
      expect(stale.warnings).toContainEqual(expect.stringContaining("INDEX_STALE"));

      const noOp = await app.indexWorkspace({ mode: "incremental" }) as Envelope<{ noOp: boolean }>;
      expect(noOp.generation).toBe(1);
      expect(noOp.data.noOp).toBe(true);
      const state = app.database.getFreshnessState();
      expect(state).toMatchObject({
        currentGeneration: 1,
        successFenceGeneration: 3,
        failureFenceGeneration: 2,
        stale: false,
      });
      const status = await app.workspaceStatus() as Envelope<{
        lastRun: { generation: number; status: string };
      }>;
      expect(status.data.lastRun).toMatchObject({ generation: 3, status: "succeeded" });
      app.close();
      app = new ContextMeshApp(root);
      const afterRestart = await app.searchCode({ query: "double" });
      expect(afterRestart.warnings).not.toContainEqual(expect.stringContaining("INDEX_STALE"));
    } finally {
      app.close();
    }
  });

  it("treats a committed partial graph as a success fence and clears the durable latch", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const failed = app.database.startIndexRun("incremental");
      app.database.failIndexRun(failed, ["simulated failure"]);
      writeWorkspaceFile(root, "src/math.ts", "export function broken( {\n");
      const partial = await app.indexWorkspace({ mode: "incremental" });
      expect(partial.generation).toBe(3);
      const state = app.database.getFreshnessState();
      expect(state.successFenceGeneration).toBe(3);
      expect(state.stale).toBe(false);
      const status = await app.workspaceStatus() as Envelope<{ lastRun: { status: string } }>;
      expect(status.data.lastRun.status).toBe("partial");
    } finally {
      app.close();
    }
  });

  it("serves the committed generation while a new index run owns the index mutex", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const indexing = app.indexWorkspace({ mode: "incremental" });
      for (let turn = 0; turn < 10; turn += 1) {
        await Promise.resolve();
        const state = app.database.getFreshnessState();
        if (state.failureFenceGeneration > state.successFenceGeneration) break;
      }
      const during = await app.searchCode({ query: "double", kinds: ["function"] });
      expect(during.generation).toBe(1);
      expect(during.warnings).toContainEqual(expect.stringContaining("INDEX_STALE"));
      await indexing;
      const after = await app.searchCode({ query: "double", kinds: ["function"] });
      expect(after.warnings).not.toContainEqual(expect.stringContaining("INDEX_STALE"));
    } finally {
      app.close();
    }
  });

  it("declines to install a baseline after two generation CAS changes", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      app.code.indexer.dispose();
      const actual = app.database.getFreshnessState();
      let calls = 0;
      const stateSpy = vi.spyOn(app.database, "getFreshnessState").mockImplementation(() => {
        calls += 1;
        if (calls === 1) return actual;
        if (calls === 2) return { ...actual, currentGeneration: actual.currentGeneration + 1 };
        return { ...actual, currentGeneration: actual.currentGeneration + 2 };
      });
      const churned = await app.code.indexer.checkFreshness("fast");
      expect(churned.stale).toBe(true);
      expect(calls).toBeGreaterThanOrEqual(3);
      stateSpy.mockRestore();
      const rebuilt = await app.code.indexer.checkFreshness("fast");
      expect(rebuilt).toMatchObject({ generation: 1, stale: false });
    } finally {
      app.close();
    }
  });

  it("retries a changed request generation once and records memory access only for the final attempt", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      await app.remember({
        content: "Generation retry access memory",
        topic: "generation-retry",
        type: "fact",
        keywords: ["generation", "retry"],
        sourceSymbolIds: [],
      });
      const realFinal = app.code.indexer.readFinalRequestState.bind(app.code.indexer);
      let finalCalls = 0;
      vi.spyOn(app.code.indexer, "readFinalRequestState").mockImplementation(async () => {
        const state = await realFinal();
        finalCalls += 1;
        return finalCalls === 1 ? { ...state, successFence: state.successFence + 1 } : state;
      });
      const access = vi.spyOn(app.database, "recordMemoryAccess");
      const context = await app.getContext({
        query: "Generation retry access memory",
        include: ["memory"],
        tokenBudget: 1000,
      });
      expect(finalCalls).toBeGreaterThanOrEqual(2);
      expect(access).toHaveBeenCalledTimes(1);
      expect(context.warnings).not.toContainEqual(expect.stringContaining("INDEX_STALE"));
    } finally {
      app.close();
    }
  });

  it("marks a stable second snapshot stale when generation changes twice", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const realFinal = app.code.indexer.readFinalRequestState.bind(app.code.indexer);
      vi.spyOn(app.code.indexer, "readFinalRequestState").mockImplementation(async () => {
        const state = await realFinal();
        return { ...state, successFence: state.successFence + 1 };
      });
      const search = await app.searchCode({ query: "double", kinds: ["function"] }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      expect(search.generation).toBe(1);
      expect(search.data.results.every((node) => node.generation === search.generation)).toBe(true);
      expect(search.warnings).toContainEqual(expect.stringContaining("INDEX_STALE"));
      expect(search.truncated).toBe(true);
    } finally {
      app.close();
    }
  });

  it("refuses snapshot mutex re-entry and does not hold freshness during snippet I/O", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      let nestedError: unknown;
      await app.database.withReadSnapshot(() => {
        void app.database.withReadSnapshot(() => 1).catch((error: unknown) => {
          nestedError = error;
        });
        return 1;
      });
      await Promise.resolve();
      expect(nestedError).toBeInstanceOf(ContextMeshError);
      expect((nestedError as ContextMeshError).code).toBe("INTERNAL_ERROR");

      let enterSnippet!: () => void;
      let releaseSnippet!: () => void;
      const entered = new Promise<void>((resolve) => {
        enterSnippet = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseSnippet = resolve;
      });
      const realSnippet = app.code.indexer.readSnippet.bind(app.code.indexer);
      vi.spyOn(app.code.indexer, "readSnippet").mockImplementation(async (node, contextLines) => {
        enterSnippet();
        await gate;
        return realSnippet(node, contextLines);
      });
      const context = app.getContext({ query: "double", include: ["code"], tokenBudget: 1000 });
      await entered;
      try {
        const winner = await Promise.race([
          app.searchCode({ query: "double" }).then(() => "search"),
          new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 500)),
        ]);
        expect(winner).toBe("search");
      } finally {
        releaseSnippet();
      }
      await context;
    } finally {
      app.close();
    }
  });

  it("hydrates snippets with bounded concurrency while preserving candidate order", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    for (let index = 0; index < 12; index += 1) {
      writeWorkspaceFile(root, `src/parallel-${index}.ts`, `export function parallel(): number { return ${index}; }\n`);
    }
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const assembled = app.context.assembleDatabase({
        query: "parallel",
        include: ["code"],
        tokenBudget: 8_000,
      });
      const traceCache = app.code.cacheStats();
      expect(traceCache.traceEntries).toBe(1);
      app.context.assembleDatabase({ query: "parallel", include: ["code"], tokenBudget: 8_000 });
      expect(app.code.cacheStats().traceEntries).toBe(traceCache.traceEntries);
      const expectedPaths = assembled.candidates
        .filter((candidate) => candidate.kind === "code")
        .map((candidate) => (candidate.value as CodeSearchResult).relativePath);
      expect(expectedPaths.length).toBeGreaterThan(8);

      let active = 0;
      let maxActive = 0;
      vi.spyOn(app.code.indexer, "readSnippet").mockImplementation(async (node) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          return { snippet: node.relativePath, warning: null, staleReason: null };
        } finally {
          active -= 1;
        }
      });
      const state = app.database.getFreshnessState();
      const hydrated = await app.context.hydrateSnippets(
        assembled,
        state.currentGeneration,
        state.successFenceGeneration,
      );
      const hydratedPaths = hydrated.assembled.candidates
        .filter((candidate) => candidate.kind === "code")
        .map((candidate) => candidate.value as { snippet: string | null })
        .map((candidate) => candidate.snippet);
      expect(maxActive).toBeGreaterThan(1);
      expect(maxActive).toBeLessThanOrEqual(8);
      expect(hydratedPaths).toEqual(expectedPaths);
    } finally {
      app.close();
    }
  });
});
