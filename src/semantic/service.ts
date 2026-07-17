import type {
  CodeNodeKind,
  ExtractedGraph,
  MemoryFragmentRecord,
  MemoryType,
} from "../contracts.js";
import type {
  ContextMeshStorage,
  MemorySemanticCapture,
  SemanticCommitEntry,
  SemanticPlaneCommit,
  SemanticStateRecord,
  StoredSemanticEmbedding,
} from "../storage/database.js";
import { buildCodeSemanticDocument, buildMemorySemanticDocument, type SemanticDocument } from "./documents.js";
import type {
  EmbeddingBackend,
  EmbeddingBackendFactory,
  SemanticPlane,
  SemanticRuntimeDiagnostics,
} from "./backend.js";
import {
  APPROVED_MODEL_KEY,
  APPROVED_MODEL_MANIFEST,
  canonicalJson,
} from "./manifest.js";
import { createTransformersEmbeddingBackend } from "./transformers-backend.js";
import {
  decodeVectorInto,
  encodeVector,
  validateEncodedVector,
  VECTOR_CODEC,
} from "./vector-codec.js";
import {
  encodeEntityIds,
  scanNormalizedMatrix,
  writeSha256Hex,
  type EncodedEntityIds,
} from "./exact-scan.js";

export const MAX_EXACT_SCAN_ENTITIES = 50_000;
const EMBEDDING_BATCH_SIZE = 32;

export const SEMANTIC_UNAVAILABLE_WARNING = "SEMANTIC_UNAVAILABLE";
export const SEMANTIC_PARTIAL_WARNING = "SEMANTIC_PARTIAL";

export interface SemanticCandidate {
  id: string;
  score: number;
  vector: Float32Array;
}

export interface SemanticSearchResult {
  candidates: SemanticCandidate[];
  warnings: string[];
  eligibleEntityCount: number;
  validEmbeddingCount: number;
  /** Internal freshness token; never included in MCP output. */
  snapshotKey?: string;
  /** Internal retry value; never included in MCP output. */
  queryVector?: Float32Array;
}

interface MatrixCache {
  key: string;
  entityIds: EncodedEntityIds;
  sourceHashBytes: Uint8Array;
  matrix: Float32Array;
  invalidRows: number;
}

