import { afterEach, describe, expect, it } from "vitest";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope, MemoryFragmentRecord } from "../src/contracts.js";
import type { CodeSearchResult } from "../src/storage/database.js";
import { createFixtureWorkspace, removeFixtureWorkspace, writeWorkspaceFile } from "./helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeFixtureWorkspace(root);
});

describe("v0.7 code-link validation and context safety", () => {
  it("marks changed code stale and excludes it from lexical and linked context", async () => {
    const root = createFixtureWorkspace();
    roots.push(root);
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const search = await app.searchCode({ query: "double", kinds: ["function"] }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      const symbolId = search.data.results[0]!.id;
      const remembered = await app.remember({
        content: "double is the canonical arithmetic helper",
        topic: "validation",
        type: "fact",
        sourceSymbolIds: [symbolId],
      }) as Envelope<{ fragment: MemoryFragmentRecord }>;
      writeWorkspaceFile(root, "src/math.ts", `export function double(value: number): number {
  return value + value + 0;
}
export interface NumericOperation { run(value: number): number; }
`);
      await app.indexWorkspace({ mode: "incremental" });
      const review = app.reviewMemories({
        action: "list",
        validationStates: ["stale"],
        limit: 20,
        offset: 0,
        tokenBudget: 4000,
      }) as Envelope<{ items: Array<{ fragment: MemoryFragmentRecord }> }>;
      expect(review.data.items.map((item) => item.fragment.id)).toContain(remembered.data.fragment.id);
      const recall = await app.recall({ query: "canonical arithmetic helper", tokenBudget: 2000 }) as Envelope<{
        fragments: MemoryFragmentRecord[];
      }>;
      expect(recall.data.fragments).toHaveLength(0);
      expect(recall.warnings).toContain("MEMORY_STALE_EXCLUDED:1");
      const context = await app.getContext({
        query: "double arithmetic",
        symbolId: (await app.searchCode({ query: "double", kinds: ["function"] }) as Envelope<{
          results: CodeSearchResult[];
        }>).data.results[0]!.id,
        include: ["code", "memory"],
        tokenBudget: 4000,
      }) as Envelope<{ memories: MemoryFragmentRecord[] }>;
      expect(context.data.memories.some((item) => item.id === remembered.data.fragment.id)).toBe(false);
    } finally {
      await app.close();
    }
  });
});
