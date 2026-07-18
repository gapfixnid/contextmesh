import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope } from "../src/contracts.js";

const roots: string[] = [];

function mixedWorkspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-mixed-"));
  roots.push(root);
  mkdirSync(path.join(root, "src", "acme"), { recursive: true });
  writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
  writeFileSync(path.join(root, "src", "main.ts"), "export function typescriptEntry(): number { return 1; }\n");
  writeFileSync(path.join(root, "pyproject.toml"), "[tool.setuptools.packages.find]\nwhere = [\"src\"]\n");
  writeFileSync(path.join(root, "src", "acme", "__init__.py"), "from .service import Worker\n");
  writeFileSync(path.join(root, "src", "acme", "base.py"), "class Base:\n    pass\n");
  writeFileSync(path.join(root, "src", "acme", "service.py"), [
    "from .base import Base",
    "import requests",
    "",
    "def helper():",
    "    return 1",
    "",
    "class Worker(Base):",
    "    async def run(self):",
    "        helper()",
    "        self.dynamic()",
    "",
  ].join("\n"));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("v0.3 multilingual graph", () => {
  it("commits TS and Python together with evidence and no confirmed cross-language edge", async () => {
    const root = mixedWorkspace();
    const app = new ContextMeshApp(root);
    try {
      const indexed = await app.indexWorkspace({ mode: "full" }) as Envelope<{ adapterStats: Array<{ language: string }> }>;
      expect(indexed.generation).toBe(1);
      expect(indexed.data.adapterStats.map((item) => item.language)).toEqual(["typescript/javascript", "python"]);
      const status = await app.workspaceStatus() as Envelope<{ adapters: Array<{ language: string }> }>;
      expect(status.data.adapters.map((item) => item.language)).toEqual(["python", "typescript/javascript"]);

      const ts = await app.searchCode({ query: "typescriptEntry" }) as Envelope<{ results: Array<{ language: string }> }>;
      const py = await app.searchCode({ query: "Worker" }) as Envelope<{ results: Array<{ id: string; language: string; analysisLevel: string }> }>;
      expect(ts.data.results[0]?.language).toBe("typescript");
      expect(py.data.results[0]).toMatchObject({ language: "python", analysisLevel: "syntax" });

      const worker = py.data.results[0];
      expect(worker).toBeDefined();
      const trace = await app.traceCode({ symbolId: worker!.id, direction: "both", depth: 3 }) as Envelope<{
        nodes: Array<{ language: string }>;
        edges: Array<{ confidence: number; status: string; evidence: unknown[] }>;
        unresolved: Array<{ rawName: string; confidence: number; evidence: unknown[] }>;
      }>;
      expect(trace.data.edges.some((edge) => edge.confidence === 0.9 && edge.evidence.length > 0)).toBe(true);
      expect(trace.data.unresolved.some((item) => item.rawName.includes("self.dynamic") && item.confidence < 0.6)).toBe(true);
      expect(trace.data.edges.filter((edge) => edge.status === "resolved").every((edge) => edge.confidence >= 0.9)).toBe(true);
      expect(trace.data.edges.some((edge) => {
        const relation = edge as typeof edge & { sourceId: string; targetId: string };
        const source = trace.data.nodes.find((node) => (node as typeof node & { id: string }).id === relation.sourceId);
        const target = trace.data.nodes.find((node) => (node as typeof node & { id: string }).id === relation.targetId);
        return source && target && source.language !== target.language;
      })).toBe(false);
      const run = await app.searchCode({ query: "run", kinds: ["method"] }) as Envelope<{ results: Array<{ id: string }> }>;
      const context = await app.getContext({ query: "run", symbolId: run.data.results[0]!.id, tokenBudget: 2000, include: ["code"] });
      expect(context.warnings).toContainEqual(expect.stringContaining("SOURCE_VERIFICATION_REQUIRED"));
    } finally {
      await app.close();
    }
  });

  it("does not invoke the TS Program or TypeChecker providers for a Python-only incremental change", async () => {
    const root = mixedWorkspace();
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      writeFileSync(path.join(root, "src", "acme", "service.py"), "def changed_python_only():\n    return 2\n");
      const indexed = await app.indexWorkspace({ mode: "incremental" }) as Envelope<{
        adapterStats: Array<{ language: string; syntaxInvocations: number; precisionInvocations: number }>;
      }>;
      const typescript = indexed.data.adapterStats.find((item) => item.language === "typescript/javascript");
      expect(typescript).toMatchObject({ syntaxInvocations: 0, precisionInvocations: 0 });
      const ts = await app.searchCode({ query: "typescriptEntry" }) as Envelope<{ results: unknown[] }>;
      const py = await app.searchCode({ query: "changed_python_only" }) as Envelope<{ results: unknown[] }>;
      expect(ts.data.results).toHaveLength(1);
      expect(py.data.results).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
