import { performance } from "node:perf_hooks";

export interface DisposablePipeline {
  dispose(): Promise<void>;
}

interface PipelineGeneration<T extends DisposablePipeline> {
  generation: number;
  value: T;
  activeUses: number;
  retiring: boolean;
  disposePromise: Promise<void> | null;
  idleWaiters: Array<() => void>;
}

export interface PipelineReference<T extends DisposablePipeline> {
  readonly generation: number;
  readonly value: T;
  retire(): void;
  release(): Promise<void>;
}

export class PipelineCooldownError extends Error {
  constructor() {
    super("Semantic query pipeline is cooling down");
    this.name = "PipelineCooldownError";
  }
}

/**
 * Reference-counted, generation-fenced lifecycle for a shared inference
 * pipeline. Retiring an instance prevents new users immediately, while actual
 * async disposal waits for every already-running inference to release it.
 */
export class PipelineLifecycle<T extends DisposablePipeline> {
  private current: PipelineGeneration<T> | null = null;
  private readonly retiring = new Set<PipelineGeneration<T>>();
  private creation: Promise<PipelineGeneration<T>> | null = null;
  private nextGeneration = 1;
  private closed = false;
  private cooldownUntil = 0;

  constructor(
    private readonly factory: () => Promise<T>,
    private readonly cooldownMs = 5_000,
    private readonly now: () => number = () => performance.now(),
  ) {}

  peek(): T | null {
    return this.current?.value ?? null;
  }

  private async disposeWhenIdle(instance: PipelineGeneration<T>): Promise<void> {
    if (instance.disposePromise) return instance.disposePromise;
    instance.disposePromise = (async () => {
      if (instance.activeUses > 0) {
        await new Promise<void>((resolve) => instance.idleWaiters.push(resolve));
      }
      await instance.value.dispose();
      this.retiring.delete(instance);
    })();
    return instance.disposePromise;
  }

  private retireInstance(instance: PipelineGeneration<T>, withCooldown: boolean): void {
    if (instance.retiring) return;
    instance.retiring = true;
    if (this.current?.generation === instance.generation) this.current = null;
    this.retiring.add(instance);
    if (withCooldown) this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + this.cooldownMs);
    void this.disposeWhenIdle(instance);
  }

  private async createGeneration(): Promise<PipelineGeneration<T>> {
    const generation = this.nextGeneration++;
    const value = await this.factory();
    const instance: PipelineGeneration<T> = {
      generation,
      value,
      activeUses: 0,
      retiring: false,
      disposePromise: null,
      idleWaiters: [],
    };
    if (this.closed || generation !== this.nextGeneration - 1) {
      instance.retiring = true;
      this.retiring.add(instance);
      await this.disposeWhenIdle(instance);
      throw new Error("Semantic pipeline generation was superseded during creation");
    }
    this.current = instance;
    this.cooldownUntil = 0;
    return instance;
  }

  async acquire(options: { respectCooldown?: boolean } = {}): Promise<PipelineReference<T>> {
    if (this.closed) throw new Error("Semantic pipeline lifecycle is closed");
    if (options.respectCooldown && this.cooldownUntil > this.now()) throw new PipelineCooldownError();
    let instance = this.current;
    if (!instance || instance.retiring) {
      this.creation ??= this.createGeneration().finally(() => {
        this.creation = null;
      });
      try {
        instance = await this.creation;
      } catch (error) {
        if (options.respectCooldown) {
          this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + this.cooldownMs);
        }
        throw error;
      }
    }
    if (this.closed || instance.retiring || this.current?.generation !== instance.generation) {
      throw new Error("Semantic pipeline generation changed before acquisition");
    }
    instance.activeUses += 1;
    let released = false;
    return {
      generation: instance.generation,
      value: instance.value,
      retire: () => this.retireInstance(instance!, true),
      release: async () => {
        if (released) return;
        released = true;
        instance!.activeUses -= 1;
        if (instance!.activeUses === 0) {
          const waiters = instance!.idleWaiters.splice(0);
          for (const waiter of waiters) waiter();
        }
        if (instance!.retiring) await this.disposeWhenIdle(instance!);
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const creating = this.creation;
    if (creating) {
      try {
        const instance = await creating;
        this.retireInstance(instance, false);
      } catch {
        // Failed creation has no pipeline to dispose.
      }
    }
    if (this.current) this.retireInstance(this.current, false);
    await Promise.all([...this.retiring].map((instance) => this.disposeWhenIdle(instance)));
  }
}
