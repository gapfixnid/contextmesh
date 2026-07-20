import { renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { ContextMeshApp } from "../src/app.js";
import { extractPythonKernelFacts, type GraphKernelLaunch } from "../src/code/native-kernel.js";
import { GraphWatchCoordinator, NativeWatchEventSource, type WatchClock, type WatchEvent, type WatchEventSource } from "../src/code/watcher.js";
import { ContextMeshDatabase } from "../src/storage/database.js";
import { createFixtureWorkspace, removeFixtureWorkspace, writeWorkspaceFile } from "./helpers.js";

const roots: string[] = [];
afterEach(() => {
  delete process.env.CONTEXTMESH_GRAPH_KERNEL_PATH;
  delete process.env.CONTEXTMESH_GRAPH_KERNEL_ARGS_JSON;
  delete process.env.CONTEXTMESH_GRAPH_KERNEL_TIMEOUT_MS;
  delete process.env.CONTEXTMESH_GRAPH_KERNEL_MAX_RESPONSE_BYTES;
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

class FailingSource implements WatchEventSource {
  starts = 0;
  async start(): Promise<void> { this.starts += 1; throw new Error("synthetic-source-failure"); }
  async close(): Promise<void> {}
}

class RecoverableSource implements WatchEventSource {
  starts = 0;
  private onError: ((error: Error) => void) | null = null;
  async start(_root: string, _onEvent: (event: WatchEvent) => void, onError: (error: Error) => void): Promise<void> {
    this.starts += 1;
    this.onError = onError;
  }
  async close(): Promise<void> { this.onError = null; }
  fail(): void { this.onError?.(new Error("recoverable-source-failure")); }
}

class DeferredCloseSource implements WatchEventSource {
  starts = 0;
  closes = 0;
  private onError: ((error: Error) => void) | null = null;
  private readonly closeReleases: Array<() => void> = [];

  async start(_root: string, _onEvent: (event: WatchEvent) => void, onError: (error: Error) => void): Promise<void> {
    this.starts += 1;
    this.onError = onError;
  }

  close(): Promise<void> {
    this.closes += 1;
    return new Promise<void>((resolve) => this.closeReleases.push(resolve));
  }

  fail(): void { this.onError?.(new Error("recoverable-source-failure")); }
  releaseClose(index: number): void { this.closeReleases[index]?.(); }
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

  it("preserves async metadata and multiline signatures across native and portable providers", async () => {
    const root = createFixtureWorkspace(); roots.push(root);
    const content = "@decorator\nasync def calculate(\n    left,\n    right,\n):\n    return helper(left, right)\n";
    const scan = { ...pythonScan(root), content, contentHash: "async-multiline" };
    const native = await extractPythonKernelFacts([scan], "native-required", true);
    const portable = await extractPythonKernelFacts([scan], "portable", true);
    expect(native.files).toEqual(portable.files);
    expect(native.files[0]?.declarations[0]).toMatchObject({ isAsync: true, signature: "async def calculate(\n    left,\n    right,\n)" });
  });

  it.each([
    ["missing executable", "KERNEL_SPAWN_FAILED", { executable: "Z:/contextmesh-missing-kernel.exe", timeoutMs: 100 }],
    ["malformed response", "KERNEL_PROTOCOL_INVALID", null],
    ["hung response", "KERNEL_TIMEOUT", null],
  ] as const)("fails closed with a stable diagnostic for %s", async (behavior, code, staticLaunch) => {
    const root = createFixtureWorkspace(); roots.push(root);
    let launch: GraphKernelLaunch | undefined = staticLaunch ?? undefined;
    if (!launch) {
      const script = behavior === "hung response"
        ? "process.stdin.resume(); setInterval(() => {}, 1000);\n"
        : "process.stdin.once('data', () => process.stdout.write('not-json\\n'));\n";
      writeWorkspaceFile(root, "fake-kernel.mjs", script);
      // Leave enough headroom for child-process startup while the full suite runs in parallel.
      // The hung-response case remains strictly bounded by this one-second deadline.
      launch = { executable: process.execPath, args: [path.join(root, "fake-kernel.mjs")], timeoutMs: 1_000 };
    }
    await expect(extractPythonKernelFacts([pythonScan(root)], "native-required", true, launch)).rejects.toThrow(code);
  });

  it("rejects a graph-kernel hello with an incompatible executable version", async () => {
    const root = createFixtureWorkspace(); roots.push(root);
    const script = [
      "import readline from 'node:readline';",
      "const lines = readline.createInterface({ input: process.stdin });",
      "lines.on('line', (line) => { const request = JSON.parse(line);",
      "process.stdout.write(JSON.stringify({ protocol: 'contextmesh.graph-kernel/v1', requestId: request.requestId, status: 'ok',",
      "data: { kernelVersion: '9.9.9', grammarRegistry: [{ language: 'python', provider: 'tree-sitter-python', version: '0.25.0' }] }, diagnostics: [] }) + '\\n'); });",
      "",
    ].join("\n");
    writeWorkspaceFile(root, "wrong-version-kernel.mjs", script);
    const launch = { executable: process.execPath, args: [path.join(root, "wrong-version-kernel.mjs")], timeoutMs: 1_000 };
    await expect(extractPythonKernelFacts([pythonScan(root)], "native-required", true, launch))
      .rejects.toThrow("KERNEL_VERSION_MISMATCH");
  });

  it("performs and validates hello before starting the native watcher", async () => {
    const root = createFixtureWorkspace(); roots.push(root);
    const script = [
      "import readline from 'node:readline';",
      "const lines = readline.createInterface({ input: process.stdin });",
      "lines.on('line', (line) => { const request = JSON.parse(line);",
      "const data = request.operation === 'hello' ? { kernelVersion: '9.9.9', grammarRegistry: [] } : { rootPath: request.rootPath };",
      "process.stdout.write(JSON.stringify({ protocol: 'contextmesh.graph-kernel/v1', requestId: request.requestId, status: request.operation === 'watch' ? 'ready' : 'ok', data, diagnostics: [] }) + '\\n'); });",
      "",
    ].join("\n");
    writeWorkspaceFile(root, "wrong-version-watcher.mjs", script);
    const source = new NativeWatchEventSource({
      executable: process.execPath,
      args: [path.join(root, "wrong-version-watcher.mjs")],
      timeoutMs: 1_000,
    });
    try {
      await expect(source.start(root, () => {}, () => {})).rejects.toThrow("WATCH_KERNEL_VERSION_MISMATCH");
    } finally {
      await source.close();
    }
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
    source.emit("C:/fixture/b.py", "C:/fixture/a.py"); source.emit("C:/fixture/a.py"); clock.flush();
    await Promise.resolve(); expect(calls).toBe(2);
    source.emit("C:/fixture/c.py"); pending.release?.(); await Promise.resolve(); await Promise.resolve();
    clock.flush(); await Promise.resolve();
    expect(calls).toBe(3);
    await coordinator.close();
  });

  it("fences concurrent workspace writers across independent database connections", () => {
    const root = createFixtureWorkspace(); roots.push(root);
    const first = new ContextMeshDatabase(root);
    const firstRun = first.startIndexRun("full");
    const second = new ContextMeshDatabase(root, first.dbPath);
    try {
      expect((first.getStatus().lastRun as { status: string }).status).toBe("running");
      expect(() => second.startIndexRun("full")).toThrowError(expect.objectContaining({
        code: "DB_BUSY",
      }));
      first.failIndexRun(firstRun, ["test release"]);
      const secondRun = second.startIndexRun("full");
      expect(secondRun.generation).toBe(firstRun.generation + 1);
      second.failIndexRun(secondRun, ["test cleanup"]);
    } finally {
      second.close();
      first.close();
    }
  });

  it("allows an expired writer lease takeover and fences the stale owner", () => {
    const root = createFixtureWorkspace(); roots.push(root);
    const first = new ContextMeshDatabase(root);
    const staleRun = first.startIndexRun("full");
    const raw = new DatabaseSync(first.dbPath);
    raw.prepare(
      "UPDATE index_writer_leases SET heartbeat_epoch = 1, lease_expiry_epoch = 2 WHERE run_id = ?",
    ).run(staleRun.id);
    raw.close();

    const second = new ContextMeshDatabase(root, first.dbPath);
    try {
      const takeoverRun = second.startIndexRun("full");
      expect(takeoverRun.generation).toBe(staleRun.generation + 1);
      expect(() => first.failIndexRun(staleRun, ["stale writer mutation"])).toThrowError(
        expect.objectContaining({ code: "DB_BUSY" }),
      );
      expect((second.getStatus().lastRun as { id: string; status: string })).toMatchObject({
        id: takeoverRun.id,
        status: "running",
      });
      second.failIndexRun(takeoverRun, ["test cleanup"]);
    } finally {
      second.close();
      first.close();
    }
  });

  it("persists and clears graph-kernel health across process restarts", async () => {
    const root = createFixtureWorkspace(); roots.push(root);
    writeWorkspaceFile(root, "src/durable.py", "def durable_kernel():\n    return 1\n");
    let app = new ContextMeshApp(root);
    await app.indexWorkspace({ mode: "full" });
    writeWorkspaceFile(root, "src/durable.py", "def durable_kernel():\n    return 2\n");
    process.env.CONTEXTMESH_GRAPH_KERNEL_PATH = path.join(root, "missing-kernel.exe");
    await expect(app.indexWorkspace({ mode: "incremental" })).rejects.toThrow("KERNEL_UNAVAILABLE");
    await app.close();

    app = new ContextMeshApp(root);
    let status = (await app.workspaceStatus()).data as { graphKernel: { status: string; diagnostics: Array<{ code: string }> } };
    expect(status.graphKernel.status).toBe("failed"); expect(status.graphKernel.diagnostics[0]?.code).toBe("KERNEL_UNAVAILABLE");
    delete process.env.CONTEXTMESH_GRAPH_KERNEL_PATH;
    await app.indexWorkspace({ mode: "full" });
    status = (await app.workspaceStatus()).data as typeof status;
    expect(status.graphKernel.status).toBe("ready"); expect(status.graphKernel.diagnostics).toEqual([]);
    await app.close();
  });

  it("does not schedule reconciliation for ignored database and build events", async () => {
    const root = createFixtureWorkspace(); roots.push(root);
    const source = new FakeSource(); const clock = new FakeClock(); let calls = 0;
    const coordinator = new GraphWatchCoordinator(root, async () => { calls += 1; }, () => {}, { eventSource: source, clock });
    await coordinator.start();
    source.emit(path.join(root, ".contextmesh", "contextmesh.sqlite3-wal"), path.join(root, "dist", "generated.js"));
    clock.flush(); await Promise.resolve();
    expect(calls).toBe(1);
    await coordinator.close();
  });

  it("serves the last generation and bounds retries when watcher startup fails", async () => {
    const root = createFixtureWorkspace(); roots.push(root);
    let app = new ContextMeshApp(root);
    await app.indexWorkspace({ mode: "full" }); const generation = app.database.getWorkspace().currentGeneration; await app.close();
    const source = new FailingSource(); const clock = new FakeClock();
    app = new ContextMeshApp(root, undefined, { watcher: { eventSource: source, clock, maxRetries: 2 } });
    try {
      await expect(app.initialize(false)).resolves.toBeUndefined();
      expect(app.database.getWorkspace().currentGeneration).toBe(generation);
      expect(((await app.searchCode({ query: "Calculator" })).data as { results: unknown[] }).results.length).toBeGreaterThan(0);
      for (let attempt = 0; attempt < 4; attempt += 1) { clock.flush(); await Promise.resolve(); await Promise.resolve(); }
      expect(source.starts).toBe(3);
      const watcher = ((await app.workspaceStatus()).data as { watcher: { state: string; lastDiagnostic: string } }).watcher;
      expect(watcher.state).toBe("failed"); expect(watcher.lastDiagnostic).toContain("WATCH_SOURCE_FAILED");
    } finally { await app.close(); }
  });

  it("persists watcher failure and clears it only after native source recovery", async () => {
    const root = createFixtureWorkspace(); roots.push(root);
    const failing = new FailingSource(); const failedClock = new FakeClock();
    let app = new ContextMeshApp(root, undefined, { watcher: { eventSource: failing, clock: failedClock, maxRetries: 0 } });
    await app.initialize(false); await app.close();

    app = new ContextMeshApp(root);
    let status = (await app.workspaceStatus()).data as { watcher: { durable: { status: string; diagnostic: string } | null } };
    expect(status.watcher.durable?.status).toBe("failed"); expect(status.watcher.durable?.diagnostic).toContain("WATCH_SOURCE_FAILED");
    await app.close();

    app = new ContextMeshApp(root, undefined, { watcher: { eventSource: new FakeSource(), clock: new FakeClock() } });
    await app.initialize(false);
    status = (await app.workspaceStatus()).data as typeof status;
    expect(status.watcher.durable?.status).toBe("ready");
    await app.close();
  });

  it("records a watcher source failure during an active writer lease and clears it after restart", async () => {
    const root = createFixtureWorkspace(); roots.push(root);
    const app = new ContextMeshApp(root);
    const source = new RecoverableSource();
    const clock = new FakeClock();
    const coordinator = new GraphWatchCoordinator(
      root,
      async () => {},
      (diagnostic) => app.code.recordOperationalFailure(diagnostic),
      { eventSource: source, clock, maxRetries: 2 },
      () => app.code.recordOperationalRecovery("watcher"),
    );
    try {
      await app.indexWorkspace({ mode: "full" });
      await coordinator.start();
      const generation = app.database.getWorkspace().currentGeneration;
      const active = app.database.startIndexRun("incremental");
      expect(() => source.fail()).not.toThrow();
      expect(app.database.getWorkspace().currentGeneration).toBe(generation);
      expect(app.database.getOperationalStatus().watcher?.status).toBe("failed");
      app.database.failIndexRun(active, ["fixture cleanup"]);

      clock.flush();
      for (let attempt = 0; attempt < 20 && source.starts < 2; attempt += 1) await Promise.resolve();
      for (let attempt = 0; attempt < 20 && app.database.getOperationalStatus().watcher?.status !== "ready"; attempt += 1) await Promise.resolve();
      expect(source.starts).toBe(2);
      expect(coordinator.status()).toMatchObject({ state: "watching", sourceRetries: 0, lastDiagnostic: null });
      expect(app.database.getOperationalStatus().watcher?.status).toBe("ready");
    } finally {
      await coordinator.close();
      await app.close();
    }
  });

  it("does not restart a fired source retry after coordinator shutdown", async () => {
    const root = createFixtureWorkspace(); roots.push(root);
    const source = new DeferredCloseSource();
    const clock = new FakeClock();
    const coordinator = new GraphWatchCoordinator(root, async () => {}, () => {}, { eventSource: source, clock });

    await coordinator.start();
    source.fail();
    clock.flush();
    expect(source.closes).toBe(1);

    let closed = false;
    const closing = coordinator.close().then(() => { closed = true; });
    expect(source.closes).toBe(2);
    source.releaseClose(1);
    for (let attempt = 0; attempt < 5; attempt += 1) await Promise.resolve();
    expect(closed).toBe(false);
    source.releaseClose(0);
    await closing;

    expect(source.starts).toBe(1);
    expect(coordinator.status().state).toBe("closed");
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

  it.each([
    ["Go", "src/watch.go", "package watched\nfunc GoWatched() int { return 1 }\n", "GoWatched", "go"],
    ["Rust", "src/watch.rs", "pub fn RustWatched() -> i32 { 1 }\n", "RustWatched", "rust"],
    ["Java", "src/JavaWatched.java", "public class JavaWatched {}\n", "JavaWatched", "java"],
    ["C#", "src/CsharpWatched.cs", "public class CsharpWatched {}\n", "CsharpWatched", "csharp"],
  ] as const)("reconciles watcher events for %s source files", async (_label, relativePath, content, query, language) => {
    const root = createFixtureWorkspace(); roots.push(root);
    const source = new FakeSource(); const clock = new FakeClock();
    const app = new ContextMeshApp(root, undefined, { watcher: { eventSource: source, clock, debounceMs: 10 } });
    try {
      await app.initialize(false);
      const generation = app.database.getWorkspace().currentGeneration;
      writeWorkspaceFile(root, relativePath, content);
      source.emit(path.join(root, relativePath));
      clock.flush();
      await generationAfter(app, generation);
      const result = (await app.searchCode({ query })).data as { results: Array<{ language: string }> };
      expect(result.results).toContainEqual(expect.objectContaining({ language }));
    } finally { await app.close(); }
  });

  it("schedules reconciliation for v0.5 language project manifests", async () => {
    const root = createFixtureWorkspace(); roots.push(root);
    const source = new FakeSource(); const clock = new FakeClock(); let calls = 0;
    const coordinator = new GraphWatchCoordinator(
      root,
      async () => { calls += 1; },
      () => {},
      { eventSource: source, clock, debounceMs: 10 },
    );
    await coordinator.start();
    expect(calls).toBe(1);
    source.emit(
      path.join(root, "go.mod"),
      path.join(root, "Cargo.toml"),
      path.join(root, "pom.xml"),
      path.join(root, "build.gradle.kts"),
      path.join(root, "fixture.csproj"),
    );
    clock.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
    await coordinator.close();
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

  it("keeps cached payloads immutable, trace-compatible, and generation-current across readers", async () => {
    const root = createFixtureWorkspace(); roots.push(root);
    writeWorkspaceFile(root, "src/cache.ts", "export function cachedAlpha(){ return 1 }\nexport function cachedCaller(){ return cachedAlpha() }\n");
    const reader = new ContextMeshApp(root);
    try {
      await reader.indexWorkspace({ mode: "full" });
      const first = await reader.searchCode({ query: "cachedAlpha" });
      const firstData = first.data as { results: Array<{ id: string; name: string }> };
      const symbolId = firstData.results[0]!.id;
      expect(reader.code.trace({ symbolId, direction: "both", depth: 2, limit: 100 }))
        .toEqual(reader.database.traceCode(symbolId, "both", undefined, 2, 100));
      firstData.results[0]!.name = "caller-mutated";
      const repeated = (await reader.searchCode({ query: "cachedAlpha" })).data as { results: Array<{ name: string }> };
      expect(repeated.results[0]?.name).toBe("cachedAlpha");

      writeWorkspaceFile(root, "src/cache.ts", "export function cachedBeta(){ return 2 }\n");
      const writer = new ContextMeshApp(root);
      try { await writer.indexWorkspace({ mode: "full" }); }
      finally { await writer.close(); }
      const staleQuery = await reader.searchCode({ query: "cachedAlpha" });
      const freshQuery = await reader.searchCode({ query: "cachedBeta" });
      expect(staleQuery.generation).toBe(reader.database.getWorkspace().currentGeneration);
      expect((staleQuery.data as { results: unknown[] }).results).toHaveLength(0);
      expect((freshQuery.data as { results: unknown[] }).results).toHaveLength(1);
    } finally { await reader.close(); }
  });
});
