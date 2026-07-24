import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope, MemoryFragmentRecord } from "../src/contracts.js";
import type { CodeSearchResult } from "../src/storage/database.js";
import { createFixtureWorkspace, removeFixtureWorkspace, writeWorkspaceFile } from "./helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeFixtureWorkspace(root);
});

describe("v0.7 code-link validation and context safety", () => {
  it("closes recalled memory evidence back to its validated code symbol", async () => {
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
        content: "quartz narwhal is the approved operational phrase",
        topic: "evidence closure",
        type: "fact",
        sourceSymbolIds: [symbolId],
      }) as Envelope<{ fragment: MemoryFragmentRecord }>;

      const context = await app.getContext({
        query: "quartz narwhal approved operational phrase",
        include: ["code", "memory"],
        tokenBudget: 4000,
      }) as Envelope<{
        code: Array<{ id: string }>;
        memories: MemoryFragmentRecord[];
      }>;

      expect(context.data.memories.map((item) => item.id)).toContain(remembered.data.fragment.id);
      expect(context.data.code.map((item) => item.id)).toContain(symbolId);
    } finally {
      await app.close();
    }
  });

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

  it("relinks only the candidate link, recomputes aggregate safety, and restores recall", async () => {
    const root = createFixtureWorkspace();
    roots.push(root);
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const symbols = await app.searchCode({ query: "double NumericOperation" }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      const doubleId = symbols.data.results.find((item) => item.name === "double")!.id;
      const interfaceId = symbols.data.results.find((item) => item.name === "NumericOperation")!.id;
      const remembered = await app.remember({
        content: "multi link relink remains recallable",
        topic: "exact relink",
        type: "fact",
        sourceSymbolIds: [doubleId, interfaceId],
      }) as Envelope<{ fragment: MemoryFragmentRecord }>;
      writeWorkspaceFile(root, "src/math.ts", `export function double(value: number): number {
  return value + value + 0;
}
export function triple(value: number): number {
  return value * 3;
}
export interface NumericOperation {
  run(value: number): number;
}
`);
      await app.indexWorkspace({ mode: "incremental" });
      const target = await app.searchCode({ query: "triple", kinds: ["function"] }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      const review = app.reviewMemories({
        action: "list",
        candidateTypes: ["code_validation"],
        limit: 20,
        offset: 0,
        tokenBudget: 4000,
      }) as Envelope<{
        items: Array<{
          fragment: MemoryFragmentRecord;
          candidates: Array<{ id: string; evidence: { linkId: number } }>;
        }>;
      }>;
      const item = review.data.items.find((entry) => entry.fragment.id === remembered.data.fragment.id)!;
      expect(item.candidates).toHaveLength(1);
      const candidate = item.candidates[0]!;
      const before = new DatabaseSync(app.database.dbPath, { readOnly: true });
      const linksBefore = before.prepare(
        "SELECT id,node_local_key FROM memory_code_links WHERE memory_id=? ORDER BY id",
      ).all(remembered.data.fragment.id);
      before.close();
      const unrelated = await app.remember({
        content: "unrelated candidate ownership probe",
        topic: "candidate ownership",
        type: "fact",
        sourceSymbolIds: [],
      }) as Envelope<{ fragment: MemoryFragmentRecord }>;
      expect(() => app.reviewMemories({
        action: "resolve",
        candidateId: candidate.id,
        decision: "relink",
        reason: "wrong memory",
        fragmentId: unrelated.data.fragment.id,
        targetSymbolId: target.data.results[0]!.id,
        tokenBudget: 2000,
      })).toThrow(/does not belong to the review candidate/);

      app.reviewMemories({
        action: "resolve",
        candidateId: candidate.id,
        decision: "relink",
        reason: "the helper moved to triple",
        fragmentId: remembered.data.fragment.id,
        targetSymbolId: target.data.results[0]!.id,
        tokenBudget: 2000,
      });

      const after = new DatabaseSync(app.database.dbPath, { readOnly: true });
      const linksAfter = after.prepare(
        `SELECT l.id,l.node_local_key,v.state,v.reason_code
         FROM memory_code_links l JOIN memory_code_link_validations v ON v.link_id=l.id
         WHERE l.memory_id=? ORDER BY l.id`,
      ).all(remembered.data.fragment.id);
      const metadata = after.prepare(
        "SELECT maintenance_state FROM memory_fragment_metadata WHERE memory_id=?",
      ).get(remembered.data.fragment.id);
      after.close();
      expect(linksAfter.find((link) => link.id === candidate.evidence.linkId)?.node_local_key)
        .toContain("triple");
      expect(linksAfter.find((link) => link.id === candidate.evidence.linkId)?.state).toBe("relocated");
      expect(linksAfter.find((link) => link.id === candidate.evidence.linkId)?.reason_code).toBe("EXPLICIT_RELINK");
      expect(linksAfter.find((link) => link.id !== candidate.evidence.linkId)?.node_local_key)
        .toBe(linksBefore.find((link) => link.id !== candidate.evidence.linkId)?.node_local_key);
      expect(metadata?.maintenance_state).toBe("clean");
      const recalled = await app.recall({ query: "multi link relink recallable", tokenBudget: 2000 }) as Envelope<{
        fragments: MemoryFragmentRecord[];
      }>;
      expect(recalled.data.fragments.map((fragment) => fragment.id)).toContain(remembered.data.fragment.id);
    } finally {
      await app.close();
    }
  });

  it("rejects relink targets that contradict a structured code claim", async () => {
    const root = createFixtureWorkspace();
    roots.push(root);
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const original = await app.searchCode({ query: "double", kinds: ["function"] }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      const double = original.data.results[0]!;
      const remembered = await app.remember({
        content: "double signature is an enforced claim",
        topic: "claim relink",
        type: "fact",
        sourceSymbolIds: [double.id],
        claims: [{
          namespace: "code",
          key: "symbol.signature",
          operator: "eq",
          value: double.signature,
          sourceSymbolId: double.id,
        }],
      }) as Envelope<{ fragment: MemoryFragmentRecord }>;
      writeWorkspaceFile(root, "src/math.ts", `export function double(value: number): number {
  return value + value + 0;
}
export function triple(value: number, scale = 3): number {
  return value * scale;
}
export interface NumericOperation {
  run(value: number): number;
}
`);
      await app.indexWorkspace({ mode: "incremental" });
      const target = await app.searchCode({ query: "triple", kinds: ["function"] }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      const review = app.reviewMemories({
        action: "list",
        candidateTypes: ["code_validation"],
        limit: 20,
        offset: 0,
        tokenBudget: 4000,
      }) as Envelope<{
        items: Array<{ fragment: MemoryFragmentRecord; candidates: Array<{ id: string }> }>;
      }>;
      const candidate = review.data.items.find(
        (entry) => entry.fragment.id === remembered.data.fragment.id,
      )!.candidates[0]!;
      expect(() => app.reviewMemories({
        action: "resolve",
        candidateId: candidate.id,
        decision: "relink",
        reason: "invalid target",
        fragmentId: remembered.data.fragment.id,
        targetSymbolId: target.data.results[0]!.id,
        tokenBudget: 2000,
      })).toThrow(/contradicts a structured memory claim/);
      const audit = new DatabaseSync(app.database.dbPath, { readOnly: true });
      const pending = audit.prepare(
        "SELECT status FROM memory_review_candidates WHERE id=?",
      ).get(candidate.id);
      const state = audit.prepare(
        "SELECT maintenance_state FROM memory_fragment_metadata WHERE memory_id=?",
      ).get(remembered.data.fragment.id);
      audit.close();
      expect(pending?.status).toBe("pending");
      expect(state?.maintenance_state).toBe("review_required");
    } finally {
      await app.close();
    }
  });
});
