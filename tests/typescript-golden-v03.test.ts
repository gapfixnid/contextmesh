import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope } from "../src/contracts.js";
import { sha256 } from "../src/utils.js";

describe("v0.2 TypeScript golden compatibility", () => {
  it("preserves localKey, ID derivation, typed calls, and unresolved output", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-ts-golden-"));
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
    writeFileSync(path.join(root, "src", "gold.ts"), [
      "export function target(): number { return 1; }",
      "export function caller(callback: () => void): number { callback(); return target(); }",
      "",
    ].join("\n"));
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const result = await app.searchCode({ query: "caller" }) as Envelope<{ results: Array<{ id: string; localKey: string; analysisLevel: string }> }>;
      const caller = result.data.results[0];
      expect(caller?.localKey).toBe("src/gold.ts:function:caller");
      expect(caller?.id).toBe(sha256(`${app.database.workspace.id}\0src/gold.ts:function:caller`));
      expect(caller?.analysisLevel).toBe("typed");
      const trace = await app.traceCode({ symbolId: caller!.id, direction: "out", depth: 1 }) as Envelope<{
        edges: Array<{ confidence: number; status: string; evidence: Array<{ source: string }> }>;
        unresolved: Array<{ rawName: string }>;
      }>;
      expect(trace.data.edges).toContainEqual(expect.objectContaining({ confidence: 1, status: "resolved", evidence: [expect.objectContaining({ source: "type_checker" })] }));
      expect(trace.data.unresolved).toContainEqual(expect.objectContaining({ rawName: "callback" }));
    } finally {
      await app.close(); rmSync(root, { recursive: true, force: true });
    }
  });
});
