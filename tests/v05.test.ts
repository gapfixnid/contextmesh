import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { ContextMeshApp } from "../src/app.js";
import { probeRustAnalyzerRuntime } from "../src/code/languages/rust-precision.js";
import type { CodeEvidence, Envelope } from "../src/contracts.js";

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
        precisionProvider: null,
        analysisLevel: "syntax",
        precisionInvocations: 0,
        status: "not_configured",
        coverage: 0,
      }));
      expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
        language: "python",
        provider: "contextmesh_python_resolver",
        status: "not_configured",
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
      analyze: async (_batch, baseGeneration) => ({
        language: "go",
        provider: "recovery_fixture",
        providerVersion: "1",
        capability: "resolved",
        baseGeneration,
        edges: [],
        eligibleEdges: 0,
        diagnostics: [],
      }),
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
      const indexed = await app.indexWorkspace({ mode: "full" });
      expect(indexed.generation).toBe(1);
      expect((await app.searchCode({ query: "SyntaxCaller", kinds: ["function"] }) as Envelope<{ results: unknown[] }>).data.results).toHaveLength(1);
      expect(app.database.getPrecisionProviderStates()).toContainEqual(expect.objectContaining({
        provider: "typescript_type_checker",
        status: "failed",
        lastError: "AUDIT_TYPECHECKER_UNAVAILABLE",
      }));
    } finally {
      mutableAdapter.createPrecisionProvider = originalPrecisionProvider;
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
      const noOp = await app.indexWorkspace({ mode: "incremental" }) as Envelope<{ noOp: boolean }>;
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
    const priorCommand = process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND;
    process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND = process.execPath;
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
      await app.close();
    }
  });

  it("rejects an invalid configured rust-analyzer for release provenance", async () => {
    const priorCommand = process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND;
    const priorArgs = process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON;
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

  it("waits for a cold Rust workspace before committing a resolved LSP call", async () => {
    const root = workspace();
    const server = path.join(root, "fake-rust-analyzer.mjs");
    writeFileSync(server, [
      "if (process.argv.includes('--version')) { console.log('rust-analyzer fixture'); process.exit(0); }",
      "let buffer = Buffer.alloc(0); const documents = new Map(); let definitionRequests = 0;",
      "function send(value) { const body = Buffer.from(JSON.stringify(value)); process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\\r\\n\\r\\n`), body])); }",
      "function handle(message) {",
      "  if (message.method === 'textDocument/didOpen') { documents.set(message.params.textDocument.uri, message.params.textDocument.text); return; }",
      "  if (message.method === 'exit') process.exit(0);",
      "  if (message.id === undefined) return;",
      "  if (message.method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { definitionProvider: true } } });",
      "  if (message.method === 'shutdown') return send({ jsonrpc: '2.0', id: message.id, result: null });",
      "  if (message.method === 'textDocument/definition') {",
      "    definitionRequests += 1; if (definitionRequests <= 11) return send({ jsonrpc: '2.0', id: message.id, result: null });",
      "    const entry = [...documents.entries()].find(([, text]) => text.includes('pub fn rust_target'));",
      "    const lines = entry[1].split(/\\r?\\n/); const line = lines.findIndex((item) => item.includes('pub fn rust_target'));",
      "    return send({ jsonrpc: '2.0', id: message.id, result: { uri: entry[0], range: { start: { line, character: 7 }, end: { line, character: 18 } } } });",
      "  }",
      "  send({ jsonrpc: '2.0', id: message.id, result: null });",
      "}",
      "process.stdin.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); while (true) { const end = buffer.indexOf('\\r\\n\\r\\n'); if (end < 0) break; const length = Number(buffer.subarray(0, end).toString().match(/Content-Length:\\s*(\\d+)/i)?.[1]); if (buffer.length < end + 4 + length) break; const body = buffer.subarray(end + 4, end + 4 + length).toString(); buffer = buffer.subarray(end + 4 + length); handle(JSON.parse(body)); } });",
      "",
    ].join("\n"));
    const priorCommand = process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND;
    const priorArgs = process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON;
    const priorGoDisable = process.env.CONTEXTMESH_GO_TYPES_DISABLE;
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