export interface SemanticServiceOptions {
  modelPath: string;
  backendFactory?: EmbeddingBackendFactory;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SemanticService {
  readonly modelPath: string;
  readonly modelKey = APPROVED_MODEL_KEY;
  private readonly database: ContextMeshStorage;
  private readonly backendFactory: EmbeddingBackendFactory;
  private backendPromise: Promise<EmbeddingBackend> | null = null;
  private backend: EmbeddingBackend | null = null;
  private runtimeFailure: string | null = null;
  private readonly caches = new Map<SemanticPlane, MatrixCache>();

  constructor(database: ContextMeshStorage, options: SemanticServiceOptions) {
    this.database = database;
    this.modelPath = options.modelPath;
    this.backendFactory = options.backendFactory ?? createTransformersEmbeddingBackend;
    this.database.configureSemanticModel({
      modelKey: APPROVED_MODEL_KEY,
      manifestDigest: APPROVED_MODEL_KEY,
      manifestJson: canonicalJson(APPROVED_MODEL_MANIFEST),
      dimensions: APPROVED_MODEL_MANIFEST.model.dimensions,
      vectorCodec: VECTOR_CODEC,
    });
    this.database.backfillSemanticSourceHashes();
  }

  private async getBackend(): Promise<EmbeddingBackend> {
    if (this.backend) return this.backend;
    if (this.runtimeFailure) throw new Error(this.runtimeFailure);
    this.backendPromise ??= this.backendFactory(this.modelPath);
    try {
      this.backend = await this.backendPromise;
      if (
        this.backend.modelKey !== APPROVED_MODEL_KEY ||
        this.backend.dimensions !== APPROVED_MODEL_MANIFEST.model.dimensions
      ) {
        throw new Error("Embedding backend does not match the approved manifest");
      }
      return this.backend;
    } catch (error) {
      this.runtimeFailure = errorMessage(error);
      throw error;
    }
  }

  private validExistingEmbeddings(plane: SemanticPlane): Map<string, StoredSemanticEmbedding> {
    const result = new Map<string, StoredSemanticEmbedding>();
    for (const embedding of this.database.loadSemanticEmbeddings(plane, this.modelKey)) {
      if (
        embedding.dimensions !== APPROVED_MODEL_MANIFEST.model.dimensions ||
        embedding.codec !== VECTOR_CODEC
      ) {
        continue;
      }
      try {
        validateEncodedVector(embedding.vector, embedding.dimensions);
        result.set(embedding.entityId, embedding);
      } catch {
        // Corrupt rows are deliberately excluded and replaced during reconciliation.
      }
    }
    return result;
  }

  private async prepareCommit(
    plane: SemanticPlane,
    documents: SemanticDocument[],
  ): Promise<SemanticPlaneCommit> {
    if (documents.length > MAX_EXACT_SCAN_ENTITIES) {
      return {
        modelKey: this.modelKey,
        dimensions: APPROVED_MODEL_MANIFEST.model.dimensions,
        codec: VECTOR_CODEC,
        entries: documents.map((document) => ({ entityId: document.entityId, sourceHash: document.sourceHash })),
        lastError: `SCALE_LIMIT: ${documents.length} eligible ${plane} entities exceeds ${MAX_EXACT_SCAN_ENTITIES}`,
        unavailable: true,
      };
    }
    const existing = this.validExistingEmbeddings(plane);
    const entries = new Map<string, SemanticCommitEntry>();
    const missing: SemanticDocument[] = [];
    for (const document of documents) {
      const stored = existing.get(document.entityId);
      if (stored?.sourceHash === document.sourceHash) {
        entries.set(document.entityId, {
          entityId: document.entityId,
          sourceHash: document.sourceHash,
          reuse: true,
        });
      } else {
        missing.push(document);
      }
    }
    let lastError: string | null = null;
    let unavailable = false;
    if (missing.length > 0) {
      let backend: EmbeddingBackend | null = null;
      try {
        backend = await this.getBackend();
      } catch (error) {
        lastError = errorMessage(error);
        unavailable = true;
      }
      if (backend) {
        for (let offset = 0; offset < missing.length; offset += EMBEDDING_BATCH_SIZE) {
          const batch = missing.slice(offset, offset + EMBEDDING_BATCH_SIZE);
          try {
            const vectors = await backend.embedPassages(batch.map((document) => document.text));
            batch.forEach((document, index) => {
              const vector = vectors[index];
              if (!vector) throw new Error(`Embedding backend omitted entity ${document.entityId}`);
              entries.set(document.entityId, {
                entityId: document.entityId,
                sourceHash: document.sourceHash,
                vector: encodeVector(vector, APPROVED_MODEL_MANIFEST.model.dimensions),
              });
            });
          } catch (error) {
            lastError = errorMessage(error);
          }
        }
      }
    }
    for (const document of documents) {
      entries.set(
        document.entityId,
        entries.get(document.entityId) ?? { entityId: document.entityId, sourceHash: document.sourceHash },
      );
    }
    return {
      modelKey: this.modelKey,
      dimensions: APPROVED_MODEL_MANIFEST.model.dimensions,
      codec: VECTOR_CODEC,
      entries: documents.map((document) => entries.get(document.entityId)!),
      lastError,
      unavailable,
    };
  }

  async prepareCodeCommit(graph: ExtractedGraph): Promise<SemanticPlaneCommit> {
    const relativePathByFileId = new Map(graph.files.map((file) => [file.id, file.relativePath]));
    const documents = graph.nodes.map((node) =>
      buildCodeSemanticDocument(node, node.fileId ? (relativePathByFileId.get(node.fileId) ?? null) : null),
    );
    return this.prepareCommit("code", documents);
  }

  async reconcileCodeIfNeeded(): Promise<void> {
    let state = this.database.getSemanticState("code");
    const generation = this.database.getWorkspace().currentGeneration;
    if (
      state?.modelKey === this.modelKey &&
      state.graphGeneration === generation &&
      state.status === "ready" &&
      state.validEmbeddingCount === state.eligibleEntityCount
    ) {
      return;
    }
    this.database.backfillSemanticSourceHashes();
    state = this.database.getSemanticState("code");
    if (!state || state.modelKey !== this.modelKey) return;
    const documents = this.database.getCurrentCodeSemanticDocuments();
    const commit = await this.prepareCommit("code", documents);
    if (this.database.commitCodeSemanticBackfill(generation, commit)) this.caches.delete("code");
  }

  async reconcileMemoryIfNeeded(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const state = this.database.getSemanticState("memory");
      if (!state || state.modelKey !== this.modelKey) return;
      const documents = this.database.getCurrentMemorySemanticDocuments();
      const valid = this.validExistingEmbeddings("memory");
      const complete =
        documents.length === valid.size &&
        documents.every((document) => valid.get(document.entityId)?.sourceHash === document.sourceHash);
      if (complete) return;
      this.database.backfillSemanticSourceHashes();
      const refreshedState = this.database.getSemanticState("memory");
      if (!refreshedState || refreshedState.modelKey !== this.modelKey) return;
      const refreshedDocuments = this.database.getCurrentMemorySemanticDocuments();
      const commit = await this.prepareCommit("memory", refreshedDocuments);
      if (this.database.commitMemorySemanticBackfill(refreshedState.semanticRevision, commit)) {
        this.caches.delete("memory");
        return;
      }
    }
  }

