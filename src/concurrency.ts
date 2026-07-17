import { AsyncLocalStorage } from "node:async_hooks";

import { ContextMeshError } from "./errors.js";

/** A small FIFO mutex with explicit same-flow re-entry detection. */
export class AsyncMutex {
  private readonly owner = new AsyncLocalStorage<boolean>();
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.owner.getStore()) {
      throw new ContextMeshError("INTERNAL_ERROR", "Mutex re-entry was refused");
    }

    let release = (): void => undefined;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => turn, () => turn);
    await previous;
    try {
      return await this.owner.run(true, operation);
    } finally {
      release();
    }
  }
}
