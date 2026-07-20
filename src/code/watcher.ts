import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";

import {
  graphKernelLaunchSpec,
  GRAPH_KERNEL_PROTOCOL,
  validateGraphKernelHello,
  type GraphKernelLaunch,
} from "./native-kernel.js";

export interface WatchEvent {
  paths: string[];
  kind: string;
}

export interface WatchEventSource {
  start(rootPath: string, onEvent: (event: WatchEvent) => void, onError: (error: Error) => void): Promise<void>;
  close(): Promise<void>;
}

export interface WatchClock {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WatcherOptions {
  debounceMs?: number;
  maxQueuedPaths?: number;
  maxRetries?: number;
  eventSource?: WatchEventSource;
  clock?: WatchClock;
}

export interface WatcherStatus {
  enabled: true;
  mode: "native-opt-in";
  state: "starting" | "watching" | "degraded" | "failed" | "closed";
  queuedPaths: number;
  indexing: boolean;
  indexRetries: number;
  sourceRetries: number;
  lastDiagnostic: string | null;
}

const systemClock: WatchClock = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class NativeWatchEventSource implements WatchEventSource {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private closing = false;

  constructor(private readonly launchOverride?: GraphKernelLaunch) {}

  async start(rootPath: string, onEvent: (event: WatchEvent) => void, onError: (error: Error) => void): Promise<void> {
    this.closing = false;
    const launch = this.launchOverride ?? graphKernelLaunchSpec();
    if (!launch) throw new Error("WATCH_KERNEL_UNAVAILABLE: graph-kernel executable not found");
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.executable, launch.args ?? [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      throw new Error(`WATCH_KERNEL_SPAWN_FAILED: ${message(error)}`);
    }
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    let settled = false;
    let failed = false;
    await new Promise<void>((resolve, reject) => {
      const readyTimeout = setTimeout(() => {
        fail(new Error(`WATCH_READY_TIMEOUT: exceeded ${launch.timeoutMs ?? 30_000}ms`));
      }, launch.timeoutMs ?? 30_000);
      const fail = (error: Error): void => {
        if (this.closing || failed) return;
        failed = true;
        clearTimeout(readyTimeout);
        child.kill();
        if (!settled) {
          settled = true;
          reject(error);
        } else {
          onError(error);
        }
      };
      const writeRequest = (payload: Record<string, unknown>): void => {
        child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
          if (error) fail(new Error(`WATCH_KERNEL_WRITE_FAILED: ${error.message}`));
        });
      };
      let helloComplete = false;
      child.once("error", (error) => fail(new Error(`WATCH_KERNEL_SPAWN_FAILED: ${error.message}`)));
      child.once("exit", (code, signal) => fail(new Error(`WATCH_KERNEL_EXITED: exit=${code ?? "null"} signal=${signal ?? "none"}`)));
      child.stderr.on("data", (chunk: Buffer) => fail(new Error(`WATCH_KERNEL_STDERR: ${chunk.toString("utf8").slice(0, 500)}`)));
      this.lines!.on("line", (line) => {
        try {
          const value = JSON.parse(line) as unknown;
          if (!value || typeof value !== "object") throw new Error("WATCH_PROTOCOL_INVALID: response is not an object");
          const response = value as {
            protocol?: unknown;
            requestId?: unknown;
            status?: unknown;
            data?: unknown;
            diagnostics?: Array<{ code?: unknown; message?: unknown }>;
          };
          if (response.protocol !== GRAPH_KERNEL_PROTOCOL) {
            return fail(new Error(`WATCH_PROTOCOL_MISMATCH: ${String(response.protocol)}`));
          }
          if (!helloComplete) {
            if (response.requestId !== "hello") {
              return fail(new Error(`WATCH_REQUEST_ID_MISMATCH: expected hello, received ${String(response.requestId)}`));
            }
            if (response.status === "error") {
              const details = response.diagnostics?.map((item) => `${String(item.code)}: ${String(item.message)}`).join("; ");
              return fail(new Error(details || "WATCH_HELLO_FAILED"));
            }
            if (response.status !== "ok") {
              return fail(new Error(`WATCH_PROTOCOL_INVALID: unexpected hello status ${String(response.status)}`));
            }
            try {
              validateGraphKernelHello(response.data, "WATCH_KERNEL");
            } catch (error) {
              return fail(error instanceof Error ? error : new Error(message(error)));
            }
            helloComplete = true;
            writeRequest({ operation: "watch", requestId: "watch", rootPath });
            return;
          }
          if (response.requestId !== "watch") {
            return fail(new Error(`WATCH_REQUEST_ID_MISMATCH: ${String(response.requestId)}`));
          }
          if (response.status === "ready") {
            clearTimeout(readyTimeout);
            if (!settled) {
              settled = true;
              resolve();
            }
            return;
          }
          if (response.status === "event") {
            const data = response.data as { paths?: unknown; kind?: unknown } | undefined;
            if (!Array.isArray(data?.paths)
              || data.paths.length > 100_000
              || data.paths.some((item) => typeof item !== "string" || item.length > 4_000)
              || typeof data.kind !== "string") {
              return fail(new Error("WATCH_PROTOCOL_INVALID: malformed event payload"));
            }
            onEvent({ paths: [...data.paths].sort(), kind: data.kind });
            return;
          }
          if (response.status === "error") {
            const details = response.diagnostics?.map((item) => `${String(item.code)}: ${String(item.message)}`).join("; ");
            return fail(new Error(details || "WATCH_FAILED"));
          }
          fail(new Error(`WATCH_PROTOCOL_INVALID: unexpected status ${String(response.status)}`));
        } catch (error) {
          fail(error instanceof Error && error.message.startsWith("WATCH_")
            ? error
            : new Error(`WATCH_PROTOCOL_INVALID: ${message(error)}`));
        }
      });
      writeRequest({ operation: "hello", requestId: "hello" });
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    this.lines?.close();
    this.lines = null;
    const child = this.child;
    this.child = null;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdin.end();
    child.kill();
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }
}

export class GraphWatchCoordinator {
  private readonly source: WatchEventSource;
  private readonly clock: WatchClock;
  private readonly queued = new Set<string>();
  private timer: unknown = null;
  private indexing = false;
  private closed = false;
  private indexRetries = 0;
  private overflowed = false;
  private sourceRetries = 0;
  private sourceActive = false;
  private sourceRetryTimer: unknown = null;
  private batchCompletion: Promise<void> | null = null;
  private completeBatch: (() => void) | null = null;
  private state: WatcherStatus["state"] = "starting";
  private lastDiagnostic: string | null = null;