  async embedRememberedMemory(
    capture: MemorySemanticCapture | undefined,
    memory: MemoryFragmentRecord,
  ): Promise<string[]> {
    if (!capture) return [];
    try {
      const backend = await this.getBackend();
      const document = buildMemorySemanticDocument(memory);
      const vector = (await backend.embedPassages([document.text]))[0];
      if (!vector) throw new Error("Embedding backend omitted remembered memory");
      const committed = this.database.casUpsertMemoryEmbedding(
        capture,
        encodeVector(vector, backend.dimensions),
        backend.dimensions,
        VECTOR_CODEC,
      );
      if (committed) this.caches.delete("memory");
      return [];
    } catch (error) {
      const message = errorMessage(error);
      if (this.runtimeFailure) this.database.markSemanticUnavailable("memory", message);
      else this.database.markSemanticNeedsBackfill("memory", message);
      return [`${this.runtimeFailure ? SEMANTIC_UNAVAILABLE_WARNING : SEMANTIC_PARTIAL_WARNING}: ${message}`];
    }
  }

  async embedReflectedMemories(
    captures: MemorySemanticCapture[] | undefined,
    memories: MemoryFragmentRecord[],
  ): Promise<string[]> {
    if (!captures || captures.length === 0) return [];
    try {
      const backend = await this.getBackend();
      const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
      const documents = captures.map((capture) => {
        const memory = memoryById.get(capture.entityId);
        if (!memory) throw new Error(`Reflected memory is missing: ${capture.entityId}`);
        return buildMemorySemanticDocument(memory);
      });
      const vectors = await backend.embedPassages(documents.map((document) => document.text));
      const entries = documents.map((document, index) => {
        const vector = vectors[index];
        if (!vector) throw new Error(`Embedding backend omitted reflected memory ${document.entityId}`);
        return {
          entityId: document.entityId,
          sourceHash: document.sourceHash,
          vector: encodeVector(vector, backend.dimensions),
        };
      });
      const committed = this.database.commitMemorySemanticBackfill(captures[0]!.semanticRevision, {
        modelKey: captures[0]!.modelKey,
        dimensions: backend.dimensions,
        codec: VECTOR_CODEC,
        entries,
      });
      if (committed) this.caches.delete("memory");
      return [];
    } catch (error) {
      const message = errorMessage(error);
      if (this.runtimeFailure) this.database.markSemanticUnavailable("memory", message);
      else this.database.markSemanticNeedsBackfill("memory", message);
      return [`${this.runtimeFailure ? SEMANTIC_UNAVAILABLE_WARNING : SEMANTIC_PARTIAL_WARNING}: ${message}`];
    }
  }

  private cacheKey(plane: SemanticPlane, state: SemanticStateRecord): string {
    return [plane, state.modelKey, state.graphGeneration ?? "memory", state.semanticRevision].join(":");
  }

