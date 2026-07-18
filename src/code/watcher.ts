import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import path from "node:path";

import { graphKernelExecutablePath, GRAPH_KERNEL_PROTOCOL } from "./native-kernel.js";

export interface WatchEvent { paths: string[]; kind: string }
export interface WatchEventSource {
  start(rootPath: string, onEvent: (event: WatchEvent) => void, onError: (error: Error) => void): Promise<void>;
  close(): Promise<void>;
}
export interface WatchClock {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface WatcherOptions {
  debounceMs?: number; maxQueuedPaths?: number; maxRetries?: number; eventSource?: WatchEventSource; clock?: WatchClock;
}

const systemClock: WatchClock = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export class NativeWatchEventSource implements WatchEventSource {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private closing = false;

  async start(rootPath: string, onEvent: (event: WatchEvent) => void, onError: (error: Error) => void): Promise<void> {
    this.closing = false;
    const executable = graphKernelExecutablePath();
    if (!executable) throw new Error("WATCH_KERNEL_UNAVAILABLE: graph-kernel executable not found");
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    let settled = false;
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => { if (this.closing) return; if (!settled) { settled = true; reject(error); } else onError(error); };
      child.once("error", fail);
      child.once("exit", (code) => fail(new Error(`WATCH_KERNEL_EXITED: ${code ?? "signal"}`)));
      child.stderr.on("data", (chunk: Buffer) => onError(new Error(`WATCH_KERNEL_STDERR: ${chunk.toString("utf8").slice(0, 500)}`)));
      this.lines!.on("line", (line) => {
        try {
          const message = JSON.parse(line) as { protocol: string; status: string; data?: { paths?: string[]; kind?: string }; diagnostics?: Array<{ code: string; message: string }> };
          if (message.protocol !== GRAPH_KERNEL_PROTOCOL) return fail(new Error(`WATCH_PROTOCOL_MISMATCH: ${message.protocol}`));
          if (message.status === "ready") { if (!settled) { settled = true; resolve(); } return; }
          if (message.status === "event") { onEvent({ paths: [...(message.data?.paths ?? [])].sort(), kind: message.data?.kind ?? "Other" }); return; }
          if (message.status === "error") fail(new Error(message.diagnostics?.map((item) => `${item.code}: ${item.message}`).join("; ") ?? "WATCH_FAILED"));
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      });
      child.stdin.write(`${JSON.stringify({ operation: "watch", requestId: "watch", rootPath })}\n`);
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    this.lines?.close(); this.lines = null;
    this.child?.stdin.end(); this.child?.kill(); this.child = null;
  }
}

export class GraphWatchCoordinator {
  private readonly source: WatchEventSource;
  private readonly clock: WatchClock;
  private readonly queued = new Set<string>();
  private timer: unknown = null;
  private indexing = false;
  private closed = false;
  private retries = 0;
  private overflowed = false;
  private sourceRetries = 0;
  private sourceRetryTimer: unknown = null;
  private batchCompletion: Promise<void> | null = null;
  private completeBatch: (() => void) | null = null;

  constructor(
    private readonly rootPath: string,
    private readonly index: () => Promise<void>,
    private readonly recordFailure: (diagnostic: string) => void,
    private readonly options: WatcherOptions = {},
  ) {
    this.source = options.eventSource ?? new NativeWatchEventSource();
    this.clock = options.clock ?? systemClock;
  }

  async start(): Promise<void> {
    try { await this.startSource(); }
    catch (error) { this.recordFailure(`WATCH_START_FAILED: ${error instanceof Error ? error.message : String(error)}`); throw error; }
    // A strict reconciliation closes the event-loss window between the durable baseline and watcher startup.
    await this.runBatch();
  }

  private async startSource(): Promise<void> {
    await this.source.start(this.rootPath, (event) => this.enqueue(event), (error) => this.handleError(error));
    this.sourceRetries = 0;
  }

  private enqueue(event: WatchEvent): void {
    if (this.closed) return;
    for (const item of event.paths.sort()) {
      if (!this.isRelevant(item)) continue;
      if (this.queued.size >= (this.options.maxQueuedPaths ?? 4096)) { this.overflowed = true; break; }
      this.queued.add(item);
    }
    this.schedule();
  }

  private isRelevant(absolutePath: string): boolean {
    const relative = path.relative(this.rootPath, absolutePath).replaceAll("\\", "/");
    if (relative.startsWith("../") || path.isAbsolute(relative)) return false;
    const lower = relative.toLocaleLowerCase("en-US");
    if (lower.split("/").some((part) => [".contextmesh", ".git", "node_modules", "dist", "target"].includes(part))) return false;
    if (/(^|\/)\.env(?:\.|$)/i.test(lower) || /(?:secret|credential|private[-_.]?key)/i.test(lower)) return false;
    const basename = path.posix.basename(lower);
    return ["tsconfig.json", "jsconfig.json", "pyproject.toml"].includes(basename) || /\.(?:ts|tsx|js|jsx|mjs|cjs|py)$/.test(lower);
  }

  private schedule(delay = this.options.debounceMs ?? 75): void {
    if (this.timer !== null || this.closed) return;
    this.timer = this.clock.setTimeout(() => { this.timer = null; void this.runBatch(); }, delay);
  }

  private async runBatch(): Promise<void> {
    if (this.indexing || this.closed) return;
    if (this.overflowed) {
      this.overflowed = false; this.queued.clear();
      this.recordFailure("WATCH_QUEUE_OVERFLOW: bounded queue overflow; running full durable reconciliation");
    } else this.queued.clear();
    this.indexing = true;
    this.batchCompletion = new Promise<void>((resolve) => { this.completeBatch = resolve; });
    try { await this.index(); this.retries = 0; }
    catch (error) {
      this.retries += 1;
      const diagnostic = `WATCH_INDEX_FAILED: ${error instanceof Error ? error.message : String(error)}`;
      this.recordFailure(diagnostic);
      if (this.retries <= (this.options.maxRetries ?? 3)) this.schedule(Math.min(1000, 50 * 2 ** (this.retries - 1)));
    } finally {
      this.indexing = false;
      this.completeBatch?.(); this.completeBatch = null; this.batchCompletion = null;
      if (this.queued.size > 0 || this.overflowed) this.schedule(0);
    }
  }

  private handleError(error: Error): void {
    this.recordFailure(`WATCH_SOURCE_FAILED: ${error.message}`);
    this.sourceRetries += 1;
    if (this.closed || this.sourceRetries > (this.options.maxRetries ?? 3) || this.sourceRetryTimer !== null) return;
    this.sourceRetryTimer = this.clock.setTimeout(() => {
      this.sourceRetryTimer = null;
      void this.source.close().then(() => this.startSource()).then(() => this.runBatch()).catch((next) => this.handleError(next instanceof Error ? next : new Error(String(next))));
    }, Math.min(1000, 50 * 2 ** (this.sourceRetries - 1)));
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) { this.clock.clearTimeout(this.timer); this.timer = null; }
    if (this.sourceRetryTimer !== null) { this.clock.clearTimeout(this.sourceRetryTimer); this.sourceRetryTimer = null; }
    await this.source.close();
    await this.batchCompletion;
  }
}
