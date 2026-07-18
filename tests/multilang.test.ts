import { appendFileSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
  it("never invokes TS providers in a pure Python workspace and handles TS add/remove transitions", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-python-only-"));
    roots.push(root); mkdirSync(path.join(root, "src"));
    const pythonPath = path.join(root, "src", "only.py");
    const typescriptPath = path.join(root, "src", "later.ts");
    writeFileSync(pythonPath, "def only_python():\n    return 1\n");
    const app = new ContextMeshApp(root);
    try {
      const full = await app.indexWorkspace({ mode: "full" }) as Envelope<{ adapterStats: Array<{ language: string }> }>;
      expect(app.code.indexer.typeScriptInstrumentation()).toEqual({ programCreations: 0, syntaxWorkItems: 0, precisionWorkItems: 0 });
      expect(full.data.adapterStats.some((item) => item.language === "typescript/javascript")).toBe(false);

      writeFileSync(pythonPath, "def only_python_changed():\n    return 2\n");
      await app.indexWorkspace({ mode: "incremental" });
      expect(app.code.indexer.typeScriptInstrumentation()).toEqual({ programCreations: 0, syntaxWorkItems: 0, precisionWorkItems: 0 });

      writeFileSync(typescriptPath, "export function added_later(): number { return 3; }\n");
      await app.indexWorkspace({ mode: "incremental" });
      const addedInstrumentation = app.code.indexer.typeScriptInstrumentation();
      expect(addedInstrumentation.programCreations).toBe(1);
      expect(addedInstrumentation.syntaxWorkItems).toBeGreaterThan(0);
      expect(addedInstrumentation.precisionWorkItems).toBeGreaterThan(0);
      const added = await app.searchCode({ query: "added_later", kinds: ["function"] }) as Envelope<{ results: unknown[] }>;
      expect(added.data.results).toHaveLength(1);

      unlinkSync(typescriptPath);
      await app.indexWorkspace({ mode: "incremental" });
      expect(app.code.indexer.typeScriptInstrumentation()).toEqual({ programCreations: 0, syntaxWorkItems: 0, precisionWorkItems: 0 });
      const removed = await app.searchCode({ query: "added_later", kinds: ["function"] }) as Envelope<{ results: unknown[] }>;
      expect(removed.data.results).toHaveLength(0);
      expect(app.database.getStoredGraphPartition("non-python").nodes).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

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
      expect(app.code.indexer.typeScriptInstrumentation()).toEqual({ programCreations: 0, syntaxWorkItems: 0, precisionWorkItems: 0 });
      const syntaxAfterIncremental = await app.code.indexer.evaluationGraph("syntax");
      expect(new Set(syntaxAfterIncremental.nodes.filter((node) => node.language === "typescript").map((node) => node.analysisLevel))).toEqual(new Set(["syntax"]));
      expect(app.code.indexer.typeScriptInstrumentation()).toEqual({ programCreations: 0, syntaxWorkItems: 0, precisionWorkItems: 0 });
      const ts = await app.searchCode({ query: "typescriptEntry" }) as Envelope<{ results: unknown[] }>;
      const py = await app.searchCode({ query: "changed_python_only" }) as Envelope<{ results: unknown[] }>;
      expect(ts.data.results).toHaveLength(1);
      expect(py.data.results).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("invalidates only Python for a pyproject-only change and preserves durable stats across restart/no-op", async () => {
    const root = mixedWorkspace();
    let app = new ContextMeshApp(root);
    await app.indexWorkspace({ mode: "full" });
    appendFileSync(path.join(root, "pyproject.toml"), "\n# layout revision\n");
    const changed = await app.indexWorkspace({ mode: "incremental" }) as Envelope<{
      adapterStats: Array<{ language: string; syntaxInvocations: number; precisionInvocations: number }>;
    }>;
    expect(changed.data.adapterStats.find((item) => item.language === "typescript/javascript"))
      .toMatchObject({ syntaxInvocations: 0, precisionInvocations: 0 });
    expect(app.code.indexer.typeScriptInstrumentation()).toEqual({ programCreations: 0, syntaxWorkItems: 0, precisionWorkItems: 0 });
    expect(changed.data.adapterStats.find((item) => item.language === "python"))
      .toMatchObject({ syntaxInvocations: 1, precisionInvocations: 0 });
    await app.close();

    app = new ContextMeshApp(root);
    try {
      const restarted = await app.workspaceStatus() as Envelope<{ adapterStats: Array<{ language: string }> }>;
      expect(restarted.data.adapterStats.map((item) => item.language)).toEqual(["typescript/javascript", "python"]);
      const noOp = await app.indexWorkspace({ mode: "incremental" }) as Envelope<{ noOp: boolean; adapterStats: Array<{ language: string }> }>;
      expect(noOp.data.noOp).toBe(true);
      expect(noOp.data.adapterStats.map((item) => item.language)).toEqual(["typescript/javascript", "python"]);
      const afterNoOp = await app.workspaceStatus() as Envelope<{
        adapterStats: Array<{ providerVersions?: Record<string, string>; status?: string; coverage?: number }>;
      }>;
      expect(afterNoOp.data.adapterStats.every((item) => item.status === "ready" && item.coverage === 1)).toBe(true);
      expect(afterNoOp.data.adapterStats.every((item) => Object.keys(item.providerVersions ?? {}).length > 0)).toBe(true);
      const rebuiltSyntax = await app.code.indexer.evaluationGraph("syntax");
      expect(new Set(rebuiltSyntax.nodes.filter((node) => node.language === "typescript").map((node) => node.analysisLevel))).toEqual(new Set(["syntax"]));
      expect(app.code.indexer.typeScriptInstrumentation()).toEqual({ programCreations: 0, syntaxWorkItems: 0, precisionWorkItems: 0 });
    } finally {
      await app.close();
    }
  });

  it("uses registered adapter discovery descriptors for both language projects", async () => {
    const root = mixedWorkspace();
    const app = new ContextMeshApp(root);
    const typescriptAdapter = app.code.indexer.coordinator.adapter("typescript/javascript")!;
    const pythonAdapter = app.code.indexer.coordinator.adapter("python")!;
    const typescriptDiscovery = vi.spyOn(typescriptAdapter, "discoverProject");
    const pythonDiscovery = vi.spyOn(pythonAdapter, "discoverProject");
    try {
      const indexed = await app.indexWorkspace({ mode: "full" }) as Envelope<{ adapterStats: Array<{ language: string; configHash: string }> }>;
      expect(typescriptDiscovery).toHaveBeenCalledTimes(1);
      expect(pythonDiscovery).toHaveBeenCalledTimes(1);
      const tsDescriptor = typescriptDiscovery.mock.results[0]!.value;
      const pyDescriptor = pythonDiscovery.mock.results[0]!.value;
      expect(tsDescriptor.configHash).not.toBe("");
      expect((tsDescriptor.runtime as { compiler?: { options?: unknown; configuredFileNames?: Set<string> } }).compiler)
        .toMatchObject({ options: expect.any(Object), configuredFileNames: expect.any(Set) });
      expect(indexed.data.adapterStats.find((item) => item.language === "typescript/javascript")?.configHash).toBe(tsDescriptor.configHash);
      expect(indexed.data.adapterStats.find((item) => item.language === "python")?.configHash).toBe(pyDescriptor.configHash);
    } finally {
      await app.close();
    }
  });

  it("handles decorated declarations, relative package imports, multiple imports, aliases, and deterministic IDs", async () => {
    const root = mixedWorkspace();
    writeFileSync(path.join(root, "src", "acme", "helper.py"), "VALUE = 1\n");
    writeFileSync(path.join(root, "src", "acme", "syntax_cases.py"), [
      "import alpha, beta as bee", "from . import helper", "", "def deco(fn):", "    return fn", "",
      "@deco", "def target():", "    return 1", "", "def caller():", "    return target()", "",
    ].join("\n"));
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const target = await app.searchCode({ query: "target", kinds: ["function"] }) as Envelope<{
        results: Array<{ id: string; localKey: string; metadata: { stableLocator?: string; declarationHash?: string } }>;
      }>;
      expect(target.data.results).toHaveLength(1);
      expect(target.data.results[0]!.localKey).toMatch(/:1:[0-9a-f]{16}$/);
      expect(target.data.results[0]!.metadata).toMatchObject({ stableLocator: expect.any(String), declarationHash: expect.any(String) });
      const caller = await app.searchCode({ query: "caller", kinds: ["function"] }) as Envelope<{ results: Array<{ id: string }> }>;
      const trace = await app.traceCode({ symbolId: caller.data.results[0]!.id, direction: "out", depth: 1 }) as Envelope<{
        edges: Array<{ kind: string; confidence: number; targetId: string }>; unresolved: Array<{ rawName: string }>;
      }>;
      expect(trace.data.edges).toContainEqual(expect.objectContaining({ kind: "CALLS", confidence: 0.8, targetId: target.data.results[0]!.id }));
      expect(trace.data.unresolved.some((item) => item.rawName === "target")).toBe(false);
      const module = await app.searchCode({ query: "syntax_cases", kinds: ["module"] }) as Envelope<{ results: Array<{ id: string }> }>;
      const imports = await app.traceCode({ symbolId: module.data.results[0]!.id, direction: "out", depth: 1 }) as Envelope<{
        nodes: Array<{ name: string }>; edges: Array<{ kind: string; metadata: { alias?: string | null } }>;
      }>;
      expect(imports.data.nodes.map((node) => node.name)).toEqual(expect.arrayContaining(["alpha", "beta", "acme.helper"]));
      const stored = app.database.getStoredGraphPartition("python");
      expect(stored.edges).toContainEqual(expect.objectContaining({ kind: "IMPORTS", metadata: expect.objectContaining({ alias: "bee" }) }));
      const firstId = target.data.results[0]!.id;
      await app.indexWorkspace({ mode: "full" });
      const repeated = await app.searchCode({ query: "target", kinds: ["function"] }) as Envelope<{ results: Array<{ id: string }> }>;
      expect(repeated.data.results[0]!.id).toBe(firstId);
    } finally {
      await app.close();
    }
  });
});