  private currentStateKey(plane: SemanticPlane): string {
    const state = this.database.getSemanticState(plane);
    return state ? this.cacheKey(plane, state) : `${plane}:absent`;
  }

  isCurrent(plane: SemanticPlane, result: SemanticSearchResult): boolean {
    return result.snapshotKey === this.currentStateKey(plane);
  }

  private hydrateCache(plane: SemanticPlane, state: SemanticStateRecord): MatrixCache {
    const key = this.cacheKey(plane, state);
    const existing = this.caches.get(plane);
    if (existing?.key === key) return existing;
    const rows = this.database.loadSemanticEmbeddings(plane, this.modelKey);
    const dimensions = APPROVED_MODEL_MANIFEST.model.dimensions;
    let matrix = new Float32Array(rows.length * dimensions);
    const ids: string[] = [];
    let sourceHashBytes = new Uint8Array(rows.length * 32);
    let invalidRows = 0;
    for (const row of rows) {
      try {
        if (row.dimensions !== APPROVED_MODEL_MANIFEST.model.dimensions || row.codec !== VECTOR_CODEC) {
          throw new Error("Embedding metadata mismatch");
        }
        decodeVectorInto(row.vector, row.dimensions, matrix, ids.length * dimensions);
        writeSha256Hex(sourceHashBytes, ids.length * 32, row.sourceHash);
        ids.push(row.entityId);
      } catch {
        invalidRows += 1;
      }
    }
    if (ids.length !== rows.length) {
      matrix = matrix.slice(0, ids.length * dimensions);
      sourceHashBytes = sourceHashBytes.slice(0, ids.length * 32);
    }
    const cache = { key, entityIds: encodeEntityIds(ids), sourceHashBytes, matrix, invalidRows };
    this.caches.set(plane, cache);
    if (invalidRows > 0) {
      this.database.markSemanticNeedsBackfill(plane, `${invalidRows} invalid semantic vector row(s)`);
    }
    return cache;
  }

  private scan(
    plane: SemanticPlane,
    queryVector: Float32Array,
    limit: number,
    filters: { kinds?: CodeNodeKind[]; types?: MemoryType[]; topic?: string },
    retryVector: Float32Array | null = queryVector,
  ): SemanticSearchResult {
    const state = this.database.getSemanticState(plane);
    if (!state?.modelKey) {
      return {
        candidates: [],
        warnings: [],
        eligibleEntityCount: 0,
        validEmbeddingCount: 0,
        snapshotKey: this.currentStateKey(plane),
        ...(retryVector ? { queryVector: retryVector } : {}),
      };
    }
    const snapshotKey = this.cacheKey(plane, state);
    const eligible = this.database.getEligibleSemanticEntityKeys(plane, undefined, filters);
    if (eligible.size > MAX_EXACT_SCAN_ENTITIES) {
      const warning = `${SEMANTIC_UNAVAILABLE_WARNING}: SCALE_LIMIT (${eligible.size}/${MAX_EXACT_SCAN_ENTITIES})`;
      this.database.markSemanticUnavailable(plane, warning);
      return {
        candidates: [],
        warnings: [warning],
        eligibleEntityCount: eligible.size,
        validEmbeddingCount: 0,
        snapshotKey,
        ...(retryVector ? { queryVector: retryVector } : {}),
      };
    }
    const cache = this.hydrateCache(plane, state);
    const scanned = scanNormalizedMatrix(
      cache.matrix,
      cache.entityIds,
      cache.sourceHashBytes,
      eligible,
      queryVector,
      APPROVED_MODEL_MANIFEST.model.dimensions,
      limit,
    );
    const validEmbeddingCount = scanned.validEmbeddingCount;
    const partial = validEmbeddingCount < eligible.size || cache.invalidRows > 0;
    const partialMessage = `${validEmbeddingCount}/${eligible.size} eligible ${plane} entities have valid vectors`;
    if (partial) this.database.markSemanticNeedsBackfill(plane, partialMessage);
    const warnings = partial ? [`${SEMANTIC_PARTIAL_WARNING}: ${partialMessage}`] : [];
    return {
      candidates: scanned.rows,
      warnings,
      eligibleEntityCount: eligible.size,
      validEmbeddingCount,
      snapshotKey,
      ...(retryVector ? { queryVector: retryVector } : {}),
    };
  }

