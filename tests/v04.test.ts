import { renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ContextMeshApp } from "../src/app.js";
import { extractPythonKernelFacts } from "../src/code/native-kernel.js";
import { GraphWatchCoordinator, NativeWatchEventSource, type WatchClock, type WatchEvent, type WatchEventSource } from "../src/code/watcher.js";
import { createFixtureWorkspace, removeFixtureWorkspace, writeWorkspaceFile } from "./helpers.js";

const roots: string[] = [];
afterEach(() => {
  delete process.env.CONTEXTMESH_GRAPH_KERNEL_PATH;
  delete process.env.CONTEXTMESH_KERNEL_POLICY;
  for (const root of roots.splice(0)) removeFixtureWorkspace(root);
});

function pythonScan(root: string) {
  const content = "from . import helper\n\nclass Service(Base):\n    def run(self):\n        helper()\n";
  return { absolutePath: path.join(root, "src/pkg/service.py"), relativePath: "src/pkg/service.py", pathKey: "src/pkg/service.py", language: "python" as const,
    content, contentHash: "hash", sizeBytes: Buffer.byteLength(content), mtimeMs: 1 };
}

function withoutGeneration<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value), (key, item) => key === "generation" ? undefined : item);
}

class FakeSource implements WatchEventSource {
  onEvent: ((event: WatchEvent) => void) | null = null;
  async start(_root: string, onEvent: (event: WatchEvent) => void): Promise<void> { this.onEvent = onEvent; }
  async close(): Promise<void> { this.onEvent = null; }
  emit(...paths: string[]): void { this.onEvent?.({ kind: "Modify", paths }); }
}

class FakeClock implements WatchClock {
  tasks: Array<() => void> = [];
  setTimeout(callback: () => void): unknown { this.tasks.push(callback); return callback; }
  clearTimeout(handle: unknown): void { this.tasks = this.tasks.filter((item) => item !== handle); }
  flush(): void { this.tasks.shift()?.(); }
}

async function generationAfter(app: ContextMeshApp, generation: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (app.database.getWorkspace().currentGeneration > generation) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`generation did not advance after ${generation}`);
}

