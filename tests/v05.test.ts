import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextMeshApp } from "../src/app.js";
import { probeRustAnalyzerRuntime } from "../src/code/languages/rust-precision.js";
import type { CodeEvidence, Envelope } from "../src/contracts.js";

const roots: string[] = [];
let priorRustAnalyzerDisable: string | undefined;

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

beforeEach(() => {
  priorRustAnalyzerDisable = process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE;
  process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE = "1";
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  if (priorRustAnalyzerDisable === undefined) delete process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE;
  else process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE = priorRustAnalyzerDisable;
});

describe("v0.5 precision overlays and core languages", () => {
  it("reports disabled Python precision as unavailable without claiming resolved coverage", async () => {
    const root = workspace();
    const priorDisable = process.env.CONTEXTMESH_PYTHON_PRECISION_DISABLE;
    process.env.CONTEXTMESH_PYTHON_PRECISION_DISABLE = "1";
    const app = new ContextMeshApp(root);
    try {
      const indexed = await app.indexWorkspace({ mode: "full" }) as Envelope<{
        adapterStats: Array<{
          language: string;
          precisionProvider: string | null;
          analysisLevel: string;
          precisionInvocations: number;
          status: string;
          coverage: number;
        }>;
      }>;
      expect(indexed.data.adapterStats).toContainEqual(expect.objectContaining({
        language: "python",
        precisionProvider: "contextmesh_python_resolver",
        analysisLevel: "syntax",
        precisionInvocations: 0,
        status: "not_configured",
        coverage: 0,
      }));
      expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
        language: "python",
        provider: "contextmesh_python_resolver",
        status: "not_configured",
        coverage: 0,
        lastError: expect.stringMatching(/disabled/i),
      }));
    } finally {
      if (priorDisable === undefined) delete process.env.CONTEXTMESH_PYTHON_PRECISION_DISABLE;
      else process.env.CONTEXTMESH_PYTHON_PRECISION_DISABLE = priorDisable;
      await app.close();
    }
  });

  it("reprobes a previously unavailable precision provider on a no-op generation", async () => {
    const root = workspace();
    const app = new ContextMeshApp(root);
    const adapter = app.code.indexer.coordinator.adapter("go")!;
    const mutableAdapter = adapter as {
      createOverlayPrecisionProvider: NonNullable<typeof adapter.createOverlayPrecisionProvider>;
    };
    const originalProvider = mutableAdapter.createOverlayPrecisionProvider;
    let available = false;
    let probes = 0;
    mutableAdapter.createOverlayPrecisionProvider = () => ({
      id: "recovery_fixture",
      version: "1",
      capability: "resolved",
      available: async () => {
        probes += 1;
        return available ? { available: true } : { available: false, diagnostic: "temporarily unavailable" };
      },
      analyze: async (batch, baseGeneration) => {
        const candidate = batch.edges.find((edge) => edge.kind === "CALLS" && edge.status === "candidate")!;
        return {
          language: "go",
          provider: "recovery_fixture",
          providerVersion: "1",
          capability: "resolved",
          baseGeneration,
          edges: [{
            sourceId: candidate.sourceId, targetId: candidate.targetId, kind: candidate.kind,
            status: "resolved" as const, confidence: 1, resolutionKind: candidate.resolutionKind,
            evidence: [{ provider: "recovery_fixture", providerVersion: "1", source: "type_checker" as const, confidence: 1 }],
          }],
          eligibleEdges: 1,
          diagnostics: [],
        };
      },
    });
    try {
      const first = await app.indexWorkspace({ mode: "full" });
      expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
        provider: "recovery_fixture",
        status: "not_configured",
      }));
      available = true;
      const noOp = await app.indexWorkspace({ mode: "incremental" }) as Envelope<{ noOp: boolean }>;
      expect(noOp.data.noOp).toBe(true);
      expect(noOp.generation).toBe(first.generation);
      expect(probes).toBe(2);
      expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
        provider: "recovery_fixture",
        status: "ready",
        baseGeneration: first.generation,
      }));
      const candidate = app.database.getStoredGraphPartition("non-python", false).edges.find((edge) =>
        edge.kind === "CALLS" && app.database.getCodeNode(edge.sourceId)?.language === "go")!;
      let trace = await app.traceCode({ symbolId: candidate.sourceId, direction: "out", edgeKinds: ["CALLS"], depth: 1 }) as Envelope<{
        edges: Array<{ targetId: string; status: string }>;
      }>;
      expect(trace.data.edges).toContainEqual(expect.objectContaining({ targetId: candidate.targetId, status: "resolved" }));
      const readyRevision = app.database.getPrecisionRevision();

      available = false;
      const disabled = await app.indexWorkspace({ mode: "incremental" }) as Envelope<{
        adapterStats: Array<{ language: string; analysisLevel: string; coverage: number; status: string }>;
      }>;
      expect(probes).toBe(3);
      expect(app.database.getPrecisionRevision()).toBe(readyRevision + 1);
      expect(disabled.data.adapterStats).toContainEqual(expect.objectContaining({
        language: "go", analysisLevel: "syntax", coverage: 0, status: "not_configured",
      }));
      trace = await app.traceCode({ symbolId: candidate.sourceId, direction: "out", edgeKinds: ["CALLS"], depth: 1 }) as Envelope<{
        edges: Array<{ targetId: string; status: string }>;
      }>;
      expect(trace.data.edges).toContainEqual(expect.objectContaining({ targetId: candidate.targetId, status: "candidate" }));
    } finally {
      mutableAdapter.createOverlayPrecisionProvider = originalProvider;
      await app.close();
    }
  });

  it("indexes Go, Rust, Java, and C# syntax without configured precision providers", async () => {
    const root = workspace();
    const priorGoDisable = process.env.CONTEXTMESH_GO_TYPES_DISABLE;
    const priorRustDisable = process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE;
    process.env.CONTEXTMESH_GO_TYPES_DISABLE = "1";
    process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE = "1";
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
      if (priorGoDisable === undefined) delete process.env.CONTEXTMESH_GO_TYPES_DISABLE;
      else process.env.CONTEXTMESH_GO_TYPES_DISABLE = priorGoDisable;
      if (priorRustDisable === undefined) delete process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE;
      else process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE = priorRustDisable;
      await app.close();
    }
  });

  it("assigns calls to the nearest callable while Java initializers remain module-owned", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "java", "src", "Worker.java"), [
      "package fixture;",
      "public class Worker {",
      "  static int staticValue = javaTargetA();",
      "  int fieldValue = javaTargetB();",
      "  { javaTargetC(); }",
      "  public int javaTargetA() { return 1; }",
      "  public int javaTargetB() { return 1; }",
      "  public int javaTargetC() { return 1; }",
      "  public int javaTarget() { return 1; }",
      "  public int javaCaller() { return javaTarget(); }",
      "}",
    ].join("\n"));
    writeFileSync(path.join(root, "rust", "src", "lib.rs"), [
      "pub fn rust_target() -> i32 { 1 }",
      "pub fn rust_outer() -> i32 {",
      "    fn rust_inner() -> i32 { rust_target() }",
      "    rust_target() + rust_inner()",
      "}",
      "",
    ].join("\n"));
    writeFileSync(path.join(root, "dotnet", "Worker.cs"), [
      "namespace Fixture;",
      "public class CsWorker {",
      "  public int CsTarget() { return 1; }",
      "  public int CsOuter() {",
      "    int CsLocal() { return CsTarget(); }",
      "    return CsTarget() + CsLocal();",
      "  }",
      "}",
      "",
    ].join("\n"));
    const priorGoDisable = process.env.CONTEXTMESH_GO_TYPES_DISABLE;
    process.env.CONTEXTMESH_GO_TYPES_DISABLE = "1";
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const graph = app.database.getStoredGraphPartition("non-python", false);
      const goCaller = graph.nodes.find((node) => node.language === "go" && node.name === "Caller")!;
      expect(graph.edges.some((edge) => edge.kind === "CALLS" && edge.sourceId === goCaller.id)).toBe(true);
      const rustTarget = graph.nodes.find((node) => node.language === "rust" && node.name === "rust_target")!;
      for (const ownerName of ["rust_outer", "rust_inner"]) {
        const owner = graph.nodes.find((node) => node.language === "rust" && node.name === ownerName)!;
        expect(graph.edges).toContainEqual(expect.objectContaining({
          sourceId: owner.id, targetId: rustTarget.id, kind: "CALLS",
        }));
      }
      const csTarget = graph.nodes.find((node) => node.language === "csharp" && node.name === "CsTarget")!;
      for (const ownerName of ["CsOuter", "CsLocal"]) {
        const owner = graph.nodes.find((node) => node.language === "csharp" && node.name === ownerName)!;
        expect(graph.edges).toContainEqual(expect.objectContaining({
          sourceId: owner.id, targetId: csTarget.id, kind: "CALLS",
        }));
      }
      const javaModule = graph.nodes.find((node) => node.language === "java" && node.kind === "module")!;
      const javaCaller = graph.nodes.find((node) => node.language === "java" && node.name === "javaCaller")!;
      expect(graph.edges.filter((edge) => edge.kind === "CALLS" && edge.sourceId === javaModule.id)).toHaveLength(3);
      expect(graph.edges.filter((edge) => edge.kind === "CALLS" && edge.sourceId === javaCaller.id)).toHaveLength(1);
    } finally {
      if (priorGoDisable === undefined) delete process.env.CONTEXTMESH_GO_TYPES_DISABLE;
      else process.env.CONTEXTMESH_GO_TYPES_DISABLE = priorGoDisable;
      await app.close();
    }
  });

  it("maps inheritance for duplicate Python class names by source span", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "python", "pkg", "target.py"), "class BaseA:\n    pass\n\nclass BaseB:\n    pass\n");
    writeFileSync(path.join(root, "python", "pkg", "caller.py"), [
      "from pkg.target import BaseA, BaseB",
      "class First:",
      "    class Duplicate(BaseA):",
      "        pass",
      "class Second:",
      "    class Duplicate(BaseB):",
      "        pass",
      "",
    ].join("\n"));
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const graph = app.database.getStoredGraphPartition("python");
      const duplicates = graph.nodes.filter((node) => node.language === "python" && node.name === "Duplicate")
        .sort((left, right) => left.startLine - right.startLine);
      const baseA = graph.nodes.find((node) => node.language === "python" && node.name === "BaseA")!;
      const baseB = graph.nodes.find((node) => node.language === "python" && node.name === "BaseB")!;
      expect(duplicates).toHaveLength(2);
      expect(graph.edges).toContainEqual(expect.objectContaining({
        sourceId: duplicates[0]!.id, targetId: baseA.id, kind: "EXTENDS", status: "resolved",
      }));
      expect(graph.edges).toContainEqual(expect.objectContaining({
        sourceId: duplicates[1]!.id, targetId: baseB.id, kind: "EXTENDS", status: "resolved",
      }));
    } finally { await app.close(); }
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

  it("does not traverse beyond an edge rejected by a precision provider", async () => {
    const root = workspace();
    writeFileSync(
      path.join(root, "go", "worker", "worker.go"),
      "package worker\nfunc Deep() int { return 1 }\nfunc Target() int { return Deep() }\nfunc Caller() int { return Target() }\n",
    );
    const priorDisable = process.env.CONTEXTMESH_GO_TYPES_DISABLE;
    process.env.CONTEXTMESH_GO_TYPES_DISABLE = "1";
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const nodes = app.database.getStoredGraphPartition("non-python").nodes.filter((node) => node.language === "go");
      const caller = nodes.find((node) => node.name === "Caller")!;
      const target = nodes.find((node) => node.name === "Target")!;
      const deep = nodes.find((node) => node.name === "Deep")!;
      const candidate = app.database.getStoredGraphPartition("non-python").edges.find((edge) =>
        edge.sourceId === caller.id && edge.targetId === target.id && edge.kind === "CALLS");
      expect(candidate).toBeDefined();
      const acquired = app.database.claimPrecisionProvider({
        provider: "rejected_path_provider",
        providerVersion: "1",
        language: "go",
        capability: "resolved",
        owner: "rejected-path-owner",
      });
      expect(acquired.reason).toBe("acquired");
      expect(app.database.commitPrecisionOverlay(acquired.claim!, {
        edges: [{
          sourceId: caller.id,
          targetId: target.id,
          kind: "CALLS",
          status: "rejected",
          confidence: 1,
          resolutionKind: "local",
          evidence: [{
            provider: "rejected_path_provider",
            providerVersion: "1",
            source: "type_checker",
            confidence: 1,
          }],
        }],
        eligibleEdges: 1,
        diagnostics: [],
      })).toBe(true);

      const trace = await app.traceCode({
        symbolId: caller.id,
        direction: "out",
        edgeKinds: ["CALLS"],
        depth: 2,
      }) as Envelope<{ nodes: Array<{ id: string }>; edges: Array<{ sourceId: string; targetId: string; status: string }> }>;
      expect(trace.data.edges).toContainEqual(expect.objectContaining({
        sourceId: caller.id,
        targetId: target.id,
        status: "rejected",
      }));
      expect(trace.data.edges).not.toContainEqual(expect.objectContaining({ sourceId: target.id, targetId: deep.id }));
      expect(trace.data.nodes).not.toContainEqual(expect.objectContaining({ id: deep.id }));
    } finally {
      if (priorDisable === undefined) delete process.env.CONTEXTMESH_GO_TYPES_DISABLE;
      else process.env.CONTEXTMESH_GO_TYPES_DISABLE = priorDisable;
      await app.close();
    }
  });

  it("fences an expired precision-provider lease from heartbeat, commit, and failure", async () => {
    const root = workspace();
    const priorDisable = process.env.CONTEXTMESH_GO_TYPES_DISABLE;
    process.env.CONTEXTMESH_GO_TYPES_DISABLE = "1";
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const candidate = app.database.getStoredGraphPartition("non-python").edges.find((edge) =>
        edge.kind === "CALLS" && edge.status === "candidate" &&
        app.database.getCodeNode(edge.sourceId)?.language === "go");
      expect(candidate).toBeDefined();
      const acquired = app.database.claimPrecisionProvider({
        provider: "expired_fixture_provider",
        providerVersion: "1",
        language: "go",
        capability: "resolved",
        owner: "expired-owner",
        leaseMs: 60_000,
      });
      expect(acquired.reason).toBe("acquired");

      const raw = new DatabaseSync(app.database.dbPath);
      raw.prepare(
        "UPDATE precision_provider_state SET lease_expires_epoch=? WHERE workspace_id=? AND provider=?",
      ).run(Date.now() - 1_000, app.database.workspace.id, "expired_fixture_provider");
      raw.close();

      expect(app.database.heartbeatPrecisionProvider(acquired.claim!, 60_000)).toBe(false);
      expect(app.database.commitPrecisionOverlay(acquired.claim!, { edges: [{
        sourceId: candidate!.sourceId,
        targetId: candidate!.targetId,
        kind: candidate!.kind,
        status: "rejected",
        confidence: 1,
        resolutionKind: candidate!.resolutionKind,
        evidence: [{
          provider: "expired_fixture_provider",
          providerVersion: "1",
          source: "type_checker",
          confidence: 1,
        }],
      }], eligibleEdges: 1, diagnostics: [] })).toBe(false);
      expect(app.database.failPrecisionProvider(acquired.claim!, "late failure")).toBe(false);
      const takeover = app.database.claimPrecisionProvider({
        provider: "expired_fixture_provider", providerVersion: "1", language: "go",
        capability: "resolved", owner: "takeover-owner", leaseMs: 60_000,
      });
      expect(takeover.reason).toBe("acquired");
      expect(takeover.claim!.transitionEpoch).toBeGreaterThan(acquired.claim!.transitionEpoch);
      expect(app.database.abandonPrecisionProvider(takeover.claim!, "fixture complete")).toBe(true);
    } finally {
      if (priorDisable === undefined) delete process.env.CONTEXTMESH_GO_TYPES_DISABLE;
      else process.env.CONTEXTMESH_GO_TYPES_DISABLE = priorDisable;
      await app.close();
    }
  });

  it("atomically fences a late worker when provider policy changes without advancing graph revision", async () => {
    const root = workspace();
    const priorDisable = process.env.CONTEXTMESH_GO_TYPES_DISABLE;
    process.env.CONTEXTMESH_GO_TYPES_DISABLE = "1";
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const candidate = app.database.getStoredGraphPartition("non-python").edges.find((edge) =>
        edge.kind === "CALLS" && edge.status === "candidate" &&
        app.database.getCodeNode(edge.sourceId)?.language === "go");
      expect(candidate).toBeDefined();
      const beforeRevision = app.database.getPrecisionRevision();
      const trusted = app.database.claimPrecisionProvider({
        provider: "policy_transition_fixture", providerVersion: "trusted", language: "go",
        capability: "resolved", owner: "trusted-worker", leaseMs: 60_000,
      });
      expect(trusted.reason).toBe("acquired");
      expect(app.database.getPrecisionRevision()).toBe(beforeRevision);

      app.database.transitionPrecisionProvider({
        language: "go", provider: "policy_transition_fixture", providerVersion: "safe",
        capability: "resolved", status: "stale", lastError: "policy changed",
      });
      expect(app.database.getPrecisionRevision()).toBe(beforeRevision);
      expect(app.database.heartbeatPrecisionProvider(trusted.claim!, 60_000)).toBe(false);
      expect(app.database.commitPrecisionOverlay(trusted.claim!, { edges: [{
        sourceId: candidate!.sourceId, targetId: candidate!.targetId, kind: candidate!.kind,
        status: "resolved", confidence: 1, resolutionKind: candidate!.resolutionKind,
        evidence: [{ provider: "policy_transition_fixture", providerVersion: "trusted", source: "type_checker", confidence: 1 }],
      }], eligibleEdges: 1, diagnostics: [] })).toBe(false);
      expect(app.database.failPrecisionProvider(trusted.claim!, "late failure")).toBe(false);

      const safe = app.database.claimPrecisionProvider({
        provider: "policy_transition_fixture", providerVersion: "safe", language: "go",
        capability: "resolved", owner: "safe-worker", leaseMs: 60_000,
      });
      expect(safe.reason).toBe("acquired");
      expect(safe.claim!.transitionEpoch).toBeGreaterThan(trusted.claim!.transitionEpoch);
      expect(app.database.getPrecisionRevision()).toBe(beforeRevision);
      expect(app.database.abandonPrecisionProvider(safe.claim!, "fixture complete")).toBe(true);
      expect(app.database.getPrecisionRevision()).toBe(beforeRevision);

      const trace = await app.traceCode({
        symbolId: candidate!.sourceId, direction: "out", edgeKinds: ["CALLS"], depth: 1,
      }) as Envelope<{ edges: Array<{ targetId: string; status: string }> }>;
      expect(trace.data.edges).toContainEqual(expect.objectContaining({
        targetId: candidate!.targetId, status: "candidate",
      }));
    } finally {
      if (priorDisable === undefined) delete process.env.CONTEXTMESH_GO_TYPES_DISABLE;
      else process.env.CONTEXTMESH_GO_TYPES_DISABLE = priorDisable;
      await app.close();
    }
  });

  it("retains a committed precision overlay during replacement and fences withdrawal with a revision", async () => {
    const root = workspace();
    const priorDisable = process.env.CONTEXTMESH_GO_TYPES_DISABLE;
    process.env.CONTEXTMESH_GO_TYPES_DISABLE = "1";
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const base = app.database.getStoredGraphPartition("non-python", false).nodes.find((node) =>
        node.language === "go" && node.name === "Target");
      expect(base).toMatchObject({ analysisLevel: "syntax", doc: "" });

      const acquired = app.database.claimPrecisionProvider({
        provider: "typed_node_fixture",
        providerVersion: "1",
        language: "go",
        capability: "typed",
        owner: "typed-node-owner-a",
      });
      expect(acquired.reason).toBe("acquired");
      expect(app.database.commitPrecisionOverlay(acquired.claim!, {
        nodes: [{
          nodeId: base!.id,
          analysisLevel: "typed",
          signature: "func Target() string",
          doc: "precisionOnlyDocumentation",
          contentHash: base!.contentHash,
          metadata: { ...base!.metadata, precisionFixture: true },
        }],
        edges: [],
        eligibleEdges: 0,
        diagnostics: [],
      })).toBe(true);

      expect(app.database.getCodeNode(base!.id)).toMatchObject({
        analysisLevel: "typed",
        signature: "func Target() string",
        doc: "precisionOnlyDocumentation",
        metadata: expect.objectContaining({ precisionFixture: true }),
      });
      expect(app.database.searchCode("precisionOnlyDocumentation", undefined, 10).map((node) => node.id))
        .toContain(base!.id);
      expect(app.database.getStoredGraphPartition("non-python", false).nodes.find((node) => node.id === base!.id))
        .toMatchObject({ analysisLevel: "syntax", doc: "" });
      const committedRevision = app.database.getPrecisionRevision();

      const identical = app.database.claimPrecisionProvider({
        provider: "typed_node_fixture",
        providerVersion: "1",
        language: "go",
        capability: "typed",
        owner: "typed-node-identical",
      });
      expect(identical.reason).toBe("acquired");
      expect(app.database.commitPrecisionOverlay(identical.claim!, {
        nodes: [{
          nodeId: base!.id,
          analysisLevel: "typed",
          signature: "func Target() string",
          doc: "precisionOnlyDocumentation",
          contentHash: base!.contentHash,
          metadata: { ...base!.metadata, precisionFixture: true },
        }],
        edges: [],
        eligibleEdges: 0,
        diagnostics: [],
      })).toBe(true);
      expect(app.database.getPrecisionRevision()).toBe(committedRevision);

      const replacement = app.database.claimPrecisionProvider({
        provider: "typed_node_fixture",
        providerVersion: "1",
        language: "go",
        capability: "typed",
        owner: "typed-node-owner-b",
      });
      expect(replacement.reason).toBe("acquired");
      expect(app.database.getPrecisionRevision()).toBe(committedRevision);
      expect(app.database.getCodeNode(base!.id)).toMatchObject({
        analysisLevel: "typed",
        doc: "precisionOnlyDocumentation",
      });
      expect(app.database.searchCode("precisionOnlyDocumentation", undefined, 10).map((node) => node.id))
        .toContain(base!.id);
      const duringReplacement = await app.searchCode({ query: "precisionOnlyDocumentation" }) as Envelope<{
        results: Array<{ id: string }>;
      }>;
      expect(duringReplacement.snapshot!.precisionRevision).toBe(committedRevision);
      expect(duringReplacement.data.results.map((node) => node.id)).toContain(base!.id);
      expect(app.database.abandonPrecisionProvider(replacement.claim!, "fixture stopped")).toBe(true);
      expect(app.database.getPrecisionRevision()).toBe(committedRevision + 1);
      expect(app.database.getCodeNode(base!.id)).toMatchObject({ analysisLevel: "syntax", doc: "" });
      const afterWithdrawal = await app.searchCode({ query: "precisionOnlyDocumentation" }) as Envelope<{
        results: Array<{ id: string }>;
      }>;
      expect(afterWithdrawal.snapshot!.precisionRevision).toBe(committedRevision + 1);
      expect(afterWithdrawal.data.results.map((node) => node.id)).not.toContain(base!.id);
    } finally {
      if (priorDisable === undefined) delete process.env.CONTEXTMESH_GO_TYPES_DISABLE;
      else process.env.CONTEXTMESH_GO_TYPES_DISABLE = priorDisable;
      await app.close();
    }
  });

  it("records an explicit terminal state when a precision provider loses its lease", async () => {
    const root = workspace();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const app = new ContextMeshApp(root, undefined, { clock: () => now });
    const adapter = app.code.indexer.coordinator.adapter("go")!;
    const mutableAdapter = adapter as {
      createOverlayPrecisionProvider: NonNullable<typeof adapter.createOverlayPrecisionProvider>;
    };
    const originalProvider = mutableAdapter.createOverlayPrecisionProvider;
    mutableAdapter.createOverlayPrecisionProvider = () => ({
      id: "lease_loss_fixture",
      version: "1",
      capability: "typed",
      available: async () => ({ available: true }),
      analyze: async (_batch, baseGeneration) => {
        now = new Date(now.getTime() + 31_000);
        return {
          language: "go", provider: "lease_loss_fixture", providerVersion: "1", capability: "typed",
          baseGeneration, edges: [], eligibleEdges: 0, diagnostics: [],
        };
      },
    });
    try {
      await app.indexWorkspace({ mode: "full" });
      expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
        provider: "lease_loss_fixture",
        status: "failed",
        lastError: expect.stringMatching(/lease lost/i),
        leaseExpiresAt: null,
      }));
    } finally {
      mutableAdapter.createOverlayPrecisionProvider = originalProvider;
      await app.close();
    }
  });

  it("reports a precision claim exception instead of treating it as ordinary contention", async () => {
    const root = workspace();
    const app = new ContextMeshApp(root);
    const adapter = app.code.indexer.coordinator.adapter("go")!;
    const mutableAdapter = adapter as {
      createOverlayPrecisionProvider: NonNullable<typeof adapter.createOverlayPrecisionProvider>;
    };
    const originalProvider = mutableAdapter.createOverlayPrecisionProvider;
    mutableAdapter.createOverlayPrecisionProvider = () => ({
      id: "claim_exception_fixture", version: "1", capability: "resolved",
      available: async () => ({ available: true }),
      analyze: async (_batch, baseGeneration) => ({
        language: "go", provider: "claim_exception_fixture", providerVersion: "1",
        capability: "resolved", baseGeneration, edges: [], eligibleEdges: 0, diagnostics: [],
      }),
    });
    const originalClaim = app.database.claimPrecisionProvider.bind(app.database);
    const claimSpy = vi.spyOn(app.database, "claimPrecisionProvider").mockImplementation((input) => {
      if (input.provider === "claim_exception_fixture") throw new Error("injected claim failure");
      return originalClaim(input);
    });
    try {
      const indexed = await app.indexWorkspace({ mode: "full" }) as Envelope<{
        adapterStats: Array<{ language: string; analysisLevel: string; status: string; coverage: number }>;
      }>;
      expect(indexed.warnings).toContainEqual(expect.stringMatching(/PRECISION_PROVIDER_CLAIM_FAILED.*injected claim failure/));
      expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
        provider: "claim_exception_fixture", status: "failed",
        lastError: expect.stringMatching(/PRECISION_PROVIDER_CLAIM_FAILED/),
      }));
      expect(indexed.data.adapterStats).toContainEqual(expect.objectContaining({
        language: "go", analysisLevel: "syntax", status: "failed", coverage: 0,
      }));
      const status = await app.workspaceStatus() as Envelope<{
        adapterStats: Array<{ language: string; analysisLevel: string; status: string; coverage: number }>;
      }>;
      expect(status.data.adapterStats).toContainEqual(expect.objectContaining({
        language: "go", analysisLevel: "syntax", status: "failed", coverage: 0,
      }));
    } finally {
      claimSpy.mockRestore();
      mutableAdapter.createOverlayPrecisionProvider = originalProvider;
      await app.close();
    }
  });

  it("leaves a live matching provider claim intact as ordinary contention", async () => {
    const root = workspace();
    const app = new ContextMeshApp(root);
    const adapter = app.code.indexer.coordinator.adapter("go")!;
    const mutableAdapter = adapter as {
      createOverlayPrecisionProvider: NonNullable<typeof adapter.createOverlayPrecisionProvider>;
    };
    const originalProvider = mutableAdapter.createOverlayPrecisionProvider;
    try {
      await app.indexWorkspace({ mode: "full" });
      mutableAdapter.createOverlayPrecisionProvider = () => ({
        id: "contention_fixture", version: "1", capability: "resolved",
        available: async () => ({ available: true }),
        analyze: async () => { throw new Error("contended provider must not run"); },
      });
      const active = app.database.claimPrecisionProvider({
        provider: "contention_fixture", providerVersion: "1", language: "go",
        capability: "resolved", owner: "foreign-worker", leaseMs: 60_000,
      });
      expect(active.reason).toBe("acquired");
      const indexed = await app.indexWorkspace({ mode: "incremental" });
      expect(indexed.warnings).not.toContainEqual(expect.stringMatching(/PRECISION_PROVIDER_CLAIM_FAILED/));
      expect(app.database.heartbeatPrecisionProvider(active.claim!, 60_000)).toBe(true);
      expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
        provider: "contention_fixture", status: "running",
      }));
      expect(app.database.abandonPrecisionProvider(active.claim!, "fixture complete")).toBe(true);
    } finally {
      mutableAdapter.createOverlayPrecisionProvider = originalProvider;
      await app.close();
    }
  });

  it("preserves a provider transition failure and does not claim the new version", async () => {
    const root = workspace();
    const app = new ContextMeshApp(root);
    const adapter = app.code.indexer.coordinator.adapter("go")!;
    const mutableAdapter = adapter as {
      createOverlayPrecisionProvider: NonNullable<typeof adapter.createOverlayPrecisionProvider>;
    };
    const originalProvider = mutableAdapter.createOverlayPrecisionProvider;
    let version = "1";
    let analyses = 0;
    mutableAdapter.createOverlayPrecisionProvider = () => ({
      id: "transition_failure_fixture", version, capability: "resolved",
      available: async () => ({ available: true }),
      analyze: async (_batch, baseGeneration) => {
        analyses += 1;
        return { language: "go", provider: "transition_failure_fixture", providerVersion: version,
          capability: "resolved", baseGeneration, edges: [], eligibleEdges: 0, diagnostics: [] };
      },
    });
    try {
      await app.indexWorkspace({ mode: "full" });
      expect(analyses).toBe(1);
      version = "2";
      const originalTransition = app.database.transitionPrecisionProvider.bind(app.database);
      const transitionSpy = vi.spyOn(app.database, "transitionPrecisionProvider").mockImplementation((input) => {
        if (input.provider === "transition_failure_fixture") throw new Error("injected transition failure");
        return originalTransition(input);
      });
      const originalClaim = app.database.claimPrecisionProvider.bind(app.database);
      let newVersionClaims = 0;
      const claimSpy = vi.spyOn(app.database, "claimPrecisionProvider").mockImplementation((input) => {
        if (input.provider === "transition_failure_fixture" && input.providerVersion === "2") newVersionClaims += 1;
        return originalClaim(input);
      });
      try {
        const indexed = await app.indexWorkspace({ mode: "incremental" }) as Envelope<{
          adapterStats: Array<{ language: string; status: string; providerVersions?: Record<string, string> }>;
        }>;
        expect(indexed.warnings).toContainEqual(expect.stringMatching(/PRECISION_PROVIDER_STATE_FAILED.*injected transition failure/));
        expect(newVersionClaims).toBe(0);
        expect(analyses).toBe(1);
        expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
          provider: "transition_failure_fixture", providerVersion: "1", status: "ready",
        }));
        expect(indexed.data.adapterStats).toContainEqual(expect.objectContaining({
          language: "go", status: "ready", providerVersions: expect.objectContaining({ precision: "1" }),
        }));
      } finally {
        claimSpy.mockRestore();
        transitionSpy.mockRestore();
      }
    } finally {
      mutableAdapter.createOverlayPrecisionProvider = originalProvider;
      await app.close();
    }
  });

  it("rejects an overlay rejection without a current base candidate", async () => {
    const root = workspace();
    const priorDisable = process.env.CONTEXTMESH_GO_TYPES_DISABLE;
    process.env.CONTEXTMESH_GO_TYPES_DISABLE = "1";
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const nodes = app.database.getStoredGraphPartition("non-python").nodes.filter((node) =>
        node.language === "go" && (node.kind === "function" || node.kind === "method"));
      const target = nodes.find((node) => node.name === "Target");
      const caller = nodes.find((node) => node.name === "Caller");
      expect(target).toBeDefined();
      expect(caller).toBeDefined();
      const acquired = app.database.claimPrecisionProvider({
        provider: "orphan_rejection_provider",
        providerVersion: "1",
        language: "go",
        capability: "resolved",
        owner: "orphan-rejection-owner",
      });
      expect(acquired.reason).toBe("acquired");

      expect(app.database.commitPrecisionOverlay(acquired.claim!, { edges: [{
        sourceId: target!.id,
        targetId: caller!.id,
        kind: "CALLS",
        status: "rejected",
        confidence: 1,
        resolutionKind: "local",
        evidence: [{
          provider: "orphan_rejection_provider",
          providerVersion: "1",
          source: "type_checker",
          confidence: 1,
        }],
      }], eligibleEdges: 1, diagnostics: [] })).toBe(false);
      expect(app.database.getStoredGraphPartition("non-python").edges).not.toContainEqual(expect.objectContaining({
        sourceId: target!.id,
        targetId: caller!.id,
        kind: "CALLS",
        status: "rejected",
      }));
    } finally {
      if (priorDisable === undefined) delete process.env.CONTEXTMESH_GO_TYPES_DISABLE;
      else process.env.CONTEXTMESH_GO_TYPES_DISABLE = priorDisable;
      await app.close();
    }
  });

  it("atomically rejects precision edges outside the provider language or evidence contract", async () => {
    const root = workspace();
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "entry.ts"), "export function TsCaller(): number { return 1; }\n");
    writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
    const priorDisable = process.env.CONTEXTMESH_GO_TYPES_DISABLE;
    process.env.CONTEXTMESH_GO_TYPES_DISABLE = "1";
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const nodes = app.database.getStoredGraphPartition("non-python").nodes;
      const tsCaller = nodes.find((node) => node.language === "typescript" && node.name === "TsCaller");
      const goCaller = nodes.find((node) => node.language === "go" && node.name === "Caller");
      const goTarget = nodes.find((node) => node.language === "go" && node.name === "Target");
      expect(tsCaller).toBeDefined();
      expect(goCaller).toBeDefined();
      expect(goTarget).toBeDefined();
      const revision = app.database.getPrecisionRevision();
      const claim = (provider: string) => {
        const acquired = app.database.claimPrecisionProvider({
          provider,
          providerVersion: "1",
          language: "go",
          capability: "resolved",
          owner: `${provider}-owner`,
        });
        expect(acquired.reason).toBe("acquired");
        return acquired.claim!;
      };
      const evidence = (provider: string, providerVersion = "1"): CodeEvidence[] => [{
        provider,
        providerVersion,
        source: "type_checker",
        confidence: 1,
      }];
      const edge = (sourceId: string, targetId: string, edgeEvidence: CodeEvidence[]) => ({
        sourceId,
        targetId,
        kind: "CALLS" as const,
        status: "resolved" as const,
        confidence: 1,
        resolutionKind: "local" as const,
        evidence: edgeEvidence,
      });

      const crossProvider = "go_cross_language_probe";
      expect(app.database.commitPrecisionOverlay(claim(crossProvider), {
        edges: [edge(tsCaller!.id, goTarget!.id, evidence(crossProvider))],
        eligibleEdges: 1,
        diagnostics: [],
      })).toBe(false);
      expect(app.database.getPrecisionRevision()).toBe(revision);
      expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
        provider: crossProvider,
        status: "failed",
        lastError: expect.stringMatching(/provider language/i),
      }));

      const emptyEvidenceProvider = "go_empty_evidence_probe";
      expect(app.database.commitPrecisionOverlay(claim(emptyEvidenceProvider), {
        edges: [edge(goCaller!.id, goTarget!.id, [])],
        eligibleEdges: 1,
        diagnostics: [],
      })).toBe(false);
      expect(app.database.getPrecisionRevision()).toBe(revision);
      expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
        provider: emptyEvidenceProvider,
        status: "failed",
        lastError: expect.stringMatching(/evidence/i),
      }));

      const mismatchProvider = "go_mismatched_evidence_probe";
      expect(app.database.commitPrecisionOverlay(claim(mismatchProvider), {
        edges: [edge(goCaller!.id, goTarget!.id, evidence(mismatchProvider, "wrong-version"))],
        eligibleEdges: 1,
        diagnostics: [],
      })).toBe(false);
      expect(app.database.getPrecisionRevision()).toBe(revision);

      const validProvider = "go_valid_evidence_probe";
      expect(app.database.commitPrecisionOverlay(claim(validProvider), {
        edges: [edge(goCaller!.id, goTarget!.id, evidence(validProvider))],
        eligibleEdges: 1,
        diagnostics: [],
      })).toBe(true);
      expect(app.database.getPrecisionRevision()).toBe(revision + 1);
    } finally {
      if (priorDisable === undefined) delete process.env.CONTEXTMESH_GO_TYPES_DISABLE;
      else process.env.CONTEXTMESH_GO_TYPES_DISABLE = priorDisable;
      await app.close();
    }
  });

  it("reports the graph snapshot captured by the final read attempt", async () => {
    const root = workspace();
    const app = new ContextMeshApp(root);
    const originalFinalRead = app.code.indexer.readFinalRequestState.bind(app.code.indexer);
    let raw: DatabaseSync | null = null;
    try {
      await app.indexWorkspace({ mode: "full" });
      raw = new DatabaseSync(app.database.dbPath);
      const capturedRevisions: number[] = [];
      app.code.indexer.readFinalRequestState = async () => {
        const capturedRevision = app.database.getFreshnessState().precisionRevision;
        capturedRevisions.push(capturedRevision);
        raw!.prepare(
          "UPDATE workspaces SET precision_revision=precision_revision+1 WHERE id=?",
        ).run(app.database.workspace.id);
        return originalFinalRead();
      };

      const response = await app.searchCode({ query: "caller" });

      expect(capturedRevisions).toHaveLength(2);
      expect(response.warnings).toContainEqual(expect.stringContaining("INDEX_STALE"));
      expect(response.snapshot?.precisionRevision).toBe(capturedRevisions.at(-1));
    } finally {
      app.code.indexer.readFinalRequestState = originalFinalRead;
      raw?.close();
      await app.close();
    }
  });

  it("replaces and deletes Go symbols during a mixed TypeScript incremental index", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v05-mixed-incremental-"));
    roots.push(root);
    writeFileSync(path.join(root, "entry.ts"), "export function TypeScriptAnchor() { return 1; }\n");
    writeFileSync(path.join(root, "go.mod"), "module example.local/incremental\n\ngo 1.23\n");
    const goFile = path.join(root, "worker.go");
    writeFileSync(goFile, "package incremental\nfunc OldName() int { return 1 }\n");
    const priorDisable = process.env.CONTEXTMESH_GO_TYPES_DISABLE;
    process.env.CONTEXTMESH_GO_TYPES_DISABLE = "1";
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      expect((await app.searchCode({ query: "OldName" }) as Envelope<{ results: unknown[] }>).data.results).toHaveLength(1);

      writeFileSync(goFile, "package incremental\nfunc NewName() int { return 2 }\n");
      await app.indexWorkspace({ mode: "incremental" });
      expect((await app.searchCode({ query: "OldName" }) as Envelope<{ results: unknown[] }>).data.results).toHaveLength(0);
      expect((await app.searchCode({ query: "NewName" }) as Envelope<{ results: unknown[] }>).data.results).toHaveLength(1);

      rmSync(goFile);
      await app.indexWorkspace({ mode: "incremental" });
      expect((await app.searchCode({ query: "NewName" }) as Envelope<{ results: unknown[] }>).data.results).toHaveLength(0);
      expect((await app.searchCode({ query: "TypeScriptAnchor" }) as Envelope<{ results: unknown[] }>).data.results).toHaveLength(1);
    } finally {
      if (priorDisable === undefined) delete process.env.CONTEXTMESH_GO_TYPES_DISABLE;
      else process.env.CONTEXTMESH_GO_TYPES_DISABLE = priorDisable;
      await app.close();
    }
  });

  it("does not reparse unchanged core languages during a TypeScript-only incremental index", async () => {
    const root = workspace();
    const typescriptFile = path.join(root, "entry.ts");
    writeFileSync(typescriptFile, "export function Before() { return 1; }\n");
    const priorDisable = process.env.CONTEXTMESH_GO_TYPES_DISABLE;
    process.env.CONTEXTMESH_GO_TYPES_DISABLE = "1";
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      writeFileSync(typescriptFile, "export function After() { return 2; }\n");
      const indexed = await app.indexWorkspace({ mode: "incremental" }) as Envelope<{
        adapterStats: Array<{ language: string; syntaxInvocations: number; filesReparsed?: number }>;
      }>;
      for (const language of ["go", "rust", "java", "csharp"]) {
        expect(indexed.data.adapterStats).toContainEqual(expect.objectContaining({
          language,
          syntaxInvocations: 0,
          filesReparsed: 0,
        }));
      }
      const go = await app.searchCode({ query: "Target" }) as Envelope<{ results: Array<{ language: string }> }>;
      const rust = await app.searchCode({ query: "rust_target" }) as Envelope<{ results: Array<{ language: string }> }>;
      expect(go.data.results.some((item) => item.language === "go")).toBe(true);
      expect(rust.data.results.some((item) => item.language === "rust")).toBe(true);
    } finally {
      if (priorDisable === undefined) delete process.env.CONTEXTMESH_GO_TYPES_DISABLE;
      else process.env.CONTEXTMESH_GO_TYPES_DISABLE = priorDisable;
      await app.close();
    }
  });

  it("commits the TypeScript syntax graph when precision analysis fails", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v05-typescript-base-"));
    roots.push(root);
    writeFileSync(path.join(root, "entry.ts"), [
      "export function SyntaxTarget() { return 1; }",
      "export function SyntaxCaller() { return SyntaxTarget(); }",
      "",
    ].join("\n"));
    const app = new ContextMeshApp(root);
    const adapter = app.code.indexer.coordinator.adapter("typescript/javascript")!;
    const mutableAdapter = adapter as {
      createPrecisionProvider: NonNullable<typeof adapter.createPrecisionProvider>;
    };
    const originalPrecisionProvider = mutableAdapter.createPrecisionProvider;
    mutableAdapter.createPrecisionProvider = () => ({
      id: "typescript_type_checker",
      version: "failing-fixture",
      refine: async () => { throw new Error("AUDIT_TYPECHECKER_UNAVAILABLE"); },
    });
    try {
      const indexed = await app.indexWorkspace({ mode: "full" }) as Envelope<{
        adapterStats: Array<{ language: string; analysisLevel: string; status: string; coverage: number }>;
      }>;
      expect(indexed.generation).toBe(1);
      expect((await app.searchCode({ query: "SyntaxCaller", kinds: ["function"] }) as Envelope<{ results: unknown[] }>).data.results).toHaveLength(1);
      expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
        provider: "typescript_type_checker",
        status: "failed",
        lastError: "AUDIT_TYPECHECKER_UNAVAILABLE",
      }));
      expect(indexed.data.adapterStats).toContainEqual(expect.objectContaining({
        language: "typescript/javascript", analysisLevel: "syntax", status: "failed", coverage: 0,
      }));
      const status = await app.workspaceStatus() as Envelope<{
        adapterStats: Array<{ language: string; analysisLevel: string; status: string; coverage: number }>;
      }>;
      expect(status.data.adapterStats).toContainEqual(expect.objectContaining({
        language: "typescript/javascript", analysisLevel: "syntax", status: "failed", coverage: 0,
      }));
    } finally {
      mutableAdapter.createPrecisionProvider = originalPrecisionProvider;
      await app.close();
    }
  });

  it("reports both TypeScript claim and state-recording failures while preserving the base graph", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v05-typescript-claim-state-"));
    roots.push(root);
    writeFileSync(path.join(root, "entry.ts"), "export function BaseSurvivesClaimFailure() { return 1; }\n");
    const app = new ContextMeshApp(root);
    const originalClaim = app.database.claimPrecisionProvider.bind(app.database);
    const claimSpy = vi.spyOn(app.database, "claimPrecisionProvider").mockImplementation((input) => {
      if (input.provider === "typescript_type_checker") throw new Error("injected TypeScript claim failure");
      return originalClaim(input);
    });
    const originalTransition = app.database.transitionPrecisionProvider.bind(app.database);
    const transitionSpy = vi.spyOn(app.database, "transitionPrecisionProvider").mockImplementation((input) => {
      if (input.provider === "typescript_type_checker") throw new Error("injected TypeScript state failure");
      return originalTransition(input);
    });
    try {
      const indexed = await app.indexWorkspace({ mode: "full" }) as Envelope<{
        adapterStats: Array<{ language: string; analysisLevel: string; status: string; coverage: number }>;
      }>;
      expect(indexed.generation).toBe(1);
      expect(indexed.warnings).toContainEqual(expect.stringMatching(
        /PRECISION_PROVIDER_CLAIM_FAILED.*injected TypeScript claim failure/,
      ));
      expect(indexed.warnings).toContainEqual(expect.stringMatching(
        /PRECISION_PROVIDER_STATE_FAILED.*injected TypeScript state failure/,
      ));
      expect((await app.searchCode({ query: "BaseSurvivesClaimFailure", kinds: ["function"] }) as Envelope<{
        results: unknown[];
      }>).data.results).toHaveLength(1);
      expect(indexed.data.adapterStats).toContainEqual(expect.objectContaining({
        language: "typescript/javascript", analysisLevel: "syntax", status: "stale", coverage: 0,
      }));
    } finally {
      transitionSpy.mockRestore();
      claimSpy.mockRestore();
      await app.close();
    }
  });

  it("keeps a full TypeScript base index when recording the disabled precision state fails", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v05-typescript-disabled-state-"));
    roots.push(root);
    writeFileSync(path.join(root, "entry.ts"), "export function BaseSurvivesStateFailure() { return 1; }\n");
    const priorDisable = process.env.CONTEXTMESH_TYPESCRIPT_PRECISION_DISABLE;
    process.env.CONTEXTMESH_TYPESCRIPT_PRECISION_DISABLE = "1";
    const app = new ContextMeshApp(root);
    const originalTransition = app.database.transitionPrecisionProvider.bind(app.database);
    const transitionSpy = vi.spyOn(app.database, "transitionPrecisionProvider").mockImplementation((input) => {
      if (input.provider === "typescript_type_checker") throw new Error("injected disabled-state failure");
      return originalTransition(input);
    });
    try {
      const indexed = await app.indexWorkspace({ mode: "full" }) as Envelope<{
        adapterStats: Array<{ language: string; analysisLevel: string; status: string; coverage: number }>;
      }>;
      expect(indexed.generation).toBe(1);
      expect(indexed.warnings).toContainEqual(expect.stringMatching(
        /PRECISION_PROVIDER_STATE_FAILED.*injected disabled-state failure/,
      ));
      expect((await app.searchCode({ query: "BaseSurvivesStateFailure", kinds: ["function"] }) as Envelope<{
        results: unknown[];
      }>).data.results).toHaveLength(1);
      expect(indexed.data.adapterStats).toContainEqual(expect.objectContaining({
        language: "typescript/javascript", analysisLevel: "syntax", status: "stale", coverage: 0,
      }));
    } finally {
      transitionSpy.mockRestore();
      if (priorDisable === undefined) delete process.env.CONTEXTMESH_TYPESCRIPT_PRECISION_DISABLE;
      else process.env.CONTEXTMESH_TYPESCRIPT_PRECISION_DISABLE = priorDisable;
      await app.close();
    }
  });

  it("withdraws a ready TypeScript overlay when precision is disabled on a no-op run", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v05-typescript-disabled-"));
    roots.push(root);
    writeFileSync(path.join(root, "entry.ts"), "/** Typed-only documentation. */\nexport function DisabledLater() { return 1; }\n");
    const priorDisable = process.env.CONTEXTMESH_TYPESCRIPT_PRECISION_DISABLE;
    delete process.env.CONTEXTMESH_TYPESCRIPT_PRECISION_DISABLE;
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const readyRevision = app.database.getPrecisionRevision();
      expect(app.database.searchCode("DisabledLater", ["function"], 1)[0]).toMatchObject({
        analysisLevel: "typed",
        doc: expect.stringContaining("Typed-only documentation"),
      });

      process.env.CONTEXTMESH_TYPESCRIPT_PRECISION_DISABLE = "1";
      const noOp = await app.indexWorkspace({ mode: "incremental" }) as Envelope<{
        noOp: boolean;
        adapterStats: Array<{ language: string; analysisLevel: string; status: string; coverage: number }>;
      }>;
      expect(noOp.data.noOp).toBe(true);
      expect(noOp.snapshot!.precisionRevision).toBe(readyRevision + 1);
      expect(app.database.searchCode("DisabledLater", ["function"], 1)[0]).toMatchObject({
        analysisLevel: "syntax",
        doc: "",
      });
      expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
        provider: "typescript_type_checker",
        status: "not_configured",
        lastError: expect.stringMatching(/disabled/i),
      }));
      expect(noOp.data.adapterStats).toContainEqual(expect.objectContaining({
        language: "typescript/javascript", analysisLevel: "syntax", status: "not_configured", coverage: 0,
      }));
      let status = await app.workspaceStatus() as Envelope<{
        adapterStats: Array<{ language: string; analysisLevel: string; status: string; coverage: number }>;
      }>;
      expect(status.data.adapterStats).toContainEqual(expect.objectContaining({
        language: "typescript/javascript", analysisLevel: "syntax", status: "not_configured", coverage: 0,
      }));

      delete process.env.CONTEXTMESH_TYPESCRIPT_PRECISION_DISABLE;
      const reenabled = await app.indexWorkspace({ mode: "incremental" }) as Envelope<{
        noOp: boolean;
        adapterStats: Array<{ language: string; analysisLevel: string; status: string; coverage: number }>;
      }>;
      expect(reenabled.data.noOp).toBe(true);
      expect(reenabled.data.adapterStats).toContainEqual(expect.objectContaining({
        language: "typescript/javascript", analysisLevel: "typed", status: "ready", coverage: 1,
      }));
      expect(app.database.searchCode("DisabledLater", ["function"], 1)[0]).toMatchObject({
        analysisLevel: "typed", doc: expect.stringContaining("Typed-only documentation"),
      });
      status = await app.workspaceStatus() as Envelope<{
        adapterStats: Array<{ language: string; analysisLevel: string; status: string; coverage: number }>;
      }>;
      expect(status.data.adapterStats).toContainEqual(expect.objectContaining({
        language: "typescript/javascript", analysisLevel: "typed", status: "ready", coverage: 1,
      }));
    } finally {
      if (priorDisable === undefined) delete process.env.CONTEXTMESH_TYPESCRIPT_PRECISION_DISABLE;
      else process.env.CONTEXTMESH_TYPESCRIPT_PRECISION_DISABLE = priorDisable;
      await app.close();
    }
  });

  it("does not resolve a nested Python function outside its lexical scope", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "python", "pkg", "scope.py"), [
      "def outer():",
      "    def hidden():",
      "        return 1",
      "    return hidden()",
      "",
      "def scopeCaller():",
      "    return hidden()",
      "",
    ].join("\n"));
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const caller = await app.searchCode({ query: "scopeCaller", kinds: ["function"] }) as Envelope<{
        results: Array<{ id: string }>;
      }>;
      const hidden = await app.searchCode({ query: "hidden", kinds: ["function"] }) as Envelope<{
        results: Array<{ id: string }>;
      }>;
      expect(caller.data.results).toHaveLength(1);
      expect(hidden.data.results).toHaveLength(1);
      const trace = await app.traceCode({
        symbolId: caller.data.results[0]!.id,
        direction: "out",
        edgeKinds: ["CALLS"],
        depth: 1,
      }) as Envelope<{ edges: Array<{ targetId: string; status: string }> }>;
      expect(trace.data.edges).not.toContainEqual(expect.objectContaining({
        targetId: hidden.data.results[0]!.id,
        status: "resolved",
      }));
    } finally { await app.close(); }
  });

  it("requires visible Python bindings for inheritance and calls", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "python", "pkg", "unimported.py"), [
      "class UnimportedChild(Base):",
      "    pass",
      "",
    ].join("\n"));
    writeFileSync(path.join(root, "python", "pkg", "bindings.py"), [
      "from pkg.target import selected",
      "import pkg.target",
      "",
      "def shadowed(selected):",
      "    return selected()",
      "",
      "def dotted():",
      "    return pkg.target.selected()",
      "",
    ].join("\n"));
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const resultId = async (query: string, kind: "class" | "function"): Promise<string> => {
        const result = await app.searchCode({ query, kinds: [kind], limit: 20 }) as Envelope<{
          results: Array<{ id: string; name: string; language: string }>;
        }>;
        const exact = result.data.results.filter((item) => item.name === query && item.language === "python");
        expect(exact).toHaveLength(1);
        return exact[0]!.id;
      };
      const baseId = await resultId("Base", "class");
      const selectedId = await resultId("selected", "function");

      const inheritance = await app.traceCode({
        symbolId: await resultId("UnimportedChild", "class"),
        direction: "out",
        edgeKinds: ["EXTENDS"],
        depth: 1,
      }) as Envelope<{ edges: Array<{ targetId: string; status: string }> }>;
      expect(inheritance.data.edges).not.toContainEqual(expect.objectContaining({
        targetId: baseId,
        status: "resolved",
      }));

      const shadowed = await app.traceCode({
        symbolId: await resultId("shadowed", "function"),
        direction: "out",
        edgeKinds: ["CALLS"],
        depth: 1,
      }) as Envelope<{ edges: Array<{ targetId: string; status: string }> }>;
      expect(shadowed.data.edges).not.toContainEqual(expect.objectContaining({
        targetId: selectedId,
        status: "resolved",
      }));

      const dotted = await app.traceCode({
        symbolId: await resultId("dotted", "function"),
        direction: "out",
        edgeKinds: ["CALLS"],
        depth: 1,
      }) as Envelope<{ edges: Array<{ targetId: string; status: string }> }>;
      expect(dotted.data.edges).toContainEqual(expect.objectContaining({
        targetId: selectedId,
        status: "resolved",
      }));
    } finally { await app.close(); }
  });

  it("resolves self-dispatched methods and an imported function shadowed only by the owner method name", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "python", "pkg", "method_bindings.py"), [
      "from pkg.target import selected",
      "",
      "class Loader:",
      "    def dispatch(self):",
      "        self.fast()",
      "        return self.explained()",
      "",
      "    def fast(self):",
      "        return 1",
      "",
      "    def explained(self):",
      "        return 2",
      "",
      "class Serializer:",
      "    def selected(self):",
      "        return selected()",
      "",
    ].join("\n"));
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const graph = app.database.getStoredGraphPartition("python");
      const node = (qualifiedName: string) => graph.nodes.find((item) => item.qualifiedName === qualifiedName);
      const dispatch = node("python/pkg/method_bindings.py#Loader.dispatch");
      const fast = node("python/pkg/method_bindings.py#Loader.fast");
      const explained = node("python/pkg/method_bindings.py#Loader.explained");
      const serializer = node("python/pkg/method_bindings.py#Serializer.selected");
      const imported = node("python/pkg/target.py#selected");
      expect(dispatch).toBeDefined();
      expect(fast).toBeDefined();
      expect(explained).toBeDefined();
      expect(serializer).toBeDefined();
      expect(imported).toBeDefined();
      expect(graph.edges).toContainEqual(expect.objectContaining({
        sourceId: dispatch!.id, targetId: fast!.id, kind: "CALLS", status: "resolved",
      }));
      expect(graph.edges).toContainEqual(expect.objectContaining({
        sourceId: dispatch!.id, targetId: explained!.id, kind: "CALLS", status: "resolved",
      }));
      expect(graph.edges).toContainEqual(expect.objectContaining({
        sourceId: serializer!.id, targetId: imported!.id, kind: "CALLS", status: "resolved",
      }));
    } finally { await app.close(); }
  });

  it("prefers a nested Python binding over an imported symbol with the same name", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "python", "pkg", "nested_binding.py"), [
      "from pkg.target import selected",
      "",
      "def shadowed_by_nested():",
      "    def selected():",
      "        return 2",
      "    return selected()",
      "",
    ].join("\n"));
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const graph = app.database.getStoredGraphPartition("python");
      const caller = graph.nodes.find((node) => node.qualifiedName === "python/pkg/nested_binding.py#shadowed_by_nested");
      const nested = graph.nodes.find((node) => node.qualifiedName === "python/pkg/nested_binding.py#shadowed_by_nested.selected");
      const imported = graph.nodes.find((node) => node.qualifiedName === "python/pkg/target.py#selected");
      expect(caller).toBeDefined();
      expect(nested).toBeDefined();
      expect(imported).toBeDefined();
      const resolved = graph.edges.filter((edge) => edge.sourceId === caller!.id && edge.kind === "CALLS" && edge.status === "resolved");
      expect(resolved).toContainEqual(expect.objectContaining({ targetId: nested!.id }));
      expect(resolved).not.toContainEqual(expect.objectContaining({ targetId: imported!.id }));
    } finally { await app.close(); }
  });

  it("does not reject an unrelated Python candidate when another call in the same function resolves", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "python", "pkg", "multi_call.py"), [
      "from pkg.target import selected as chosen",
      "",
      "def outer():",
      "    def hidden():",
      "        return 1",
      "    return hidden()",
      "",
      "def mixed_caller():",
      "    chosen()",
      "    return hidden()",
      "",
    ].join("\n"));
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const graph = app.database.getStoredGraphPartition("python");
      const caller = graph.nodes.find((node) => node.qualifiedName === "python/pkg/multi_call.py#mixed_caller");
      const imported = graph.nodes.find((node) => node.qualifiedName === "python/pkg/target.py#selected");
      const hidden = graph.nodes.find((node) => node.qualifiedName === "python/pkg/multi_call.py#outer.hidden");
      expect(caller).toBeDefined();
      expect(imported).toBeDefined();
      expect(hidden).toBeDefined();
      expect(graph.edges).toContainEqual(expect.objectContaining({
        sourceId: caller!.id, targetId: imported!.id, kind: "CALLS", status: "resolved",
      }));
      expect(graph.edges).toContainEqual(expect.objectContaining({
        sourceId: caller!.id, targetId: hidden!.id, kind: "CALLS", status: "candidate",
      }));
      expect(graph.edges).not.toContainEqual(expect.objectContaining({
        sourceId: caller!.id, targetId: hidden!.id, kind: "CALLS", status: "rejected",
      }));
    } finally { await app.close(); }
  });

  it("resolves qualified Python calls and inheritance through a from-package submodule import", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "python", "pkg", "__init__.py"), "");
    writeFileSync(path.join(root, "python", "pkg", "submodule_binding.py"), [
      "from pkg import target",
      "",
      "class ViaSubmoduleBase(target.Base):",
      "    pass",
      "",
      "def via_submodule():",
      "    return target.selected()",
      "",
    ].join("\n"));
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const graph = app.database.getStoredGraphPartition("python");
      const node = (qualifiedName: string) => graph.nodes.find((item) => item.qualifiedName === qualifiedName);
      const caller = node("python/pkg/submodule_binding.py#via_submodule");
      const child = node("python/pkg/submodule_binding.py#ViaSubmoduleBase");
      const selected = node("python/pkg/target.py#selected");
      const base = node("python/pkg/target.py#Base");
      expect(caller).toBeDefined();
      expect(child).toBeDefined();
      expect(selected).toBeDefined();
      expect(base).toBeDefined();
      expect(graph.edges).toContainEqual(expect.objectContaining({
        sourceId: caller!.id, targetId: selected!.id, kind: "CALLS", status: "resolved",
      }));
      expect(graph.edges).toContainEqual(expect.objectContaining({
        sourceId: child!.id, targetId: base!.id, kind: "EXTENDS", status: "resolved",
      }));
    } finally { await app.close(); }
  });

  it("resolves parenthesized Python from-imports without counting the import as a call", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "python", "pkg", "parenthesized.py"), [
      "from pkg.target import (",
      "    selected,",
      ")",
      "",
      "def invoke_parenthesized():",
      "    return selected()",
      "",
    ].join("\n"));
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const graph = app.database.getStoredGraphPartition("python");
      const caller = graph.nodes.find((node) => node.qualifiedName === "python/pkg/parenthesized.py#invoke_parenthesized");
      const target = graph.nodes.find((node) => node.qualifiedName === "python/pkg/target.py#selected");
      expect(caller).toBeDefined();
      expect(target).toBeDefined();
      expect(graph.edges).toContainEqual(expect.objectContaining({
        sourceId: caller!.id,
        targetId: target!.id,
        kind: "CALLS",
        status: "resolved",
        evidence: expect.arrayContaining([expect.objectContaining({ provider: "contextmesh_python_resolver" })]),
      }));
      expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
        provider: "contextmesh_python_resolver",
        eligibleEdges: 3,
      }));
    } finally { await app.close(); }
  });

  it("resolves relative aliases and bounded local Python re-exports", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "python", "pkg", "relative.py"), [
      "from .target import Base as Parent",
      "from .target import selected as chosen",
      "",
      "class RelativeChild(Parent):",
      "    pass",
      "",
      "def relativeCaller():",
      "    return chosen()",
      "",
    ].join("\n"));
    writeFileSync(path.join(root, "python", "pkg", "api.py"), "from pkg.target import selected as exported\n");
    writeFileSync(path.join(root, "python", "pkg", "reexport_caller.py"), [
      "from pkg.api import exported as through_api",
      "",
      "def reexportCaller():",
      "    return through_api()",
      "",
    ].join("\n"));
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const selected = await app.searchCode({ query: "selected", kinds: ["function"] }) as Envelope<{
        results: Array<{ id: string }>;
      }>;
      const base = await app.searchCode({ query: "Base", kinds: ["class"] }) as Envelope<{
        results: Array<{ id: string }>;
      }>;
      expect(selected.data.results).toHaveLength(1);
      expect(base.data.results).toHaveLength(1);

      for (const callerName of ["relativeCaller", "reexportCaller"]) {
        const caller = await app.searchCode({ query: callerName, kinds: ["function"] }) as Envelope<{
          results: Array<{ id: string }>;
        }>;
        const trace = await app.traceCode({
          symbolId: caller.data.results[0]!.id,
          direction: "out",
          edgeKinds: ["CALLS"],
          depth: 1,
        }) as Envelope<{ edges: Array<{ targetId: string; status: string }> }>;
        expect(trace.data.edges).toContainEqual(expect.objectContaining({
          targetId: selected.data.results[0]!.id,
          status: "resolved",
        }));
      }

      const child = await app.searchCode({ query: "RelativeChild", kinds: ["class"] }) as Envelope<{
        results: Array<{ id: string }>;
      }>;
      const inheritance = await app.traceCode({
        symbolId: child.data.results[0]!.id,
        direction: "out",
        edgeKinds: ["EXTENDS"],
        depth: 1,
      }) as Envelope<{ edges: Array<{ targetId: string; status: string }> }>;
      expect(inheritance.data.edges).toContainEqual(expect.objectContaining({
        targetId: base.data.results[0]!.id,
        status: "resolved",
      }));
    } finally { await app.close(); }
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

  it("reports a balanced Rust syntax error as a partial parse", async () => {
    const root = workspace();
    writeFileSync(
      path.join(root, "rust", "src", "balanced-error.rs"),
      "pub fn balanced_error() { let = 1; }\n",
    );
    const app = new ContextMeshApp(root);
    let raw: DatabaseSync | null = null;
    try {
      const indexed = await app.indexWorkspace({ mode: "full" }) as Envelope<{ diagnostics: string[] }>;
      raw = new DatabaseSync(app.database.dbPath);
      const file = raw.prepare(
        "SELECT parse_status FROM source_files WHERE workspace_id=? AND relative_path=?",
      ).get(app.database.workspace.id, "rust/src/balanced-error.rs") as { parse_status: string } | undefined;
      expect(file?.parse_status).toBe("partial");
      expect(indexed.data.diagnostics).toContainEqual(expect.stringContaining("PROVIDER_PARSE_PARTIAL"));
      const recovered = await app.searchCode({ query: "balanced_error", kinds: ["function"] }) as Envelope<{
        results: Array<{ language: string }>;
      }>;
      expect(recovered.data.results).toContainEqual(expect.objectContaining({ language: "rust" }));
    } finally {
      raw?.close();
      await app.close();
    }
  });

  it("uses a real Go parser for balanced syntax errors and recovers only valid declarations", async () => {
    const root = workspace();
    writeFileSync(
      path.join(root, "go", "worker", "balanced-error.go"),
      "package worker\nfunc RecoverableGo() int { return 1 }\nfunc BalancedBroken(a int,, b int) {}\n",
    );
    const priorDisable = process.env.CONTEXTMESH_GO_TYPES_DISABLE;
    process.env.CONTEXTMESH_GO_TYPES_DISABLE = "1";
    const app = new ContextMeshApp(root);
    let raw: DatabaseSync | null = null;
    try {
      const indexed = await app.indexWorkspace({ mode: "full" }) as Envelope<{ diagnostics: string[] }>;
      raw = new DatabaseSync(app.database.dbPath);
      const file = raw.prepare(
        "SELECT parse_status FROM source_files WHERE workspace_id=? AND relative_path=?",
      ).get(app.database.workspace.id, "go/worker/balanced-error.go") as { parse_status: string } | undefined;
      expect(file?.parse_status).toBe("partial");
      expect(indexed.data.diagnostics).toContainEqual(expect.stringContaining("PROVIDER_PARSE_PARTIAL"));
      expect((await app.searchCode({ query: "RecoverableGo", kinds: ["function"] }) as Envelope<{ results: unknown[] }>).data.results).toHaveLength(1);
      expect((await app.searchCode({ query: "BalancedBroken", kinds: ["function"] }) as Envelope<{ results: unknown[] }>).data.results).toHaveLength(0);
    } finally {
      raw?.close();
      if (priorDisable === undefined) delete process.env.CONTEXTMESH_GO_TYPES_DISABLE;
      else process.env.CONTEXTMESH_GO_TYPES_DISABLE = priorDisable;
      await app.close();
    }
  });

  it("limits the Go precision provider to scanner-approved files", async () => {
    const root = workspace();
    writeFileSync(path.join(root, ".contextmeshignore"), "ignored.go\n");
    writeFileSync(path.join(root, "ignored.go"), "package ignored\nfunc ScannerBypass( {\n");
    const priorDisable = process.env.CONTEXTMESH_GO_TYPES_DISABLE;
    delete process.env.CONTEXTMESH_GO_TYPES_DISABLE;
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
        provider: "go_types",
        status: "ready",
        lastError: null,
      }));
      expect((await app.searchCode({ query: "ScannerBypass" }) as Envelope<{ results: unknown[] }>).data.results).toHaveLength(0);
    } finally {
      if (priorDisable === undefined) delete process.env.CONTEXTMESH_GO_TYPES_DISABLE;
      else process.env.CONTEXTMESH_GO_TYPES_DISABLE = priorDisable;
      await app.close();
    }
  });

  it("resolves duplicate Go methods by receiver type with honest coverage", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "go", "worker", "receiver.go"), [
      "package worker",
      "type A struct{}",
      "type B struct{}",
      "func (A) Run() int { return 1 }",
      "func (B) Run() int { return 2 }",
      "func CallA(value A) int { return value.Run() }",
      "",
    ].join("\n"));
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const nodes = app.database.getStoredGraphPartition("non-python").nodes.filter((node) => node.language === "go");
      const caller = nodes.find((node) => node.name === "CallA");
      const target = nodes.find((node) => node.name === "Run" && /\(A\)\s*Run/.test(node.signature));
      expect(caller).toBeDefined();
      expect(target).toBeDefined();
      const trace = await app.traceCode({
        symbolId: caller!.id,
        direction: "out",
        edgeKinds: ["CALLS"],
        depth: 1,
      }) as Envelope<{ edges: Array<{ targetId: string; status: string }> }>;
      expect(trace.data.edges).toContainEqual(expect.objectContaining({
        targetId: target!.id,
        status: "resolved",
      }));
      expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
        provider: "go_types",
        status: "ready",
        eligibleEdges: expect.any(Number),
        resolvedEdges: expect.any(Number),
        coverage: 1,
      }));
      const state = app.database.getPrecisionProviderStates().find((item) => item.provider === "go_types")!;
      expect(state.eligibleEdges).toBeGreaterThanOrEqual(1);
      expect(state.resolvedEdges).toBeGreaterThanOrEqual(1);
    } finally { await app.close(); }
  });

  it("analyzes scanner-approved Go test files", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "go", "worker", "worker_test.go"), [
      "package worker",
      "func TestCaller() int { return Target() }",
      "",
    ].join("\n"));
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const caller = await app.searchCode({ query: "TestCaller", kinds: ["function"] }) as Envelope<{
        results: Array<{ id: string }>;
      }>;
      const target = await app.searchCode({ query: "Target", kinds: ["function"], limit: 20 }) as Envelope<{
        results: Array<{ id: string; language: string }>;
      }>;
      const goTarget = target.data.results.find((item) => item.language === "go");
      expect(caller.data.results).toHaveLength(1);
      expect(goTarget).toBeDefined();
      const trace = await app.traceCode({
        symbolId: caller.data.results[0]!.id,
        direction: "out",
        edgeKinds: ["CALLS"],
        depth: 1,
      }) as Envelope<{ edges: Array<{ targetId: string; status: string }> }>;
      expect(trace.data.edges).toContainEqual(expect.objectContaining({
        targetId: goTarget!.id,
        status: "resolved",
      }));
    } finally { await app.close(); }
  });

  it("denies Go toolchain downloads and records the local toolchain version", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "go.mod"), "module example.local/contextmesh\n\ngo 1.23\ntoolchain go1.99.0\n");
    const prior = {
      GOTOOLCHAIN: process.env.GOTOOLCHAIN,
      GOPROXY: process.env.GOPROXY,
      GOSUMDB: process.env.GOSUMDB,
      GOENV: process.env.GOENV,
      CONTEXTMESH_GO_TYPES_DISABLE: process.env.CONTEXTMESH_GO_TYPES_DISABLE,
    };
    process.env.GOTOOLCHAIN = "auto";
    process.env.GOPROXY = "http://127.0.0.1:9";
    delete process.env.CONTEXTMESH_GO_TYPES_DISABLE;
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
        provider: "go_types",
        providerVersion: expect.stringMatching(/^go\/types-stdlib-v2\+go\d+\.\d+/),
        status: "ready",
        lastError: null,
      }));
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await app.close();
    }
  });

  it("probes a configured rust-analyzer instead of reporting it permanently unavailable", async () => {
    const root = workspace();
    const server = path.join(root, "rust-analyzer-probe.mjs");
    writeFileSync(server, "console.log('rust-analyzer 1.85.0 (4d91de4 2025-02-17)');\n");
    const priorCommand = process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND;
    const priorArgs = process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON;
    delete process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE;
    process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND = process.execPath;
    process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON = JSON.stringify([server]);
    const app = new ContextMeshApp(root);
    try {
      const adapter = app.code.indexer.coordinator.adapter("rust")!;
      const project = adapter.discoverProject(root);
      const provider = adapter.createOverlayPrecisionProvider?.(project);
      expect(provider).toBeDefined();
      await expect(provider!.available()).resolves.toMatchObject({ available: true });
    } finally {
      if (priorCommand === undefined) delete process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND;
      else process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND = priorCommand;
      if (priorArgs === undefined) delete process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON;
      else process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON = priorArgs;
      await app.close();
    }
  });

  it("rejects an invalid configured rust-analyzer for release provenance", async () => {
    const priorCommand = process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND;
    const priorArgs = process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON;
    delete process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE;
    process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND = path.join(os.tmpdir(), "definitely-missing-rust-analyzer");
    delete process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON;
    try {
      await expect(probeRustAnalyzerRuntime()).rejects.toThrow(/RUST_ANALYZER_(?:UNAVAILABLE|SPAWN_FAILED)|ENOENT/);
    } finally {
      if (priorCommand === undefined) delete process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND;
      else process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND = priorCommand;
      if (priorArgs === undefined) delete process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON;
      else process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON = priorArgs;
    }
  });

  it("records a missing rust-analyzer executable as not configured", async () => {
    const root = workspace();
    const prior = {
      command: process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND,
      args: process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON,
      go: process.env.CONTEXTMESH_GO_TYPES_DISABLE,
    };
    delete process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE;
    process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND = path.join(root, "missing-rust-analyzer");
    delete process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON;
    process.env.CONTEXTMESH_GO_TYPES_DISABLE = "1";
    const app = new ContextMeshApp(root);
    try {
      const indexed = await app.indexWorkspace({ mode: "full" }) as Envelope<{
        adapterStats: Array<{ language: string; analysisLevel: string; status: string; coverage: number }>;
      }>;
      expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
        provider: "rust_analyzer", status: "not_configured", lastError: expect.stringMatching(/ENOENT/),
      }));
      expect(indexed.data.adapterStats).toContainEqual(expect.objectContaining({
        language: "rust", analysisLevel: "syntax", status: "not_configured", coverage: 0,
      }));
    } finally {
      if (prior.command === undefined) delete process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND;
      else process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND = prior.command;
      if (prior.args === undefined) delete process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON;
      else process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON = prior.args;
      if (prior.go === undefined) delete process.env.CONTEXTMESH_GO_TYPES_DISABLE;
      else process.env.CONTEXTMESH_GO_TYPES_DISABLE = prior.go;
      await app.close();
    }
  });

  it("accepts the official seven-character rust-analyzer commit identity", async () => {
    const root = workspace();
    const server = path.join(root, "rust-analyzer-version.mjs");
    writeFileSync(server, "console.log('rust-analyzer 1.85.0 (4d91de4 2025-02-17)');\n");
    const priorCommand = process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND;
    const priorArgs = process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON;
    delete process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE;
    process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND = process.execPath;
    process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON = JSON.stringify([server]);
    try {
      await expect(probeRustAnalyzerRuntime()).resolves.toEqual({
        version: "rust-analyzer 1.85.0 (4d91de4 2025-02-17)",
      });
    } finally {
      if (priorCommand === undefined) delete process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND;
      else process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND = priorCommand;
      if (priorArgs === undefined) delete process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON;
      else process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON = priorArgs;
    }
  });

  it("records analyzer probe identity, exit, and timeout failures as failed", async () => {
    const prior = {
      disable: process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE,
      policy: process.env.CONTEXTMESH_RUST_ANALYZER_POLICY,
      command: process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND,
      args: process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON,
      go: process.env.CONTEXTMESH_GO_TYPES_DISABLE,
    };
    delete process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE;
    process.env.CONTEXTMESH_RUST_ANALYZER_POLICY = "safe";
    process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND = process.execPath;
    process.env.CONTEXTMESH_GO_TYPES_DISABLE = "1";
    try {
      for (const [mode, diagnostic] of [
        ["identity", /RUST_ANALYZER_IDENTITY_INVALID/],
        ["nonzero", /RUST_ANALYZER_UNAVAILABLE/],
        ["timeout", /RUST_ANALYZER_UNAVAILABLE/],
      ] as const) {
        const root = workspace();
        const server = path.join(root, `rust-analyzer-probe-${mode}.mjs`);
        writeFileSync(server, [
          "const mode = process.argv[2];",
          "if (!process.argv.includes('--version')) process.exit(2);",
          "if (mode === 'identity') { console.log('not rust-analyzer'); process.exit(0); }",
          "if (mode === 'nonzero') { console.error('probe rejected'); process.exit(3); }",
          "setTimeout(() => {}, 10_000);",
        ].join("\n"));
        process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON = JSON.stringify([server, mode]);
        const app = new ContextMeshApp(root);
        try {
          const indexed = await app.indexWorkspace({ mode: "full" }) as Envelope<{
            adapterStats: Array<{ language: string; analysisLevel: string; status: string; coverage: number }>;
          }>;
          expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
            provider: "rust_analyzer", status: "failed", lastError: expect.stringMatching(diagnostic),
          }));
          expect(indexed.data.adapterStats).toContainEqual(expect.objectContaining({
            language: "rust", analysisLevel: "syntax", status: "failed", coverage: 0,
          }));
        } finally { await app.close(); }
      }
    } finally {
      for (const [key, value] of Object.entries({
        CONTEXTMESH_RUST_ANALYZER_DISABLE: prior.disable,
        CONTEXTMESH_RUST_ANALYZER_POLICY: prior.policy,
        CONTEXTMESH_RUST_ANALYZER_COMMAND: prior.command,
        CONTEXTMESH_RUST_ANALYZER_ARGS_JSON: prior.args,
        CONTEXTMESH_GO_TYPES_DISABLE: prior.go,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 30_000);

  it("does not spawn rust-analyzer for disabled or invalid policies", async () => {
    const root = workspace();
    const marker = path.join(root, "probe-marker.txt");
    const server = path.join(root, "rust-analyzer-no-probe.mjs");
    writeFileSync(server, [
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(marker)}, 'spawned\\n');`,
      "console.log('rust-analyzer 1.85.0 (4d91de4 2025-02-17)');",
    ].join("\n"));
    const prior = {
      disable: process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE,
      policy: process.env.CONTEXTMESH_RUST_ANALYZER_POLICY,
      command: process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND,
      args: process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON,
    };
    process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND = process.execPath;
    process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON = JSON.stringify([server]);
    try {
      process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE = "1";
      await expect(probeRustAnalyzerRuntime()).rejects.toThrow(/RUST_ANALYZER_DISABLED/);
      expect(existsSync(marker)).toBe(false);

      delete process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE;
      process.env.CONTEXTMESH_RUST_ANALYZER_POLICY = "unexpected";
      await expect(probeRustAnalyzerRuntime()).rejects.toThrow(/RUST_ANALYZER_POLICY_INVALID/);
      expect(existsSync(marker)).toBe(false);

      process.env.CONTEXTMESH_RUST_ANALYZER_POLICY = "safe";
      process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON = "not-json";
      await expect(probeRustAnalyzerRuntime()).rejects.toThrow(/RUST_ANALYZER_POLICY_INVALID.*CONFIGURATION_INVALID/);
      expect(existsSync(marker)).toBe(false);
    } finally {
      for (const [key, value] of Object.entries({
        CONTEXTMESH_RUST_ANALYZER_DISABLE: prior.disable,
        CONTEXTMESH_RUST_ANALYZER_POLICY: prior.policy,
        CONTEXTMESH_RUST_ANALYZER_COMMAND: prior.command,
        CONTEXTMESH_RUST_ANALYZER_ARGS_JSON: prior.args,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("uses the safe configuration snapshot for server requests and reanalyzes when binary identity changes", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "rust", "src", "lib.rs"), [
      "/* 정의😀 */ pub fn rust_target() -> i32 { 1 }",
      "pub fn rust_caller() -> i32 { /* 호출한글😀 */ rust_target() }",
      "",
    ].join("\n"));
    const server = path.join(root, "rust-analyzer-policy.mjs");
    const identity = path.join(root, "identity.txt");
    const sessions = path.join(root, "sessions.txt");
    writeFileSync(identity, "rust-analyzer 1.85.0 (4d91de4 2025-02-17)\n");
    writeFileSync(server, [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      "const [identity, sessions] = process.argv.slice(2).filter((item) => item !== '--version');",
      "if (process.argv.includes('--version')) { process.stdout.write(readFileSync(identity, 'utf8')); process.exit(0); }",
      "appendFileSync(sessions, 'session\\n');",
      "let buffer = Buffer.alloc(0); let rootUri = ''; const documents = new Map();",
      "const safe = { cargo: { noDeps: true, autoreload: false, buildScripts: { enable: false } }, procMacro: { enable: false }, checkOnSave: false };",
      "function send(value) { const body = Buffer.from(JSON.stringify(value)); process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\\r\\n\\r\\n`), body])); }",
      "function fail(message) { send({ jsonrpc: '2.0', method: 'experimental/serverStatus', params: { health: 'error', quiescent: false, message } }); }",
      "function handle(message) {",
      "  if (message.id === 900 && message.method === undefined) { const r = message.result; if (!Array.isArray(r) || r.length !== 4 || JSON.stringify(r[0]) !== JSON.stringify(safe) || r[1] !== false || r[2] !== null || r[3] !== null) return fail('configuration response mismatch'); send({ jsonrpc: '2.0', id: 901, method: 'window/workDoneProgress/create', params: { token: 'fixture' } }); return; }",
      "  if (message.id === 901 && message.method === undefined) { if (message.result !== null) return fail('progress response mismatch'); send({ jsonrpc: '2.0', id: 902, method: 'fixture/unsupported', params: {} }); return; }",
      "  if (message.id === 902 && message.method === undefined) { if (message.error?.code !== -32601) return fail('MethodNotFound response missing'); send({ jsonrpc: '2.0', method: 'experimental/serverStatus', params: { health: 'ok', quiescent: true } }); return; }",
      "  if (message.method === 'initialized') { send({ jsonrpc: '2.0', id: 900, method: 'workspace/configuration', params: { items: [{ section: 'rust-analyzer', scopeUri: rootUri }, { section: 'rust-analyzer.cargo.buildScripts.enable', scopeUri: rootUri }, { section: 'rust-analyzer.unknown', scopeUri: rootUri }, { section: 'rust-analyzer', scopeUri: 'file:///definitely-outside' }] } }); return; }",
      "  if (message.method === 'textDocument/didOpen') { documents.set(message.params.textDocument.uri, message.params.textDocument.text); return; }",
      "  if (message.method === 'exit') process.exit(0);",
      "  if (message.id === undefined) return;",
      "  if (message.method === 'initialize') { rootUri = message.params.rootUri; const c = message.params.capabilities; if (JSON.stringify(message.params.initializationOptions) !== JSON.stringify(safe) || message.params.initializationOptions['rust-analyzer'] !== undefined || JSON.stringify(c.general?.positionEncodings) !== JSON.stringify(['utf-8','utf-16']) || c.workspace?.configuration !== true || c.workspace?.workspaceFolders !== true || c.window?.workDoneProgress !== true || process.env.CARGO_NET_OFFLINE !== 'true' || process.env.RUSTC_WRAPPER !== undefined || process.env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUNNER !== undefined || process.env.CARGO_BUILD_TARGET !== undefined || process.env.CARGO_BUILD_JOBS !== undefined || process.env.RUSTFLAGS !== undefined) return send({ jsonrpc: '2.0', id: message.id, error: { message: 'initialize contract mismatch' } }); return send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { definitionProvider: true, positionEncoding: 'utf-8' } } }); }",
      "  if (message.method === 'shutdown') return send({ jsonrpc: '2.0', id: message.id, result: null });",
      "  if (message.method === 'textDocument/definition') { const text = documents.get(message.params.textDocument.uri); const lines = text.split(/\\r?\\n/); const callLine = lines[message.params.position.line]; const expected = Buffer.byteLength(callLine.slice(0, callLine.indexOf('rust_target')), 'utf8'); if (message.params.position.character !== expected) return send({ jsonrpc: '2.0', id: message.id, error: { message: 'utf-8 query position mismatch' } }); const line = lines.findIndex((item) => item.includes('pub fn rust_target')); const character = Buffer.byteLength(lines[line].slice(0, lines[line].indexOf('rust_target')), 'utf8'); return send({ jsonrpc: '2.0', id: message.id, result: { targetUri: message.params.textDocument.uri, targetSelectionRange: { start: { line, character }, end: { line, character: character + Buffer.byteLength('rust_target', 'utf8') } } } }); }",
      "  send({ jsonrpc: '2.0', id: message.id, result: null });",
      "}",
      "process.stdin.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); while (true) { const end = buffer.indexOf('\\r\\n\\r\\n'); if (end < 0) break; const length = Number(buffer.subarray(0, end).toString().match(/Content-Length:\\s*(\\d+)/i)?.[1]); if (buffer.length < end + 4 + length) break; const body = buffer.subarray(end + 4, end + 4 + length).toString(); buffer = buffer.subarray(end + 4 + length); handle(JSON.parse(body)); } });",
    ].join("\n"));
    const prior = {
      disable: process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE,
      policy: process.env.CONTEXTMESH_RUST_ANALYZER_POLICY,
      command: process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND,
      args: process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON,
      go: process.env.CONTEXTMESH_GO_TYPES_DISABLE,
      rustcWrapper: process.env.RUSTC_WRAPPER,
      targetRunner: process.env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUNNER,
      cargoBuildTarget: process.env.CARGO_BUILD_TARGET,
      cargoBuildJobs: process.env.CARGO_BUILD_JOBS,
      rustflags: process.env.RUSTFLAGS,
    };
    delete process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE;
    process.env.CONTEXTMESH_RUST_ANALYZER_POLICY = "safe";
    process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND = process.execPath;
    process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON = JSON.stringify([server, identity, sessions]);
    process.env.CONTEXTMESH_GO_TYPES_DISABLE = "1";
    process.env.RUSTC_WRAPPER = "malicious-wrapper";
    process.env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUNNER = "malicious-runner";
    process.env.CARGO_BUILD_TARGET = "malicious-target";
    process.env.CARGO_BUILD_JOBS = "999";
    process.env.RUSTFLAGS = "-C linker=malicious-linker";
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const firstState = app.database.getPrecisionProviderStates().find((item) => item.provider === "rust_analyzer")!;
      expect(firstState).toMatchObject({ status: "ready", lastError: null });
      const caller = await app.searchCode({ query: "rust_caller", kinds: ["function"] }) as Envelope<{ results: Array<{ id: string }> }>;
      const target = await app.searchCode({ query: "rust_target", kinds: ["function"] }) as Envelope<{ results: Array<{ id: string }> }>;
      const trace = await app.traceCode({ symbolId: caller.data.results[0]!.id, direction: "out", edgeKinds: ["CALLS"], depth: 1 }) as Envelope<{
        edges: Array<{ targetId: string; status: string }>;
      }>;
      expect(trace.data.edges).toContainEqual(expect.objectContaining({ targetId: target.data.results[0]!.id, status: "resolved" }));
      expect(readFileSync(sessions, "utf8").trim().split(/\r?\n/)).toHaveLength(1);

      await app.indexWorkspace({ mode: "incremental" });
      expect(readFileSync(sessions, "utf8").trim().split(/\r?\n/)).toHaveLength(1);

      writeFileSync(identity, "rust-analyzer 1.86.0 (5e02ef5 2025-03-18)\n");
      await app.indexWorkspace({ mode: "incremental" });
      const secondState = app.database.getPrecisionProviderStates().find((item) => item.provider === "rust_analyzer")!;
      expect(secondState.providerVersion).not.toBe(firstState.providerVersion);
      expect(secondState.status).toBe("ready");
      expect(readFileSync(sessions, "utf8").trim().split(/\r?\n/)).toHaveLength(2);
    } finally {
      for (const [key, value] of Object.entries({
        CONTEXTMESH_RUST_ANALYZER_DISABLE: prior.disable,
        CONTEXTMESH_RUST_ANALYZER_POLICY: prior.policy,
        CONTEXTMESH_RUST_ANALYZER_COMMAND: prior.command,
        CONTEXTMESH_RUST_ANALYZER_ARGS_JSON: prior.args,
        CONTEXTMESH_GO_TYPES_DISABLE: prior.go,
        RUSTC_WRAPPER: prior.rustcWrapper,
        CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUNNER: prior.targetRunner,
        CARGO_BUILD_TARGET: prior.cargoBuildTarget,
        CARGO_BUILD_JOBS: prior.cargoBuildJobs,
        RUSTFLAGS: prior.rustflags,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await app.close();
    }
  });

  it("keeps build scripts disabled in safe mode and enables an explicit trusted analysis", async () => {
    const root = workspace();
    const marker = path.join(root, "trusted-build-script-marker.txt");
    const procMarker = path.join(root, "trusted-proc-macro-marker.txt");
    const generatedSource = path.join(root, "rust", "src", "generated_by_build.rs");
    mkdirSync(path.join(root, "fixture-macros", "src"), { recursive: true });
    writeFileSync(path.join(root, "Cargo.toml"), [
      "[package]",
      "name='fixture'",
      "version='0.1.0'",
      "edition='2021'",
      "build='build.rs'",
      "[lib]",
      "path='rust/src/lib.rs'",
      "[dependencies]",
      "fixture_macros={path='fixture-macros'}",
      "",
    ].join("\n"));
    writeFileSync(path.join(root, "build.rs"), [
      "fn main() {",
      "    std::fs::write(\"trusted-build-script-marker.txt\", \"executed\").unwrap();",
      "    std::fs::write(\"rust/src/generated_by_build.rs\", \"pub fn generated_by_build() -> i32 { 7 }\\n\").unwrap();",
      "    println!(\"cargo:rustc-cfg=contextmesh_build\");",
      "}",
      "",
    ].join("\n"));
    writeFileSync(path.join(root, "rust", "src", "lib.rs"), [
      "#[fixture_macros::contextmesh_marker]",
      "#[cfg(contextmesh_build)]",
      "pub fn generated_target() -> i32 { 1 }",
      "pub fn generated_caller() -> i32 { generated_target() }",
      "",
    ].join("\n"));
    writeFileSync(path.join(root, "fixture-macros", "Cargo.toml"), [
      "[package]", "name='fixture_macros'", "version='0.1.0'", "edition='2021'",
      "[lib]", "proc-macro=true", "",
    ].join("\n"));
    writeFileSync(path.join(root, "Cargo.lock"), [
      "# This file is automatically @generated by Cargo.",
      "# It is not intended for manual editing.",
      "version = 4",
      "",
      "[[package]]",
      "name = \"fixture\"",
      "version = \"0.1.0\"",
      "dependencies = [",
      " \"fixture_macros\",",
      "]",
      "",
      "[[package]]",
      "name = \"fixture_macros\"",
      "version = \"0.1.0\"",
      "",
    ].join("\n"));
    writeFileSync(path.join(root, "fixture-macros", "src", "lib.rs"), [
      "use proc_macro::TokenStream;",
      "#[proc_macro_attribute]",
      "pub fn contextmesh_marker(_attr: TokenStream, item: TokenStream) -> TokenStream {",
      `    std::fs::write(r#"${procMarker.replaceAll("\\", "/")}"#, "executed").unwrap();`,
      "    item",
      "}",
      "",
    ].join("\n"));
    writeFileSync(path.join(root, "rust-analyzer.toml"), [
      "checkOnSave=true", "[cargo]", "noDeps=false", "autoreload=true",
      "[cargo.buildScripts]", "enable=true", "[procMacro]", "enable=true", "",
    ].join("\n"));
    const prior = {
      disable: process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE,
      policy: process.env.CONTEXTMESH_RUST_ANALYZER_POLICY,
      command: process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND,
      args: process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON,
      go: process.env.CONTEXTMESH_GO_TYPES_DISABLE,
    };
    delete process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE;
    process.env.CONTEXTMESH_RUST_ANALYZER_POLICY = "safe";
    delete process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND;
    delete process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON;
    process.env.CONTEXTMESH_GO_TYPES_DISABLE = "1";
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(procMarker)).toBe(false);
      expect(existsSync(generatedSource)).toBe(false);
      expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
        provider: "rust_analyzer", status: "partial", lastError: expect.stringContaining("generated_target"),
      }));
      const caller = await app.searchCode({ query: "generated_caller", kinds: ["function"] }) as Envelope<{ results: Array<{ id: string }> }>;
      const target = await app.searchCode({ query: "generated_target", kinds: ["function"] }) as Envelope<{ results: Array<{ id: string }> }>;
      let trace = await app.traceCode({ symbolId: caller.data.results[0]!.id, direction: "out", edgeKinds: ["CALLS"], depth: 1 }) as Envelope<{
        edges: Array<{ targetId: string; status: string }>;
      }>;
      expect(trace.data.edges).toContainEqual(expect.objectContaining({ targetId: target.data.results[0]!.id, status: "candidate" }));

      process.env.CONTEXTMESH_RUST_ANALYZER_POLICY = "trusted";
      const trusted = await app.indexWorkspace({ mode: "incremental" }) as Envelope<{ noOp: boolean }>;
      expect(trusted.data.noOp).toBe(true);
      expect(existsSync(marker)).toBe(true);
      expect(existsSync(procMarker)).toBe(true);
      expect(existsSync(generatedSource)).toBe(true);
      trace = await app.traceCode({ symbolId: caller.data.results[0]!.id, direction: "out", edgeKinds: ["CALLS"], depth: 1 }) as Envelope<{
        edges: Array<{ targetId: string; status: string }>;
      }>;
      expect(trace.data.edges).toContainEqual(expect.objectContaining({ targetId: target.data.results[0]!.id, status: "resolved" }));

      await app.indexWorkspace({ mode: "full" });
      const generated = await app.searchCode({ query: "generated_by_build", kinds: ["function"] }) as Envelope<{
        results: Array<{ name: string; relativePath: string | null }>;
      }>;
      expect(generated.data.results).toContainEqual(expect.objectContaining({
        name: "generated_by_build", relativePath: "rust/src/generated_by_build.rs",
      }));

      unlinkSync(marker);
      unlinkSync(procMarker);
      process.env.CONTEXTMESH_RUST_ANALYZER_POLICY = "safe";
      const restrictedAgain = await app.indexWorkspace({ mode: "incremental" }) as Envelope<{ noOp: boolean }>;
      expect(restrictedAgain.data.noOp).toBe(true);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(procMarker)).toBe(false);
      trace = await app.traceCode({ symbolId: caller.data.results[0]!.id, direction: "out", edgeKinds: ["CALLS"], depth: 1 }) as Envelope<{
        edges: Array<{ targetId: string; status: string }>;
      }>;
      expect(trace.data.edges).toContainEqual(expect.objectContaining({
        targetId: target.data.results[0]!.id, status: "candidate",
      }));
    } finally {
      for (const [key, value] of Object.entries({
        CONTEXTMESH_RUST_ANALYZER_DISABLE: prior.disable,
        CONTEXTMESH_RUST_ANALYZER_POLICY: prior.policy,
        CONTEXTMESH_RUST_ANALYZER_COMMAND: prior.command,
        CONTEXTMESH_RUST_ANALYZER_ARGS_JSON: prior.args,
        CONTEXTMESH_GO_TYPES_DISABLE: prior.go,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await app.close();
    }
  }, 90_000);

  it("keeps Cargo dependency resolution offline in safe mode while serving the base graph", async () => {
    let connections = 0;
    const trap = createServer((socket) => {
      connections += 1;
      socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((resolve, reject) => {
      trap.once("error", reject);
      trap.listen(0, "127.0.0.1", () => resolve());
    });
    const address = trap.address();
    if (!address || typeof address === "string") throw new Error("network trap did not bind a TCP port");
    const root = workspace();
    mkdirSync(path.join(root, ".cargo"), { recursive: true });
    writeFileSync(path.join(root, "Cargo.toml"), [
      "[package]", "name='offline_fixture'", "version='0.1.0'", "edition='2021'",
      "[lib]", "path='rust/src/lib.rs'", "[dependencies]", "network_probe='999.0.0'", "",
    ].join("\n"));
    writeFileSync(path.join(root, ".cargo", "config.toml"), [
      "[source.crates-io]", "replace-with='contextmesh-trap'", "[source.contextmesh-trap]",
      `registry='sparse+http://127.0.0.1:${address.port}/'`, "",
    ].join("\n"));
    writeFileSync(path.join(root, "rust", "src", "lib.rs"), "pub fn offline_base() -> i32 { 1 }\n");
    const prior = {
      disable: process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE,
      policy: process.env.CONTEXTMESH_RUST_ANALYZER_POLICY,
      command: process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND,
      args: process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON,
      go: process.env.CONTEXTMESH_GO_TYPES_DISABLE,
    };
    delete process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE;
    process.env.CONTEXTMESH_RUST_ANALYZER_POLICY = "safe";
    delete process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND;
    delete process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON;
    process.env.CONTEXTMESH_GO_TYPES_DISABLE = "1";
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(connections).toBe(0);
      const base = await app.searchCode({ query: "offline_base", kinds: ["function"] }) as Envelope<{
        results: Array<{ name: string; analysisLevel: string }>;
      }>;
      expect(base.data.results).toContainEqual(expect.objectContaining({ name: "offline_base" }));
    } finally {
      for (const [key, value] of Object.entries({
        CONTEXTMESH_RUST_ANALYZER_DISABLE: prior.disable,
        CONTEXTMESH_RUST_ANALYZER_POLICY: prior.policy,
        CONTEXTMESH_RUST_ANALYZER_COMMAND: prior.command,
        CONTEXTMESH_RUST_ANALYZER_ARGS_JSON: prior.args,
        CONTEXTMESH_GO_TYPES_DISABLE: prior.go,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await app.close();
      await new Promise<void>((resolve) => trap.close(() => resolve()));
    }
  }, 60_000);

  it("waits for a quiescent Rust workspace before committing a resolved LSP call", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "rust", "src", "lib.rs"), [
      "/* 정의😀 */ pub fn rust_target() -> i32 { 1 }",
      "pub fn rust_caller() -> i32 { /* 호출한글😀 */ rust_target() }",
      "",
    ].join("\n"));
    const server = path.join(root, "fake-rust-analyzer.mjs");
    writeFileSync(server, [
      "if (process.argv.includes('--version')) { console.log('rust-analyzer 1.85.0 (4d91de4 2025-02-17)'); process.exit(0); }",
      "let buffer = Buffer.alloc(0); const documents = new Map(); let workspaceReady = false;",
      "function send(value) { const body = Buffer.from(JSON.stringify(value)); process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\\r\\n\\r\\n`), body])); }",
      "function handle(message) {",
      "  if (message.method === 'textDocument/didOpen') { documents.set(message.params.textDocument.uri, message.params.textDocument.text); return; }",
      "  if (message.method === 'initialized') { send({ jsonrpc: '2.0', method: 'experimental/serverStatus', params: { health: 'ok', quiescent: false } }); setTimeout(() => { workspaceReady = true; send({ jsonrpc: '2.0', method: 'experimental/serverStatus', params: { health: 'ok', quiescent: true } }); }, 100); return; }",
      "  if (message.method === 'exit') process.exit(0);",
      "  if (message.id === undefined) return;",
      "  if (message.method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { definitionProvider: true } } });",
      "  if (message.method === 'shutdown') return send({ jsonrpc: '2.0', id: message.id, result: null });",
      "  if (message.method === 'textDocument/definition') {",
      "    if (!workspaceReady) return send({ jsonrpc: '2.0', id: message.id, error: { message: 'workspace not quiescent' } });",
      "    const source = documents.get(message.params.textDocument.uri); const sourceLines = source.split(/\\r?\\n/); const expected = sourceLines[message.params.position.line].indexOf('rust_target');",
      "    if (message.params.position.character !== expected) return send({ jsonrpc: '2.0', id: message.id, error: { message: 'utf-16 query position mismatch' } });",
      "    const entry = [...documents.entries()].find(([, text]) => text.includes('pub fn rust_target')); const lines = entry[1].split(/\\r?\\n/); const line = lines.findIndex((item) => item.includes('pub fn rust_target')); const character = lines[line].indexOf('rust_target');",
      "    return send({ jsonrpc: '2.0', id: message.id, result: [{ uri: 'file:///external/dependency.rs', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }, { targetUri: entry[0], range: { start: { line: 999, character: 999 }, end: { line: 999, character: 999 } }, targetSelectionRange: { start: { line, character }, end: { line, character: character + 'rust_target'.length } } }] });",
      "  }",
      "  send({ jsonrpc: '2.0', id: message.id, result: null });",
      "}",
      "process.stdin.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); while (true) { const end = buffer.indexOf('\\r\\n\\r\\n'); if (end < 0) break; const length = Number(buffer.subarray(0, end).toString().match(/Content-Length:\\s*(\\d+)/i)?.[1]); if (buffer.length < end + 4 + length) break; const body = buffer.subarray(end + 4, end + 4 + length).toString(); buffer = buffer.subarray(end + 4 + length); handle(JSON.parse(body)); } });",
      "",
    ].join("\n"));
    const priorCommand = process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND;
    const priorArgs = process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON;
    const priorGoDisable = process.env.CONTEXTMESH_GO_TYPES_DISABLE;
    delete process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE;
    process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND = process.execPath;
    process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON = JSON.stringify([server]);
    process.env.CONTEXTMESH_GO_TYPES_DISABLE = "1";
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const caller = await app.searchCode({ query: "rust_caller", kinds: ["function"] }) as Envelope<{ results: Array<{ id: string }> }>;
      const target = await app.searchCode({ query: "rust_target", kinds: ["function"] }) as Envelope<{ results: Array<{ id: string }> }>;
      const trace = await app.traceCode({ symbolId: caller.data.results[0]!.id, direction: "out", edgeKinds: ["CALLS"], depth: 1 }) as Envelope<{
        edges: Array<{ targetId: string; status: string; evidence: Array<{ provider: string }> }>;
      }>;
      expect(trace.data.edges).toContainEqual(expect.objectContaining({
        targetId: target.data.results[0]!.id,
        status: "resolved",
        evidence: expect.arrayContaining([expect.objectContaining({ provider: "rust_analyzer" })]),
      }));
      expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
        provider: "rust_analyzer", status: "ready", resolvedEdges: 1,
      }));
    } finally {
      if (priorCommand === undefined) delete process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND;
      else process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND = priorCommand;
      if (priorArgs === undefined) delete process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON;
      else process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON = priorArgs;
      if (priorGoDisable === undefined) delete process.env.CONTEXTMESH_GO_TYPES_DISABLE;
      else process.env.CONTEXTMESH_GO_TYPES_DISABLE = priorGoDisable;
      await app.close();
    }
  });

  it("rejects a server-selected position encoding the client did not offer", async () => {
    const root = workspace();
    const server = path.join(root, "rust-analyzer-utf32.mjs");
    writeFileSync(server, [
      "if (process.argv.includes('--version')) { console.log('rust-analyzer 1.85.0 (4d91de4 2025-02-17)'); process.exit(0); }",
      "let buffer = Buffer.alloc(0);",
      "function send(value) { const body = Buffer.from(JSON.stringify(value)); process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\\r\\n\\r\\n`), body])); }",
      "function handle(message) {",
      "  if (message.method === 'exit') process.exit(0);",
      "  if (message.id === undefined) return;",
      "  if (message.method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { positionEncoding: 'utf-32' } } });",
      "  if (message.method === 'shutdown') return send({ jsonrpc: '2.0', id: message.id, result: null });",
      "  send({ jsonrpc: '2.0', id: message.id, result: null });",
      "}",
      "process.stdin.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); while (true) { const end = buffer.indexOf('\\r\\n\\r\\n'); if (end < 0) break; const length = Number(buffer.subarray(0, end).toString().match(/Content-Length:\\s*(\\d+)/i)?.[1]); if (buffer.length < end + 4 + length) break; const body = buffer.subarray(end + 4, end + 4 + length).toString(); buffer = buffer.subarray(end + 4 + length); handle(JSON.parse(body)); } });",
    ].join("\n"));
    const prior = {
      command: process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND,
      args: process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON,
      go: process.env.CONTEXTMESH_GO_TYPES_DISABLE,
    };
    delete process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE;
    process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND = process.execPath;
    process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON = JSON.stringify([server]);
    process.env.CONTEXTMESH_GO_TYPES_DISABLE = "1";
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
        provider: "rust_analyzer", status: "failed",
        lastError: expect.stringMatching(/unsupported position encoding utf-32/),
      }));
    } finally {
      if (prior.command === undefined) delete process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND;
      else process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND = prior.command;
      if (prior.args === undefined) delete process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON;
      else process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON = prior.args;
      if (prior.go === undefined) delete process.env.CONTEXTMESH_GO_TYPES_DISABLE;
      else process.env.CONTEXTMESH_GO_TYPES_DISABLE = prior.go;
      await app.close();
    }
  });

  it("resolves a call through a local Go module import", async () => {
    const root = workspace();
    mkdirSync(path.join(root, "lib"), { recursive: true });
    mkdirSync(path.join(root, "cmd"), { recursive: true });
    writeFileSync(path.join(root, "lib", "lib.go"), "package lib\nfunc CrossPackageTarget() int { return 1 }\n");
    writeFileSync(path.join(root, "cmd", "caller.go"), [
      "package cmd",
      "import \"example.local/contextmesh/lib\"",
      "func CrossPackageCaller() int { return lib.CrossPackageTarget() }",
      "",
    ].join("\n"));
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const caller = await app.searchCode({ query: "CrossPackageCaller", kinds: ["function"] }) as Envelope<{
        results: Array<{ id: string }>;
      }>;
      const target = await app.searchCode({ query: "CrossPackageTarget", kinds: ["function"] }) as Envelope<{
        results: Array<{ id: string }>;
      }>;
      expect(caller.data.results).toHaveLength(1);
      expect(target.data.results).toHaveLength(1);
      const trace = await app.traceCode({
        symbolId: caller.data.results[0]!.id,
        direction: "out",
        edgeKinds: ["CALLS"],
        depth: 1,
      }) as Envelope<{ edges: Array<{ targetId: string; status: string; evidence: Array<{ provider: string }> }> }>;
      expect(trace.data.edges).toContainEqual(expect.objectContaining({
        targetId: target.data.results[0]!.id,
        status: "resolved",
        evidence: expect.arrayContaining([expect.objectContaining({ provider: "go_types" })]),
      }));
    } finally { await app.close(); }
  });
});