  private scanStable(
    plane: SemanticPlane,
    queryVector: Float32Array,
    limit: number,
    filters: { kinds?: CodeNodeKind[]; types?: MemoryType[]; topic?: string },
    retryVector: Float32Array | null = queryVector,
  ): SemanticSearchResult {
    let result = this.scan(plane, queryVector, limit, filters, retryVector);
    if (!this.isCurrent(plane, result)) {
      result = this.scan(plane, queryVector, limit, filters, retryVector);
    }
    return result;
  }

  private async search(
    plane: SemanticPlane,
    query: string,
    limit: number,
    filters: { kinds?: CodeNodeKind[]; types?: MemoryType[]; topic?: string },
  ): Promise<SemanticSearchResult> {
    if (plane === "memory") await this.reconcileMemoryIfNeeded();
    const eligible = this.database.getEligibleSemanticEntityKeys(plane, undefined, filters);
    if (eligible.size === 0) {
      return {
        candidates: [],
        warnings: [],
        eligibleEntityCount: 0,
        validEmbeddingCount: 0,
        snapshotKey: this.currentStateKey(plane),
      };
    }
    if (eligible.size > MAX_EXACT_SCAN_ENTITIES) {
      return this.scanStable(
        plane,
        new Float32Array(APPROVED_MODEL_MANIFEST.model.dimensions),
        limit,
        filters,
        null,
      );
    }
    try {
      const backend = await this.getBackend();
      const queryVector = await backend.embedQuery(query);
      return this.scanStable(plane, queryVector, limit, filters);
    } catch (error) {
      const message = errorMessage(error);
      this.database.markSemanticUnavailable(plane, message);
      return {
        candidates: [],
        warnings: [`${SEMANTIC_UNAVAILABLE_WARNING}: ${message}`],
        eligibleEntityCount: eligible.size,
        validEmbeddingCount: 0,
        snapshotKey: this.currentStateKey(plane),
      };
    }
  }

  searchCode(query: string, kinds: CodeNodeKind[] | undefined, limit: number): Promise<SemanticSearchResult> {
    return this.search("code", query, limit, kinds ? { kinds } : {});
  }

  searchMemory(
    query: string,
    types: MemoryType[] | undefined,
    topic: string | undefined,
    limit: number,
  ): Promise<SemanticSearchResult> {
    const filters: { types?: MemoryType[]; topic?: string } = {};
    if (types) filters.types = types;
    if (topic) filters.topic = topic;
    return this.search("memory", query, limit, filters);
  }

  rescanCode(
    previous: SemanticSearchResult,
    kinds: CodeNodeKind[] | undefined,
    limit: number,
  ): SemanticSearchResult {
    if (!previous.queryVector) return previous;
    return this.scanStable("code", previous.queryVector, limit, kinds ? { kinds } : {});
  }

  rescanMemory(
    previous: SemanticSearchResult,
    types: MemoryType[] | undefined,
    topic: string | undefined,
    limit: number,
  ): SemanticSearchResult {
    if (!previous.queryVector) return previous;
    const filters: { types?: MemoryType[]; topic?: string } = {};
    if (types) filters.types = types;
    if (topic) filters.topic = topic;
    return this.scanStable("memory", previous.queryVector, limit, filters);
  }