  constructor(
    private readonly rootPath: string,
    private readonly index: () => Promise<void>,
    private readonly recordFailure: (diagnostic: string) => void,
    private readonly options: WatcherOptions = {},
    private readonly recordRecovery: () => void = () => {},
  ) {
    this.source = options.eventSource ?? new NativeWatchEventSource();
    this.clock = options.clock ?? systemClock;
  }

  async start(): Promise<void> {
    try {
      await this.startSource();
    } catch (error) {
      this.handleSourceError(error instanceof Error ? error : new Error(String(error)));
    }
    // A strict reconciliation closes the event-loss window between the durable baseline and watcher startup.
    await this.runBatch();
  }

  status(): WatcherStatus {
    return {
      enabled: true,
      mode: "native-opt-in",
      state: this.state,
      queuedPaths: this.queued.size,
      indexing: this.indexing,
      indexRetries: this.indexRetries,
      sourceRetries: this.sourceRetries,
      lastDiagnostic: this.lastDiagnostic,
    };
  }

  private async startSource(): Promise<void> {
    this.state = "starting";
    this.sourceActive = false;
    await this.source.start(
      this.rootPath,
      (event) => {
        this.sourceActive = true;
        this.sourceRetries = 0;
        this.state = "watching";
        this.enqueue(event);
      },
      (error) => this.handleSourceError(error),
    );
    this.sourceActive = true;
    this.sourceRetries = 0;
    this.state = "watching";
  }

