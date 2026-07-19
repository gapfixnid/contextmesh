import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope } from "../src/contracts.js";

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v05-"));
  roots.push(root);
  mkdirSync(path.join(root, "python", "pkg"), { recursive: true });
  mkdirSync(path.join(root, "go", "worker"), { recursive: true });
  mkdirSync(path.join(root, "rust", "src"), { recursive: true });
  mkdirSync(path.join(root, "java", "src"), { recursive: true });
  mkdirSync(path.join(root, "dotnet"), { recursive: true });
  writeFileSync(path.join(root, "python", "pkg", "target.py"), "class Base:\n    pass\n\ndef selected():\n    return 1\n");
  writeFileSync(path.join(root, "python", "pkg", "caller.py"), "from pkg.target import Base as Parent\nfrom pkg.target import selected as chosen\n\nclass Child(Parent):\n    pass\n\ndef caller():\n    return chosen()\n");
  writeFileSync(path.join(root, "pyproject.toml"), "[tool.setuptools.packages.find]\nwhere=['python']\n");
  writeFileSync(path.join(root, "go", "worker", "worker.go"), "package worker\nfunc Target() int { return 1 }\nfunc Caller() int { return Target() }\n");
  writeFileSync(path.join(root, "go.mod"), "module example.local/contextmesh\n\ngo 1.23\n");
  writeFileSync(path.join(root, "rust", "src", "lib.rs"), "pub fn rust_target() -> i32 { 1 }\npub fn rust_caller() -> i32 { rust_target() }\n");
  writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname='fixture'\nversion='0.1.0'\n");
  writeFileSync(path.join(root, "java", "src", "Worker.java"), "package fixture; public class Worker { public int javaTarget() { return 1; } public int javaCaller() { return javaTarget(); } }\n");
  writeFileSync(path.join(root, "dotnet", "Worker.cs"), "namespace Fixture; public class CsWorker { public int CsTarget() { return 1; } public int CsCaller() { return CsTarget(); } }\n");
  return root;
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });

describe("v0.5 precision overlays and core languages", () => {
  it("indexes Go, Rust, Java, and C# syntax without configured precision providers", async () => {
    const root = workspace();
    const priorDisable = process.env.CONTEXTMESH_GO_TYPES_DISABLE;
    process.env.CONTEXTMESH_GO_TYPES_DISABLE = "1";
    const app = new ContextMeshApp(root);
    try {
      const indexed = await app.indexWorkspace({ mode: "full" }) as Envelope<{ adapterStats: Array<{ language: string }> }>;
      expect(indexed.data.adapterStats.map((item) => item.language)).toEqual([
        "python", "go", "rust", "java", "csharp",
      ]);
      for (const [query, language] of [["Target", "go"], ["rust_target", "rust"], ["Worker", "java"], ["CsWorker", "csharp"]] as const) {
        const result = await app.searchCode({ query }) as Envelope<{ results: Array<{ language: string }> }>;
        expect(result.data.results.some((item) => item.language === language)).toBe(true);
      }
      const status = (await app.workspaceStatus()).data as { precision: { providers: Array<{ provider: string; status: string; lastError: string | null }> } };
      expect(status.precision.providers).toContainEqual(expect.objectContaining({
        provider: "go_types", status: "not_configured", lastError: "go/types disabled by policy",
      }));
      expect(status.precision.providers).toContainEqual(expect.objectContaining({
        provider: "rust_analyzer", status: "not_configured", lastError: expect.any(String),
      }));
      const caller = await app.searchCode({ query: "Caller", kinds: ["function"] }) as Envelope<{ results: Array<{ id: string; language: string }> }>;
      const goCaller = caller.data.results.find((item) => item.language === "go")!;
      const trace = await app.traceCode({ symbolId: goCaller.id, direction: "out", depth: 1 }) as Envelope<{ edges: Array<{ kind: string; status: string }> }>;
      expect(trace.data.edges).toContainEqual(expect.objectContaining({ kind: "CALLS", status: "candidate" }));
    } finally {
      if (priorDisable === undefined) delete process.env.CONTEXTMESH_GO_TYPES_DISABLE;
      else process.env.CONTEXTMESH_GO_TYPES_DISABLE = priorDisable;
      await app.close();
    }
  });

  it("resolves Python aliases in an independent revision and leaves base generation unchanged on no-op", async () => {
    const root = workspace();
    const app = new ContextMeshApp(root);
    try {
      const indexed = await app.indexWorkspace({ mode: "full" });
      const generation = indexed.generation;
      const firstRevision = indexed.snapshot!.precisionRevision;
      expect(firstRevision).toBeGreaterThan(0);
      const caller = await app.searchCode({ query: "caller", kinds: ["function"] }) as Envelope<{ results: Array<{ id: string }> }>;
      const selected = await app.searchCode({ query: "selected", kinds: ["function"] }) as Envelope<{ results: Array<{ id: string }> }>;
      const trace = await app.traceCode({ symbolId: caller.data.results[0]!.id, direction: "out", depth: 1 }) as Envelope<{ edges: Array<{ targetId: string; status: string; evidence: Array<{ provider: string }> }> }>;
      expect(trace.data.edges).toContainEqual(expect.objectContaining({
        targetId: selected.data.results[0]!.id,
        status: "resolved",
        evidence: expect.arrayContaining([expect.objectContaining({ provider: "contextmesh_python_resolver" })]),
      }));
      const child = await app.searchCode({ query: "Child", kinds: ["class"] }) as Envelope<{ results: Array<{ id: string }> }>;
      const base = await app.searchCode({ query: "Base", kinds: ["class"] }) as Envelope<{ results: Array<{ id: string }> }>;
      const inheritance = await app.traceCode({ symbolId: child.data.results[0]!.id, direction: "out", edgeKinds: ["EXTENDS"], depth: 1 }) as Envelope<{ edges: Array<{ targetId: string; status: string }> }>;
      expect(inheritance.data.edges).toContainEqual(expect.objectContaining({ targetId: base.data.results[0]!.id, status: "resolved" }));
      const noOp = await app.indexWorkspace({ mode: "incremental" }) as Envelope<{ noOp: boolean }>;
      expect(noOp.data.noOp).toBe(true);
      expect(noOp.generation).toBe(generation);
      expect(noOp.snapshot!.precisionRevision).toBe(firstRevision);
    } finally { await app.close(); }
  });

  it("fences concurrent precision writers with a provider lease", async () => {
    const root = workspace();
    const priorDisable = process.env.CONTEXTMESH_GO_TYPES_DISABLE;
    process.env.CONTEXTMESH_GO_TYPES_DISABLE = "1";
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const candidate = app.database.getStoredGraphPartition("non-python").edges.find((edge) => edge.kind === "CALLS" && edge.status === "candidate" &&
        app.database.getCodeNode(edge.sourceId)?.language === "go");
      expect(candidate).toBeDefined();
      const first = app.database.claimPrecisionProvider({ provider: "fixture_provider", providerVersion: "1", language: "go", capability: "resolved", owner: "owner-a", leaseMs: 60_000 });
      const second = app.database.claimPrecisionProvider({ provider: "fixture_provider", providerVersion: "1", language: "go", capability: "resolved", owner: "owner-b", leaseMs: 60_000 });
      expect(first.reason).toBe("acquired");
      expect(second.reason).toBe("leased");
      expect(app.database.heartbeatPrecisionProvider(first.claim!, 60_000)).toBe(true);
      expect(app.database.commitPrecisionOverlay(first.claim!, { edges: [{
        sourceId: candidate!.sourceId, targetId: candidate!.targetId, kind: candidate!.kind, status: "rejected",
        confidence: 1, resolutionKind: candidate!.resolutionKind,
        evidence: [{ provider: "fixture_provider", providerVersion: "1", source: "type_checker", confidence: 1 }],
      }], eligibleEdges: 1, diagnostics: [] })).toBe(true);
      expect(app.database.getWorkspace().currentGeneration).toBe(1);
      expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({ provider: "fixture_provider", status: "ready" }));
      const trace = await app.traceCode({ symbolId: candidate!.sourceId, direction: "out", edgeKinds: ["CALLS"], depth: 1 }) as Envelope<{ edges: Array<{ targetId: string; status: string }> }>;
      expect(trace.data.edges).toContainEqual(expect.objectContaining({ targetId: candidate!.targetId, status: "rejected" }));
    } finally {
      if (priorDisable === undefined) delete process.env.CONTEXTMESH_GO_TYPES_DISABLE;
      else process.env.CONTEXTMESH_GO_TYPES_DISABLE = priorDisable;
      await app.close();
    }
  });

  it("applies the provider conformance contract for deterministic IDs, spans, partial parses, and evidence", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "rust", "src", "broken.rs"), "pub fn recoverable( {\n");
    const app = new ContextMeshApp(root);
    try {
      const first = await app.indexWorkspace({ mode: "full" }) as Envelope<{ diagnostics: string[] }>;
      expect(first.data.diagnostics).toContainEqual(expect.stringContaining("PROVIDER_PARSE_PARTIAL"));
      const recoverable = await app.searchCode({ query: "recoverable", kinds: ["function"] }) as Envelope<{ results: Array<{ id: string; startByte: number; endByte: number; startLine: number; startColumn: number }> }>;
      expect(recoverable.data.results).toHaveLength(1);
      expect(recoverable.data.results[0]).toMatchObject({ startByte: expect.any(Number), endByte: expect.any(Number), startLine: 1, startColumn: expect.any(Number) });
      const firstIds = app.database.getStoredGraphPartition("non-python").nodes.map((node) => node.id).sort();
      const evidence = app.database.getStoredGraphPartition("non-python").edges.flatMap((edge) => edge.evidence ?? []);
      expect(evidence.every((item) => item.provider.length > 0 && item.providerVersion.length > 0 && item.confidence >= 0 && item.confidence <= 1)).toBe(true);
      await app.indexWorkspace({ mode: "full" });
      expect(app.database.getStoredGraphPartition("non-python").nodes.map((node) => node.id).sort()).toEqual(firstIds);
    } finally { await app.close(); }
  });
});