  async searchContext(
    query: string,
    includeCode: boolean,
    includeMemory: boolean,
    limit = 100,
  ): Promise<{ code: SemanticSearchResult | null; memory: SemanticSearchResult | null }> {
    if (includeMemory) await this.reconcileMemoryIfNeeded();
    const codeEligible = includeCode ? this.database.getEligibleSemanticEntityKeys("code") : new Map<string, string>();
    const memoryEligible = includeMemory
      ? this.database.getEligibleSemanticEntityKeys("memory")
      : new Map<string, string>();
    const empty = (plane: SemanticPlane, count: number): SemanticSearchResult => ({
      candidates: [],
      warnings: [],
      eligibleEntityCount: count,
      validEmbeddingCount: 0,
      snapshotKey: this.currentStateKey(plane),
    });
    if (codeEligible.size === 0 && memoryEligible.size === 0) {
      return {
        code: includeCode ? empty("code", 0) : null,
        memory: includeMemory ? empty("memory", 0) : null,
      };
    }
    try {
      const needsVector =
        (includeCode && codeEligible.size > 0 && codeEligible.size <= MAX_EXACT_SCAN_ENTITIES) ||
        (includeMemory && memoryEligible.size > 0 && memoryEligible.size <= MAX_EXACT_SCAN_ENTITIES);
      const backend = needsVector ? await this.getBackend() : null;
      const queryVector = backend
        ? await backend.embedQuery(query)
        : new Float32Array(APPROVED_MODEL_MANIFEST.model.dimensions);
      return {
        code: includeCode ? this.scanStable("code", queryVector, limit, {}, backend ? queryVector : null) : null,
        memory: includeMemory
          ? this.scanStable("memory", queryVector, limit, {}, backend ? queryVector : null)
          : null,
      };
    } catch (error) {
      const message = errorMessage(error);
      const unavailable = (plane: SemanticPlane, count: number): SemanticSearchResult => {
        this.database.markSemanticUnavailable(plane, message);
        return {
          candidates: [],
          warnings: [`${SEMANTIC_UNAVAILABLE_WARNING}: ${message}`],
          eligibleEntityCount: count,
          validEmbeddingCount: 0,
          snapshotKey: this.currentStateKey(plane),
        };
      };
      return {
        code: includeCode ? unavailable("code", codeEligible.size) : null,
        memory: includeMemory ? unavailable("memory", memoryEligible.size) : null,
      };
    }
  }

  rescanContext(
    previous: { code: SemanticSearchResult | null; memory: SemanticSearchResult | null },
    includeCode: boolean,
    includeMemory: boolean,
    limit = 100,
  ): { code: SemanticSearchResult | null; memory: SemanticSearchResult | null } {
    const queryVector = previous.code?.queryVector ?? previous.memory?.queryVector;
    if (!queryVector) return previous;
    return {
      code: includeCode ? this.scanStable("code", queryVector, limit, {}) : null,
      memory: includeMemory ? this.scanStable("memory", queryVector, limit, {}) : null,
    };
  }

  status(): Record<string, unknown> {
    const planeStatus = (plane: SemanticPlane): Record<string, unknown> => {
      const state = this.database.getSemanticState(plane);
      const eligible = this.database.getEligibleSemanticEntityKeys(plane);
      let valid = 0;
      for (const row of this.database.loadSemanticEmbeddings(plane, this.modelKey)) {
        try {
          if (row.dimensions !== APPROVED_MODEL_MANIFEST.model.dimensions || row.codec !== VECTOR_CODEC) continue;
          validateEncodedVector(row.vector, row.dimensions);
          if (eligible.get(row.entityId) === row.sourceHash) valid += 1;
        } catch {
          // Invalid rows are excluded from live status.
        }
      }
      const derivedStatus =
        this.runtimeFailure || eligible.size > MAX_EXACT_SCAN_ENTITIES
          ? "unavailable"
          : valid === eligible.size
            ? "ready"
            : valid > 0
              ? "partial"
              : "needs_backfill";
      return {
        status: derivedStatus,
        eligibleEntityCount: eligible.size,
        validEmbeddingCount: valid,
        coverage: eligible.size === 0 ? 1 : valid / eligible.size,
        modelKey: state?.modelKey ?? this.modelKey,
        generation: state?.graphGeneration ?? null,
        semanticRevision: state?.semanticRevision ?? 0,
        lastError: this.runtimeFailure ?? state?.lastError ?? null,
      };
    };
    return {
      enabled: true,
      modelKey: this.modelKey,
      model: APPROVED_MODEL_MANIFEST.model.repository,
      revision: APPROVED_MODEL_MANIFEST.model.revision,
      code: planeStatus("code"),
      memory: planeStatus("memory"),
      runtime: this.backend?.diagnostics ?? null,
    };
  }

  runtimeDiagnostics(): SemanticRuntimeDiagnostics | null {
    return this.backend?.diagnostics ?? null;
  }

  async dispose(): Promise<void> {
    if (this.backend) await this.backend.dispose();
    this.backend = null;
    this.backendPromise = null;
    this.caches.clear();
  }
}
