import { ZodError } from "zod";

import {
  forgetSchema,
  getContextSchema,
  indexWorkspaceSchema,
  recallSchema,
  reflectSchema,
  rememberSchema,
  searchCodeSchema,
  traceCodeSchema,
  type Envelope,
  type ForgetInput,
  type GetContextInput,
  type IndexWorkspaceInput,
  type MemoryFragmentRecord,
  type RecallInput,
  type ReflectInput,
  type RememberInput,
  type SearchCodeInput,
  type TraceCodeInput,
} from "./contracts.js";
import { CodeService, INDEX_STALE_WARNING } from "./code/service.js";
import {
  ContextAssembler,
  type AssembledContext,
  type ContextCodeItem,
  type ContextMemoryItem,
} from "./context/assembler.js";
import { asContextMeshError, ContextMeshError } from "./errors.js";
import { MemoryService } from "./memory/service.js";
import {
  ContextMeshDatabase,
  type MemoryCodeProvenance,
  type TraceEdgeResult,
} from "./storage/database.js";
import { envelopeFits, stabilizeEnvelope, type EnvelopeScope } from "./token-budget.js";
import { nowIso } from "./utils.js";
import type { FreshnessMode, RequestGenerationState } from "./code/indexer.js";

const QUERY_TRUNCATED_WARNING = "QUERY_TRUNCATED";
const PAGINATION_STALLED_WARNING = "PAGINATION_STALLED";

interface RecallMemoryItem extends MemoryFragmentRecord {
  untrusted: true;
  provenance: {
    sessionId: string | null;
    codeLinks: MemoryCodeProvenance[];
    codeLinksOmitted: number;
  };
}

interface RecallData {
  query: string | null;
  fragments: RecallMemoryItem[];
  nextOffset: number | null;
}

interface ContextData {
  query: string;
  code: ContextCodeItem[];
  memories: ContextMemoryItem[];
  relationships: TraceEdgeResult[];
}

function validate<T>(schema: { parse(input: unknown): T }, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ContextMeshError("INVALID_ARGUMENT", "Invalid tool arguments", error.flatten());
    }
    throw error;
  }
}

export class ContextMeshApp {
  readonly database: ContextMeshDatabase;
  readonly code: CodeService;
  readonly memory: MemoryService;
  readonly context: ContextAssembler;
  private activeIndex: Promise<Envelope<unknown>> | null = null;

  constructor(
    rootPath: string,
    databasePath?: string,
    options: { freshnessMode?: FreshnessMode } = {},
  ) {
    this.database = new ContextMeshDatabase(rootPath, databasePath);
    this.code = new CodeService(this.database, options.freshnessMode ?? "fast");
    this.memory = new MemoryService(this.database);
    this.context = new ContextAssembler(this.database, this.code.indexer);
  }