  private fail(diagnostic: string, terminal = false): void {
    this.lastDiagnostic = diagnostic;
    this.state = terminal ? "failed" : "degraded";
    this.recordFailure(diagnostic);
  }

  private enqueue(event: WatchEvent): void {
    if (this.closed) return;
    let accepted = false;
    for (const item of [...event.paths].sort()) {
      if (!this.isRelevant(item)) continue;
      if (this.queued.size >= (this.options.maxQueuedPaths ?? 4_096)) {
        this.overflowed = true;
        accepted = true;
        break;
      }
      this.queued.add(item);
      accepted = true;
    }
    if (accepted) this.schedule();
  }

  private isRelevant(absolutePath: string): boolean {
    const relative = path.relative(this.rootPath, absolutePath).replaceAll("\\", "/");
    if (relative.startsWith("../") || path.isAbsolute(relative)) return false;
    const lower = relative.toLocaleLowerCase("en-US");
    if (lower.split("/").some((part) => [".contextmesh", ".git", "node_modules", "dist", "target"].includes(part))) return false;
    if (/(^|\/)\.env(?:\.|$)/i.test(lower) || /(?:secret|credential|private[-_.]?key)/i.test(lower)) return false;
    const basename = path.posix.basename(lower);
    return [
      "tsconfig.json", "jsconfig.json", "pyproject.toml",
      "go.mod", "go.sum", "cargo.toml", "cargo.lock",
      "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
    ].includes(basename)
      || /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|csproj|sln)$/.test(lower);
  }

  private schedule(delay = this.options.debounceMs ?? 75): void {
    if (this.timer !== null || this.closed) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.runBatch();
    }, delay);
  }

  private async runBatch(): Promise<void> {
    if (this.indexing || this.closed) return;
    if (this.overflowed) {
      this.overflowed = false;
      this.queued.clear();
      this.fail("WATCH_QUEUE_OVERFLOW: bounded queue overflow; running full durable reconciliation");
    } else {
      this.queued.clear();
    }
    this.indexing = true;
    this.batchCompletion = new Promise<void>((resolve) => { this.completeBatch = resolve; });
    let succeeded = false;
    try {
      await this.index();
      succeeded = true;
      this.indexRetries = 0;
      if (this.sourceActive && this.sourceRetries === 0) {
        this.state = "watching";
        this.lastDiagnostic = null;
        this.recordRecovery();
      }
    } catch (error) {
      this.indexRetries += 1;
      const diagnostic = `WATCH_INDEX_FAILED: ${message(error)}`;
      this.fail(diagnostic, this.indexRetries > (this.options.maxRetries ?? 3));
      if (this.indexRetries <= (this.options.maxRetries ?? 3)) {
        this.schedule(Math.min(1_000, 50 * 2 ** (this.indexRetries - 1)));
      }
    } finally {
      this.indexing = false;
      this.completeBatch?.();
      this.completeBatch = null;
      this.batchCompletion = null;
      if (succeeded && (this.queued.size > 0 || this.overflowed)) this.schedule(0);
    }
  }

  private handleSourceError(error: Error): void {
    if (this.closed) return;
    this.sourceActive = false;
    if (this.sourceRetryTimer !== null) return;
    const diagnostic = `WATCH_SOURCE_FAILED: ${error.message}`;
    if (this.sourceRetries >= (this.options.maxRetries ?? 3)) {
      this.fail(diagnostic, true);
      return;
    }
    this.sourceRetries += 1;
    this.fail(diagnostic);
    this.sourceRetryTimer = this.clock.setTimeout(() => {
      this.sourceRetryTimer = null;
      void this.source.close()
        .then(() => this.startSource())
        .then(() => this.runBatch())
        .catch((next) => this.handleSourceError(next instanceof Error ? next : new Error(String(next))));
    }, Math.min(1_000, 50 * 2 ** (this.sourceRetries - 1)));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.sourceActive = false;
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.sourceRetryTimer !== null) {
      this.clock.clearTimeout(this.sourceRetryTimer);
      this.sourceRetryTimer = null;
    }
    await this.source.close();
    await this.batchCompletion;
    this.state = "closed";
  }
}
