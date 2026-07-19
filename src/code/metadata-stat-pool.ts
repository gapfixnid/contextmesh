import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";

export interface MetadataStatResult {
  isFile: boolean;
  sizeBytes: number;
  mtimeMs: number;
  error: string | null;
}

export interface MetadataStatPoolOptions {
  workers?: number;
  timeoutMs?: number;
  workerSource?: string;
}

interface WorkerSlot {
  worker: Worker;
  failed: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_WORKERS = 4;
const WORKER_SOURCE = String.raw`
const { lstatSync } = require("node:fs");
const { parentPort } = require("node:worker_threads");
parentPort.on("message", ({ requestId, paths }) => {
  const stats = paths.map((absolutePath) => {
    try {
      const value = lstatSync(absolutePath);
      return {
        isFile: value.isFile(),
        sizeBytes: value.size,
        mtimeMs: value.mtimeMs,
        error: null,
      };
    } catch (error) {
      return {
        isFile: false,
        sizeBytes: 0,
        mtimeMs: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  parentPort.postMessage({ requestId, stats });
});
`;

function validStat(value: unknown): value is MetadataStatResult {
  if (!value || typeof value !== "object") return false;
  const stat = value as Partial<MetadataStatResult>;
  return typeof stat.isFile === "boolean"
    && Number.isSafeInteger(stat.sizeBytes)
    && stat.sizeBytes! >= 0
    && typeof stat.mtimeMs === "number"
    && Number.isFinite(stat.mtimeMs)
    && (stat.error === null || typeof stat.error === "string" && stat.error.length <= 4_000);
}

export class MetadataStatPool {
  private readonly workerCount: number;
  private readonly timeoutMs: number;
  private readonly workerSource: string;
  private slots: WorkerSlot[] = [];
  private requestId = 0;
  private closed = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: MetadataStatPoolOptions = {}) {
    this.workerCount = Math.max(
      1,
      Math.min(MAX_WORKERS, options.workers ?? availableParallelism()),
    );
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.workerSource = options.workerSource ?? WORKER_SOURCE;
  }

  inspect(paths: readonly string[]): Promise<MetadataStatResult[]> {
    const operation = this.tail.then(() => this.inspectUnlocked(paths));
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  dispose(): void {
    this.closed = true;
    this.resetWorkers();
  }

  private async inspectUnlocked(paths: readonly string[]): Promise<MetadataStatResult[]> {
    if (this.closed) throw new Error("METADATA_STAT_POOL_CLOSED");
    if (paths.length === 0) return [];
    this.ensureWorkers();
    const requestId = ++this.requestId;
    try {
      const chunks = await Promise.all(this.slots.map((slot, index) => {
        const start = Math.floor(paths.length * index / this.slots.length);
        const end = Math.floor(paths.length * (index + 1) / this.slots.length);
        return this.dispatch(slot, requestId, paths.slice(start, end));
      }));
      return chunks.flat();
    } catch (error) {
      this.resetWorkers();
      throw error;
    }
  }

  private ensureWorkers(): void {
    if (this.slots.length === this.workerCount && this.slots.every((slot) => !slot.failed)) return;
    this.resetWorkers();
    this.slots = Array.from({ length: this.workerCount }, () => {
      const slot: WorkerSlot = {
        worker: new Worker(this.workerSource, { eval: true }),
        failed: false,
      };
      slot.worker.unref();
      slot.worker.on("error", () => { slot.failed = true; });
      slot.worker.on("exit", () => { slot.failed = true; });
      return slot;
    });
  }

  private dispatch(
    slot: WorkerSlot,
    requestId: number,
    paths: readonly string[],
  ): Promise<MetadataStatResult[]> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, result?: MetadataStatResult[]): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        slot.worker.off("message", onMessage);
        slot.worker.off("error", onError);
        slot.worker.off("exit", onExit);
        if (error) reject(error);
        else resolve(result ?? []);
      };
      const onMessage = (value: unknown): void => {
        if (!value || typeof value !== "object") {
          finish(new Error("METADATA_STAT_PROTOCOL_INVALID: response is not an object"));
          return;
        }
        const response = value as { requestId?: unknown; stats?: unknown };
        if (response.requestId !== requestId
          || !Array.isArray(response.stats)
          || response.stats.length !== paths.length
          || !response.stats.every(validStat)) {
          finish(new Error("METADATA_STAT_PROTOCOL_INVALID: response schema mismatch"));
          return;
        }
        finish(null, response.stats);
      };
      const onError = (error: Error): void => {
        finish(new Error(`METADATA_STAT_WORKER_FAILED: ${error.message}`));
      };
      const onExit = (code: number): void => {
        finish(new Error(`METADATA_STAT_WORKER_EXITED: exit=${code}`));
      };
      const timeout = setTimeout(() => {
        slot.failed = true;
        void slot.worker.terminate();
        finish(new Error(`METADATA_STAT_TIMEOUT: exceeded ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timeout.unref();
      slot.worker.once("message", onMessage);
      slot.worker.once("error", onError);
      slot.worker.once("exit", onExit);
      try {
        slot.worker.postMessage({ requestId, paths });
      } catch (error) {
        finish(new Error(
          `METADATA_STAT_WORKER_FAILED: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    });
  }

  private resetWorkers(): void {
    for (const slot of this.slots) void slot.worker.terminate();
    this.slots = [];
  }
}