describe("v0.4 graph kernel, watcher, and explore vertical slice", () => {
  it("uses real native Python extraction with exact portable canonical graph parity", async () => {
    const root = createFixtureWorkspace(); roots.push(root);
    writeWorkspaceFile(root, "src/pkg/__init__.py", "from . import helper\n");
    writeWorkspaceFile(root, "src/pkg/helper.py", "def helper():\n    return 1\n");
    writeWorkspaceFile(root, "src/pkg/service.py", pythonScan(root).content);
    const facts = await extractPythonKernelFacts([pythonScan(root)], "native-required");
    const portable = await extractPythonKernelFacts([pythonScan(root)], "portable");
    expect(facts.mode).toBe("sidecar");
    expect(facts.files).toEqual(portable.files);

    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const nativeGraph = app.database.getStoredGraphPartition("python");
      process.env.CONTEXTMESH_KERNEL_POLICY = "portable";
      await app.indexWorkspace({ mode: "full" });
      const portableGraph = app.database.getStoredGraphPartition("python");
      expect(withoutGeneration(nativeGraph)).toEqual(withoutGeneration(portableGraph));
    } finally { await app.close(); }
  });

  it("preserves the committed generation and cache after a kernel failure", async () => {
    const root = createFixtureWorkspace(); roots.push(root);
    writeWorkspaceFile(root, "src/only.py", "def ready():\n    return 1\n");
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const generation = app.database.getWorkspace().currentGeneration;
      const cache = app.code.cacheStats();
      writeWorkspaceFile(root, "src/only.py", "def ready():\n    return 2\n");
      process.env.CONTEXTMESH_GRAPH_KERNEL_PATH = path.join(root, "missing-kernel.exe");
      await expect(app.indexWorkspace({ mode: "incremental" })).rejects.toThrow("KERNEL_UNAVAILABLE");
      expect(app.database.getWorkspace().currentGeneration).toBe(generation);
      expect(app.code.cacheStats()).toEqual(cache);
      expect((app.database.getStatus().lastRun as { status: string }).status).toBe("failed");
      const status = (await app.workspaceStatus()).data as { graphKernel: { status: string; diagnostics: Array<{ code: string }> } };
      expect(status.graphKernel.status).toBe("failed"); expect(status.graphKernel.diagnostics[0]?.code).toBe("KERNEL_UNAVAILABLE");
    } finally { await app.close(); }
  });

  it("coalesces events deterministically and never loses events arriving during indexing", async () => {
    const source = new FakeSource(); const clock = new FakeClock(); let calls = 0; const pending: { release?: () => void } = {};
    const coordinator = new GraphWatchCoordinator("C:/fixture", async () => {
      calls += 1;
      if (calls === 2) await new Promise<void>((resolve) => { pending.release = resolve; });
    }, () => {}, { eventSource: source, clock, debounceMs: 10 });
    await coordinator.start();
    expect(calls).toBe(1);
    source.emit("b.py", "a.py"); source.emit("a.py"); clock.flush();
    await Promise.resolve(); expect(calls).toBe(2);
    source.emit("c.py"); pending.release?.(); await Promise.resolve(); await Promise.resolve();
    clock.flush(); await Promise.resolve();
    expect(calls).toBe(3);
    await coordinator.close();
  });

  it("observes an actual native OS watcher event in a separate smoke", async () => {
    const root = createFixtureWorkspace(); roots.push(root);
    const source = new NativeWatchEventSource();
    try {
      const observed = new Promise<WatchEvent>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("native watcher smoke timed out")), 5000);
        void source.start(root, (event) => { if (event.paths.some((item) => item.endsWith("watch-smoke.py"))) { clearTimeout(timeout); resolve(event); } }, reject)
          .then(() => writeFileSync(path.join(root, "watch-smoke.py"), "value = 1\n", "utf8"), reject);
      });
      expect((await observed).paths.some((item) => item.endsWith("watch-smoke.py"))).toBe(true);
    } finally { await source.close(); }
  });

  it("reconciles add/change/delete/rename and config events while excluding ignored events", async () => {
    const root = createFixtureWorkspace(); roots.push(root); const source = new FakeSource(); const clock = new FakeClock();
    const app = new ContextMeshApp(root, undefined, { watcher: { eventSource: source, clock, debounceMs: 10 } });
    try {
      await app.initialize(false);
      let generation = app.database.getWorkspace().currentGeneration;
      const added = path.join(root, "src", "watch-added.py"); writeWorkspaceFile(root, "src/watch-added.py", "def watched():\n    return 1\n");
      source.emit(added); clock.flush(); await generationAfter(app, generation); generation = app.database.getWorkspace().currentGeneration;
      writeWorkspaceFile(root, "src/watch-added.py", "def watched():\n    return 2\n"); source.emit(added); clock.flush(); await generationAfter(app, generation); generation = app.database.getWorkspace().currentGeneration;
      const renamed = path.join(root, "src", "watch-renamed.py"); renameSync(added, renamed); source.emit(added, renamed); clock.flush(); await generationAfter(app, generation); generation = app.database.getWorkspace().currentGeneration;
      rmSync(renamed); source.emit(renamed); clock.flush(); await generationAfter(app, generation); generation = app.database.getWorkspace().currentGeneration;
      writeWorkspaceFile(root, "pyproject.toml", "[tool.setuptools.packages.find]\nwhere=['src']\n"); source.emit(path.join(root, "pyproject.toml")); clock.flush(); await generationAfter(app, generation); generation = app.database.getWorkspace().currentGeneration;
      writeWorkspaceFile(root, "src/public.d.ts", "export declare const publicApi: string;\n"); source.emit(path.join(root, "src/public.d.ts")); clock.flush(); await generationAfter(app, generation); generation = app.database.getWorkspace().currentGeneration;
      writeWorkspaceFile(root, ".env.py", "secret = 'ignored'\n"); source.emit(path.join(root, ".env.py")); clock.flush(); await new Promise<void>((resolve) => setImmediate(resolve));
      expect(app.database.getWorkspace().currentGeneration).toBe(generation);
      expect((await app.searchCode({ query: "watched" })).data).toEqual({ results: [], nextOffset: null });
    } finally { await app.close(); }
  });

  it("repairs event loss by reconciling the durable baseline on watcher restart", async () => {
    const root = createFixtureWorkspace(); roots.push(root); let app = new ContextMeshApp(root);
    await app.indexWorkspace({ mode: "full" }); const generation = app.database.getWorkspace().currentGeneration; await app.close();
    writeWorkspaceFile(root, "src/lost-event.py", "def reconciled():\n    return 1\n");
    app = new ContextMeshApp(root, undefined, { watcher: { eventSource: new FakeSource(), clock: new FakeClock() } });
    try { await app.initialize(false); expect(app.database.getWorkspace().currentGeneration).toBeGreaterThan(generation); expect(((await app.searchCode({ query: "reconciled" })).data as { results: unknown[] }).results).toHaveLength(1); }
    finally { await app.close(); }
  });

  it("returns one-shot bounded current evidence for all supported explore intents", async () => {
    const root = createFixtureWorkspace(); roots.push(root);
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      for (const intent of ["implementation", "architecture", "debugging"] as const) {
        const result = await app.exploreContext({ query: "Calculator", intent, tokenBudget: 2000, limit: 8 });
        const data = result.data as { intent: string; entryPoints: Array<{ snippet: string | null }>; trace: { toolCalls: number; fileReads: number } };
        expect(data.intent).toBe(intent); expect(data.entryPoints.length).toBeGreaterThan(0);
        expect(data.trace.toolCalls).toBe(1); expect(result.estimatedTokens).toBeLessThanOrEqual(2000);
        expect(data.trace.fileReads).toBeGreaterThan(0);
      }
    } finally { await app.close(); }
  });
});
