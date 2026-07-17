import type { ForgetInput, RecallInput, ReflectInput, RememberInput } from "../contracts.js";
import type { ContextMeshStorage } from "../storage/database.js";

export class MemoryService {
  private readonly database: ContextMeshStorage;

  constructor(database: ContextMeshStorage) {
    this.database = database;
  }

  remember(input: RememberInput): ReturnType<ContextMeshStorage["remember"]> {
    return this.database.remember(input);
  }

  recall(input: RecallInput): ReturnType<ContextMeshStorage["recall"]> {
    return this.database.recall(input);
  }

  recordAccess(memoryIds: string[], query: string | null, timestamp: string): void {
    this.database.recordMemoryAccess(memoryIds, query, timestamp);
  }

  reflect(input: ReflectInput): ReturnType<ContextMeshStorage["reflect"]> {
    return this.database.reflect(input);
  }

  forget(input: ForgetInput): ReturnType<ContextMeshStorage["forget"]> {
    return this.database.forget(input);
  }
}
