import type { ForgetInput, RecallInput, ReflectInput, RememberInput } from "../contracts.js";
import type { ContextMeshStorage } from "../storage/database.js";
import type { SemanticService } from "../semantic/service.js";
import type { SemanticSearchResult } from "../semantic/service.js";
import { hybridMemoryRecall } from "../semantic/hybrid.js";

export class MemoryService {
  private readonly database: ContextMeshStorage;
  private readonly semantic: SemanticService | null;

  constructor(database: ContextMeshStorage, semantic: SemanticService | null = null) {
    this.database = database;
    this.semantic = semantic;
  }

  async remember(input: RememberInput): Promise<ReturnType<ContextMeshStorage["remember"]>> {
    const result = this.database.remember(input);
    const semanticWarnings = await this.semantic?.embedRememberedMemory(result.semanticCapture, result.fragment);
    return { ...result, warnings: [...result.warnings, ...(semanticWarnings ?? [])] };
  }

  recall(
    input: RecallInput,
    semantic: SemanticSearchResult | null = null,
  ): ReturnType<ContextMeshStorage["recall"]> {
    return hybridMemoryRecall(this.database, input, semantic);
  }

  recordAccess(memoryIds: string[], query: string | null, timestamp: string): void {
    this.database.recordMemoryAccess(memoryIds, query, timestamp);
  }

  async reflect(
    input: ReflectInput,
  ): Promise<ReturnType<ContextMeshStorage["reflect"]> & { warnings: string[] }> {
    const result = this.database.reflect(input);
    const semanticWarnings = await this.semantic?.embedReflectedMemories(
      result.semanticCaptures,
      [result.episode, ...result.learnings],
    );
    return { ...result, warnings: semanticWarnings ?? [] };
  }

  forget(input: ForgetInput): ReturnType<ContextMeshStorage["forget"]> {
    return this.database.forget(input);
  }
}