  async initialize(autoIndex = false): Promise<void> {
    if (!autoIndex) {
      await this.code.indexer.verifyStartup();
      return;
    }
    try {
      await this.indexWorkspace({ mode: "incremental" });
    } catch (error) {
      console.error(`[ContextMesh] Automatic indexing failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  close(): void {
    this.code.indexer.dispose();
    this.database.close();
  }

  private scope(generation = this.database.getWorkspace().currentGeneration): EnvelopeScope {
    return {
      workspaceId: this.database.workspace.id,
      generation,
    };
  }

  private envelope<T>(data: T, options: { warnings?: string[]; truncated?: boolean } = {}): Envelope<T> {
    return stabilizeEnvelope(this.scope(), data, options.warnings ?? [], options.truncated ?? false);
  }

  private packOutputQuery<T>(
    scope: EnvelopeScope,
    query: string,
    tokenBudget: number,
    data: T,
    withQuery: (data: T, query: string) => T,
    warnings: string[],
  ): { data: T; warnings: string[]; truncated: boolean } {
    const warningsWithoutQueryTruncation = warnings.filter((warning) => warning !== QUERY_TRUNCATED_WARNING);
    const fullQueryData = withQuery(data, query);
    if (envelopeFits(scope, fullQueryData, warningsWithoutQueryTruncation, false, tokenBudget)) {
      return { data: fullQueryData, warnings: warningsWithoutQueryTruncation, truncated: false };
    }

    const nextWarnings = [...new Set([...warnings, QUERY_TRUNCATED_WARNING])];
    const emptyQueryData = withQuery(data, "");
    if (!envelopeFits(scope, emptyQueryData, nextWarnings, false, tokenBudget)) {
      throw new ContextMeshError(
        "INVALID_ARGUMENT",
        "tokenBudget is smaller than the minimum response envelope",
        { tokenBudget },
      );
    }

    const characters = Array.from(query);
    let low = 0;
    let high = Math.max(0, characters.length - 1);
    let best = "";
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = middle === 0 ? "" : `${characters.slice(0, middle).join("")}…`;
      if (envelopeFits(scope, withQuery(data, candidate), nextWarnings, false, tokenBudget)) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return { data: withQuery(data, best), warnings: nextWarnings, truncated: true };
  }

  async indexWorkspace(input: unknown): Promise<Envelope<unknown>> {
    const parsed = validate<IndexWorkspaceInput>(indexWorkspaceSchema, input);
    if (this.activeIndex) return this.activeIndex;
    this.activeIndex = Promise.resolve().then(async () => {
      const result = await this.code.index(parsed.mode);
      return this.envelope(result, { warnings: result.diagnostics });
    });
    try {
      return await this.activeIndex;
    } finally {
      this.activeIndex = null;
    }
  }

  async workspaceStatus(): Promise<Envelope<unknown>> {
    return this.envelope(await this.code.status());
  }

  private async graphReadAttempt<T>(
    collect: () => T,
  ): Promise<{
    value: T;
    snapshot: RequestGenerationState;
    stale: boolean;
    generationChanged: boolean;
  }> {
    const initial = await this.code.freshnessState();
    const snapshotResult = await this.database.withReadSnapshot(() => {
      const state = this.database.getFreshnessState();
      const snapshot: RequestGenerationState = {
        generation: state.currentGeneration,
        successFence: state.successFenceGeneration,
        stale: state.stale,
      };
      return { snapshot, value: collect() };
    });
    const final = await this.code.indexer.readFinalRequestState();
    const generationChanged =
      initial.generation !== snapshotResult.snapshot.generation ||
      initial.successFence !== snapshotResult.snapshot.successFence ||
      final.generation !== snapshotResult.snapshot.generation ||
      final.successFence !== snapshotResult.snapshot.successFence;
    return {
      ...snapshotResult,
      stale: initial.stale || snapshotResult.snapshot.stale || final.stale,
      generationChanged,
    };
  }

  async searchCode(input: unknown): Promise<Envelope<unknown>> {
    const parsed = validate<SearchCodeInput>(searchCodeSchema, input);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const read = await this.graphReadAttempt(() => this.code.search(parsed));
      if (read.generationChanged && attempt === 0) continue;
      return stabilizeEnvelope(
        this.scope(read.snapshot.generation),
        { results: read.value.results, nextOffset: read.value.nextOffset },
        read.stale || read.generationChanged ? [INDEX_STALE_WARNING] : [],
        read.value.truncated || read.generationChanged,
      );
    }
    throw new ContextMeshError("INTERNAL_ERROR", "Code search retry did not produce a result");
  }

  async traceCode(input: unknown): Promise<Envelope<unknown>> {
    const parsed = validate<TraceCodeInput>(traceCodeSchema, input);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const read = await this.graphReadAttempt(() => this.code.trace(parsed));
      if (read.generationChanged && attempt === 0) continue;
      return stabilizeEnvelope(
        this.scope(read.snapshot.generation),
        read.value,
        [
          ...(read.stale || read.generationChanged
            ? [INDEX_STALE_WARNING]
            : []),
          ...(read.value.unresolved.length > 0
            ? [`${read.value.unresolved.length} unresolved reference(s)`]
            : []),
        ],
        read.value.truncated || read.generationChanged,
      );
    }
    throw new ContextMeshError("INTERNAL_ERROR", "Code trace retry did not produce a result");
  }

  remember(input: unknown): Envelope<unknown> {
    const parsed = validate<RememberInput>(rememberSchema, input);
    const result = this.memory.remember(parsed);
    return this.envelope({ fragment: result.fragment, duplicate: result.duplicate }, { warnings: result.warnings });
  }

  recall(input: unknown): Envelope<unknown> {
    const parsed = validate<RecallInput>(recallSchema, input);
    const scope = this.scope();
    const result = this.memory.recall(parsed);
    const allFragments = [...result.anchors, ...result.fragments];
    const provenance = this.database.getMemoryCodeProvenance(allFragments.map((fragment) => fragment.id));
    const accessTimestamp = nowIso();
    const prepareCandidate = (fragment: MemoryFragmentRecord): RecallMemoryItem => {
      const codeLinks = provenance.get(fragment.id) ?? [];
      return {
        ...fragment,
        accessCount: fragment.accessCount + 1,
        lastAccessedAt: accessTimestamp,
        untrusted: true,
        provenance: {
          sessionId: fragment.sessionId,
          codeLinks: [],
          codeLinksOmitted: codeLinks.length,
        },
      };
    };
    const anchorCandidates = result.anchors.map(prepareCandidate);
    const generalCandidates = result.fragments.map(prepareCandidate);

    const reservedNextOffset = generalCandidates.length > 0 ? parsed.offset + parsed.limit : result.nextOffset;
    let data: RecallData = {
      query: parsed.query ? "" : null,
      fragments: [],
      nextOffset: reservedNextOffset,
    };
    let warnings = parsed.query ? [QUERY_TRUNCATED_WARNING] : [];
    if (!envelopeFits(scope, data, warnings, false, parsed.tokenBudget)) {
      throw new ContextMeshError("INVALID_ARGUMENT", "tokenBudget is smaller than the minimum response envelope", {
        tokenBudget: parsed.tokenBudget,
      });
    }

    let anchorOmitted = false;
    for (const candidate of anchorCandidates) {
      const tentative = { ...data, fragments: [...data.fragments, candidate] };
      if (envelopeFits(scope, tentative, warnings, false, parsed.tokenBudget)) data = tentative;
      else anchorOmitted = true;
    }
    const selectedAnchorCount = data.fragments.length;

    let includedGeneralCount = 0;
    let generalOmitted = false;
    for (const candidate of generalCandidates) {
      const tentative = { ...data, fragments: [...data.fragments, candidate] };
      if (!envelopeFits(scope, tentative, warnings, false, parsed.tokenBudget)) {
        generalOmitted = true;
        break;
      }
      data = tentative;
      includedGeneralCount += 1;
    }

    const updatePagination = (): void => {
      const hasUnreturnedGeneral =
        includedGeneralCount < generalCandidates.length || result.nextOffset !== null;
      data = {
        ...data,
        nextOffset: hasUnreturnedGeneral ? parsed.offset + includedGeneralCount : null,
      };
    };
    updatePagination();
    while (!envelopeFits(scope, data, warnings, false, parsed.tokenBudget) && includedGeneralCount > 0) {
      includedGeneralCount -= 1;
      generalOmitted = true;
      data = {
        ...data,
        fragments: data.fragments.slice(0, selectedAnchorCount + includedGeneralCount),
      };
      updatePagination();
    }

    const paginationStalled =
      generalCandidates.length > 0 && includedGeneralCount === 0 && data.nextOffset === parsed.offset;
    if (paginationStalled) {
      warnings = [...new Set([...warnings, PAGINATION_STALLED_WARNING])];
      while (
        data.fragments.length > 0 &&
        !envelopeFits(scope, data, warnings, false, parsed.tokenBudget)
      ) {
        data = { ...data, fragments: data.fragments.slice(0, -1) };
        anchorOmitted = true;
      }
      if (!envelopeFits(scope, data, warnings, false, parsed.tokenBudget)) {
        throw new ContextMeshError(
          "INVALID_ARGUMENT",
          "tokenBudget is smaller than the mandatory pagination response envelope",
          { tokenBudget: parsed.tokenBudget },
        );
      }
    }

    for (let memoryIndex = 0; memoryIndex < data.fragments.length; memoryIndex += 1) {
      const memory = data.fragments[memoryIndex];
      if (!memory) continue;
      const links = provenance.get(memory.id) ?? [];
      for (const link of links) {
        const updatedMemory: RecallMemoryItem = {
          ...memory,
          provenance: {
            ...memory.provenance,
            codeLinks: [...memory.provenance.codeLinks, link],
            codeLinksOmitted: memory.provenance.codeLinksOmitted - 1,
          },
        };
        const updatedFragments = [...data.fragments];
        updatedFragments[memoryIndex] = updatedMemory;
        const tentative = { ...data, fragments: updatedFragments };
        if (envelopeFits(scope, tentative, warnings, false, parsed.tokenBudget)) {
          data = tentative;
          Object.assign(memory, updatedMemory);
        }
      }
    }

    let queryTruncated = false;
    if (parsed.query) {
      const packedQuery = this.packOutputQuery(
        scope,
        parsed.query,
        parsed.tokenBudget,
        data,
        (current, query) => ({ ...current, query }),
        warnings,
      );
      data = packedQuery.data;
      warnings = packedQuery.warnings;
      queryTruncated = packedQuery.truncated;
    }

    const truncated =
      result.truncated ||
      queryTruncated ||
      anchorOmitted ||
      generalOmitted ||
      paginationStalled ||
      data.fragments.some((fragment) => fragment.provenance.codeLinksOmitted > 0);
    const envelope = stabilizeEnvelope(scope, data, warnings, truncated);
    if (envelope.estimatedTokens > parsed.tokenBudget) {
      throw new ContextMeshError("INTERNAL_ERROR", "Recall token packing exceeded tokenBudget");
    }
    try {
      this.memory.recordAccess(
        data.fragments.map((fragment) => fragment.id),
        parsed.query ?? null,
        accessTimestamp,
      );
    } catch (error) {
      throw asContextMeshError(error);
    }
    return envelope;
  }

  async getContext(input: unknown): Promise<Envelope<unknown>> {
    const parsed = validate<GetContextInput>(getContextSchema, input);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const initial = await this.code.freshnessState();
      const snapshotResult = await this.database.withReadSnapshot(() => {
        const state = this.database.getFreshnessState();
        const snapshot: RequestGenerationState = {
          generation: state.currentGeneration,
          successFence: state.successFenceGeneration,
          stale: state.stale,
        };
        return { snapshot, result: this.context.assembleDatabase(parsed) };
      });
      const hydrated = await this.context.hydrateSnippets(
        snapshotResult.result,
        snapshotResult.snapshot.generation,
        snapshotResult.snapshot.successFence,
      );
      const final = await this.code.indexer.readFinalRequestState();
      const generationChanged =
        hydrated.generationChanged ||
        initial.generation !== snapshotResult.snapshot.generation ||
        initial.successFence !== snapshotResult.snapshot.successFence ||
        final.generation !== snapshotResult.snapshot.generation ||
        final.successFence !== snapshotResult.snapshot.successFence;
      if (generationChanged && attempt === 0) continue;
      const stale = initial.stale || snapshotResult.snapshot.stale || final.stale || generationChanged;
      return this.packContext(
        parsed,
        hydrated.assembled,
        this.scope(snapshotResult.snapshot.generation),
        stale ? [INDEX_STALE_WARNING] : [],
        generationChanged,
      );
    }
    throw new ContextMeshError("INTERNAL_ERROR", "Context retry did not produce a result");
  }

  private packContext(
    parsed: GetContextInput,
    result: AssembledContext,
    scope: EnvelopeScope,
    staleWarnings: string[],
    forceTruncated: boolean,
  ): Envelope<unknown> {
    const accessTimestamp = nowIso();
    const provenance = new Map<string, MemoryCodeProvenance[]>();
    for (const candidate of result.candidates) {
      if (candidate.kind !== "memory") continue;
      const memory = candidate.value as ContextMemoryItem;
      provenance.set(memory.id, memory.provenance.codeLinks);
    }

    let data: ContextData = { query: "", code: [], memories: [], relationships: [] };
    let warnings = [...new Set([...staleWarnings, QUERY_TRUNCATED_WARNING])];
    if (!envelopeFits(scope, data, warnings, false, parsed.tokenBudget)) {
      throw new ContextMeshError("INVALID_ARGUMENT", "tokenBudget is smaller than the minimum response envelope", {
        tokenBudget: parsed.tokenBudget,
      });
    }

    let candidateOmitted = false;
    for (const candidate of result.candidates) {
      if (candidate.kind === "code") {
        const tentative = { ...data, code: [...data.code, candidate.value as ContextCodeItem] };
        if (envelopeFits(scope, tentative, warnings, false, parsed.tokenBudget)) data = tentative;
        else candidateOmitted = true;
        continue;
      }

      const memory = candidate.value as ContextMemoryItem;
      const links = provenance.get(memory.id) ?? [];
      const prepared: ContextMemoryItem = {
        ...memory,
        accessCount: memory.accessCount + 1,
        lastAccessedAt: accessTimestamp,
        provenance: {
          ...memory.provenance,
          codeLinks: [],
          codeLinksOmitted: links.length,
        },
      };
      const tentative = { ...data, memories: [...data.memories, prepared] };
      if (envelopeFits(scope, tentative, warnings, false, parsed.tokenBudget)) data = tentative;
      else candidateOmitted = true;
    }

    for (let memoryIndex = 0; memoryIndex < data.memories.length; memoryIndex += 1) {
      const memory = data.memories[memoryIndex];
      if (!memory) continue;
      for (const link of provenance.get(memory.id) ?? []) {
        const updatedMemory: ContextMemoryItem = {
          ...memory,
          provenance: {
            ...memory.provenance,
            codeLinks: [...memory.provenance.codeLinks, link],
            codeLinksOmitted: memory.provenance.codeLinksOmitted - 1,
          },
        };
        const updatedMemories = [...data.memories];
        updatedMemories[memoryIndex] = updatedMemory;
        const tentative = { ...data, memories: updatedMemories };
        if (envelopeFits(scope, tentative, warnings, false, parsed.tokenBudget)) {
          data = tentative;
          Object.assign(memory, updatedMemory);
        }
      }
    }

    const selectedCodeIds = new Set(data.code.map((item) => item.id));
    let relationshipOmitted = false;
    for (const relationship of result.relationships) {
      if (!selectedCodeIds.has(relationship.sourceId) || !selectedCodeIds.has(relationship.targetId)) {
        relationshipOmitted = true;
        continue;
      }
      const tentative = { ...data, relationships: [...data.relationships, relationship] };
      if (envelopeFits(scope, tentative, warnings, false, parsed.tokenBudget)) data = tentative;
      else relationshipOmitted = true;
    }

    let warningOmitted = false;
    for (const warning of result.warnings) {
      if (warnings.includes(warning)) continue;
      const tentativeWarnings = [...warnings, warning];
      if (envelopeFits(scope, data, tentativeWarnings, false, parsed.tokenBudget)) warnings = tentativeWarnings;
      else warningOmitted = true;
    }

    const packedQuery = this.packOutputQuery(
      scope,
      result.query,
      parsed.tokenBudget,
      data,
      (current, query) => ({ ...current, query }),
      warnings,
    );
    data = packedQuery.data;
    warnings = packedQuery.warnings;

    const truncated =
      forceTruncated ||
      packedQuery.truncated ||
      result.candidateTruncated ||
      warningOmitted ||
      candidateOmitted ||
      relationshipOmitted ||
      data.memories.some((memory) => memory.provenance.codeLinksOmitted > 0);
    const envelope = stabilizeEnvelope(scope, data, warnings, truncated);
    if (envelope.estimatedTokens > parsed.tokenBudget) {
      throw new ContextMeshError("INTERNAL_ERROR", "Context token packing exceeded tokenBudget");
    }
    try {
      this.memory.recordAccess(
        data.memories.map((memory) => memory.id),
        parsed.query,
        accessTimestamp,
      );
    } catch (error) {
      throw asContextMeshError(error);
    }
    return envelope;
  }

  reflect(input: unknown): Envelope<unknown> {
    const parsed = validate<ReflectInput>(reflectSchema, input);
    return this.envelope(this.memory.reflect(parsed));
  }

  forget(input: unknown): Envelope<unknown> {
    const parsed = validate<ForgetInput>(forgetSchema, input);
    return this.envelope({ fragment: this.memory.forget(parsed) });
  }

  doctor(): Envelope<unknown> {
    return this.envelope(this.database.doctor());
  }
}
