import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
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
  SemanticReconciliationClaim,
  SemanticReconciliationOwner,
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
  modelMaterialFingerprint,
} from "./manifest.js";
import { createTransformersEmbeddingBackend } from "./transformers-backend.js";
import { PipelineLifecycle } from "./pipeline-lifecycle.js";
import {
  choosePrimaryFailure,
  classifySemanticFailure,
  dataRepairFailure,
  scaleLimitFailure,
  semanticFailureFingerprint,
  type SemanticDataDefect,
  type SemanticFailureDiagnostic,
} from "./failures.js";
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
const EMBEDDING_BATCH_SIZE = 16;
const PACKED_HYDRATION_MIN_ENTITIES = 10_000;

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

interface PlaneAssessment {
  eligible: Map<string, string>;
  valid: Map<string, StoredSemanticEmbedding>;
  defects: SemanticDataDefect[];
  diagnostics: SemanticFailureDiagnostic[];
  primary: SemanticFailureDiagnostic | null;
}

export interface SemanticServiceOptions {
  modelPath: string;
  backendFactory?: EmbeddingBackendFactory;
}

function encodedVectorDefectCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("byte length mismatch")) return "INVALID_BLOB_LENGTH";
  if (message.includes("non-finite")) return "NON_FINITE_VECTOR";
  if (message.includes("norm=0")) return "ZERO_NORM_VECTOR";
  if (message.includes("not L2-normalized")) return "NORMALIZATION_ERROR";
  return "INVALID_VECTOR_BLOB";
}

class SemanticLeaseLostError extends Error {
  constructor() {
    super("Semantic reconciliation lease was lost");
    this.name = "SemanticLeaseLostError";
  }
}

export class SemanticService {
  readonly modelPath: string;
  readonly modelKey = APPROVED_MODEL_KEY;
  private readonly database: ContextMeshStorage;
  private readonly backendFactory: EmbeddingBackendFactory;
  private readonly pipeline: PipelineLifecycle<EmbeddingBackend>;
  private readonly caches = new Map<SemanticPlane, MatrixCache>();
  private readonly reconciliationPromises = new Map<SemanticPlane, Promise<void>>();
  private readonly reconciliationWarnings = new Map<SemanticPlane, string[]>();
  private readonly reconciliationOwner: SemanticReconciliationOwner = {
    ownerUuid: randomUUID(),
    ownerPid: process.pid,
    ownerHostname: hostname(),
  };

  constructor(database: ContextMeshStorage, options: SemanticServiceOptions) {
    this.database = database;
    this.modelPath = options.modelPath;
    this.backendFactory = options.backendFactory ?? createTransformersEmbeddingBackend;
    this.pipeline = new PipelineLifecycle(() => this.backendFactory(this.modelPath));
    this.database.configureSemanticModel({
      modelKey: APPROVED_MODEL_KEY,
      manifestDigest: APPROVED_MODEL_KEY,
      manifestJson: canonicalJson(APPROVED_MODEL_MANIFEST),
      dimensions: APPROVED_MODEL_MANIFEST.model.dimensions,
      vectorCodec: VECTOR_CODEC,
    });
    this.database.backfillSemanticSourceHashes();
  }

  private async withBackend<T>(
    respectCooldown: boolean,
    operation: (backend: EmbeddingBackend) => Promise<T>,
  ): Promise<T> {
    const reference = await this.pipeline.acquire({ respectCooldown });
    try {
      const backend = reference.value;
      if (
        backend.modelKey !== APPROVED_MODEL_KEY ||
        backend.dimensions !== APPROVED_MODEL_MANIFEST.model.dimensions
      ) {
        throw new Error("Embedding backend does not match the approved manifest");
      }
      return await operation(backend);
    } catch (error) {
      reference.retire();
      throw error;
    } finally {
      await reference.release();
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

  private assessPlane(plane: SemanticPlane, observedMaterialFingerprint?: string | null): PlaneAssessment {
    const eligible = this.database.getEligibleSemanticEntityKeys(plane);
    const rows = this.database.loadSemanticEmbeddings(plane, this.modelKey);
    const valid = new Map<string, StoredSemanticEmbedding>();
    const defects: SemanticDataDefect[] = [];
    const defectIds = new Set<string>();
    for (const row of rows) {
      try {
        if (row.dimensions !== APPROVED_MODEL_MANIFEST.model.dimensions) {
          throw new Error("semantic-dimension-mismatch");
        }
        if (row.codec !== VECTOR_CODEC) throw new Error("semantic-codec-mismatch");
        validateEncodedVector(row.vector, row.dimensions);
        if (eligible.get(row.entityId) === row.sourceHash) {
          valid.set(row.entityId, row);
          continue;
        }
        throw new Error("semantic-source-hash-mismatch");
      } catch (error) {
        defectIds.add(row.entityId);
        const defectCode =
          error instanceof Error && error.message === "semantic-dimension-mismatch"
            ? "DIMENSION_MISMATCH"
            : error instanceof Error && error.message === "semantic-codec-mismatch"
              ? "CODEC_MISMATCH"
              : error instanceof Error && error.message === "semantic-source-hash-mismatch"
                ? "SOURCE_HASH_MISMATCH"
                : encodedVectorDefectCode(error);
        defects.push({
          entityId: row.entityId,
          defectCode,
          storedModelKey: row.modelKey,
          generation: row.generation,
          sourceHash: row.sourceHash,
          codec: row.codec,
          blobLength: row.vector.byteLength,
          blobSha256: createHash("sha256").update(row.vector).digest("hex"),
        });
      }
    }
    for (const [entityId] of eligible) {
      if (valid.has(entityId) || defectIds.has(entityId)) continue;
      defects.push({
        entityId,
        defectCode: "MISSING_EMBEDDING",
        storedModelKey: null,
        generation: null,
        sourceHash: null,
        codec: null,
        blobLength: null,
        blobSha256: null,
      });
    }

    const diagnostics: SemanticFailureDiagnostic[] = [];
    const state = this.database.getSemanticState(plane);
    if (eligible.size > MAX_EXACT_SCAN_ENTITIES) diagnostics.push(scaleLimitFailure(eligible.size, MAX_EXACT_SCAN_ENTITIES));
    if (
      eligible.size > 0 &&
      state?.failureClass &&
      state.failureClass !== "data_repairable" &&
      state.failureClass !== "scale_limit"
    ) {
      diagnostics.push({
        failureClass: state.failureClass,
        code: state.normalizedErrorCode ?? state.failureClass.toUpperCase(),
        detailCode: state.diagnostics[0]?.detailCode ?? state.normalizedErrorCode ?? state.failureClass,
        materialFingerprint: observedMaterialFingerprint ?? state.materialFingerprint,
        safeSummary: state.normalizedErrorCode ?? state.failureClass.toUpperCase(),
      });
    }
    if (defects.length > 0) diagnostics.push(dataRepairFailure(defects));
    return { eligible, valid, defects, diagnostics, primary: choosePrimaryFailure(diagnostics) };
  }

  private recordAssessment(plane: SemanticPlane, assessment: PlaneAssessment): void {
    const state = this.database.getSemanticState(plane);
    const failureFingerprint = assessment.primary ? semanticFailureFingerprint(assessment.primary) : null;
    const safeDiagnostics = assessment.diagnostics.map((diagnostic) => ({
      failureClass: diagnostic.failureClass,
      code: diagnostic.code,
      detailCode: diagnostic.detailCode,
    }));
    if (
      state &&
      state.eligibleEntityCount === assessment.eligible.size &&
      state.validEmbeddingCount === assessment.valid.size &&
      state.failureClass === (assessment.primary?.failureClass ?? null) &&
      state.normalizedErrorCode === (assessment.primary?.code ?? null) &&
      state.failureFingerprint === failureFingerprint &&
      JSON.stringify(state.diagnostics) === JSON.stringify(safeDiagnostics)
    ) {
      return;
    }
    this.database.updateSemanticFailure(
      plane,
      assessment.primary,
      assessment.diagnostics,
      assessment.eligible.size,
      assessment.valid.size,
    );
  }

  private recordOperationFailure(
    plane: SemanticPlane,
    error: unknown,
    materialFingerprint: string | null = null,
  ): SemanticFailureDiagnostic {
    const failure = classifySemanticFailure(error, materialFingerprint);
    const assessment = this.assessPlane(plane, materialFingerprint);
    const diagnostics = [
      ...assessment.diagnostics.filter(
        (diagnostic) =>
          diagnostic.failureClass !== "runtime_retryable" &&
          diagnostic.failureClass !== "material_sticky",
      ),
      failure,
    ];
    const primary = choosePrimaryFailure(diagnostics) ?? failure;
    this.database.updateSemanticFailure(
      plane,
      primary,
      diagnostics,
      assessment.eligible.size,
      assessment.valid.size,
    );
    return primary;
  }

  private warningForFailure(failure: SemanticFailureDiagnostic): string {
    const prefix =
      failure.failureClass === "data_repairable"
        ? SEMANTIC_PARTIAL_WARNING
        : SEMANTIC_UNAVAILABLE_WARNING;
    return `${prefix}: ${failure.safeSummary}`;
  }

  private takeReconciliationWarnings(plane: SemanticPlane): string[] {
    const warnings = this.reconciliationWarnings.get(plane) ?? [];
    this.reconciliationWarnings.delete(plane);
    return warnings;
  }

  private durableUnavailableFailure(plane: SemanticPlane): SemanticFailureDiagnostic | null {
    const state = this.database.getSemanticState(plane);
    if (
      !state?.failureClass ||
      state.failureClass === "data_repairable"
    ) {
      return null;
    }
    return {
      failureClass: state.failureClass,
      code: state.normalizedErrorCode ?? state.failureClass.toUpperCase(),
      detailCode: state.diagnostics[0]?.detailCode ?? state.normalizedErrorCode ?? state.failureClass,
      materialFingerprint: state.materialFingerprint,
      safeSummary: state.normalizedErrorCode ?? state.failureClass.toUpperCase(),
    };
  }

  private async prepareCommit(
    plane: SemanticPlane,
    documents: SemanticDocument[],
    claim?: SemanticReconciliationClaim,
    observedMaterialFingerprint: string | null = null,
  ): Promise<SemanticPlaneCommit> {
    if (documents.length > MAX_EXACT_SCAN_ENTITIES) {
      const failure = scaleLimitFailure(documents.length, MAX_EXACT_SCAN_ENTITIES);
      return {
        modelKey: this.modelKey,
        dimensions: APPROVED_MODEL_MANIFEST.model.dimensions,
        codec: VECTOR_CODEC,
        entries: documents.map((document) => ({ entityId: document.entityId, sourceHash: document.sourceHash })),
        lastError: failure.safeSummary,
        unavailable: true,
        failure,
        diagnostics: [failure],
        newVectorCount: 0,
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
    const diagnostics: SemanticFailureDiagnostic[] = [];
    let newVectorCount = 0;
    const heartbeat = (): void => {
      if (claim && !this.database.heartbeatSemanticReconciliation(claim)) throw new SemanticLeaseLostError();
    };
    if (missing.length > 0) {
      try {
        await this.withBackend(false, async (backend) => {
          for (let offset = 0; offset < missing.length; offset += EMBEDDING_BATCH_SIZE) {
            const batch = missing.slice(offset, offset + EMBEDDING_BATCH_SIZE);
            heartbeat();
            const vectors = await backend.embedPassages(batch.map((document) => document.text));
            batch.forEach((document, index) => {
              const vector = vectors[index];
              if (!vector) throw new Error(`Embedding backend omitted entity ${document.entityId}`);
              entries.set(document.entityId, {
                entityId: document.entityId,
                sourceHash: document.sourceHash,
                vector: encodeVector(vector, APPROVED_MODEL_MANIFEST.model.dimensions),
              });
              newVectorCount += 1;
            });
            heartbeat();
          }
        });
      } catch (error) {
        if (error instanceof SemanticLeaseLostError) throw error;
        diagnostics.push(classifySemanticFailure(error, observedMaterialFingerprint));
      }
    }
    for (const document of documents) {
      entries.set(
        document.entityId,
        entries.get(document.entityId) ?? { entityId: document.entityId, sourceHash: document.sourceHash },
      );
    }
    const failure = choosePrimaryFailure(diagnostics);
    return {
      modelKey: this.modelKey,
      dimensions: APPROVED_MODEL_MANIFEST.model.dimensions,
      codec: VECTOR_CODEC,
      entries: documents.map((document) => entries.get(document.entityId)!),
      lastError: failure?.safeSummary ?? null,
      unavailable: failure?.failureClass === "material_sticky" || failure?.failureClass === "runtime_retryable",
      ...(failure ? { failure, diagnostics } : {}),
      newVectorCount,
    };
  }

  async prepareCodeCommit(graph: ExtractedGraph): Promise<SemanticPlaneCommit> {
    const relativePathByFileId = new Map(graph.files.map((file) => [file.id, file.relativePath]));
    const documents = graph.nodes.map((node) =>
      buildCodeSemanticDocument(node, node.fileId ? (relativePathByFileId.get(node.fileId) ?? null) : null),
    );
    const fingerprint = await modelMaterialFingerprint(this.modelPath);
    return this.prepareCommit("code", documents, undefined, fingerprint);
  }

  async reconcileCodeIfNeeded(): Promise<void> {
    return this.reconcileIfNeeded("code");
  }

  async reconcileMemoryIfNeeded(): Promise<void> {
    return this.reconcileIfNeeded("memory");
  }

  private reconcileIfNeeded(plane: SemanticPlane): Promise<void> {
    const current = this.reconciliationPromises.get(plane);
    if (current) return current;
    const promise = this.reconcilePlane(plane).finally(() => {
      if (this.reconciliationPromises.get(plane) === promise) this.reconciliationPromises.delete(plane);
    });
    this.reconciliationPromises.set(plane, promise);
    return promise;
  }

  private async reconcilePlane(plane: SemanticPlane): Promise<void> {
    const initialState = this.database.getSemanticState(plane);
    if (initialState?.status === "ready" && !initialState.failureClass) return;
    const materialFingerprint = await modelMaterialFingerprint(this.modelPath);
    let assessment = this.assessPlane(plane, materialFingerprint);
    this.recordAssessment(plane, assessment);
    if (assessment.primary) {
      this.reconciliationWarnings.set(plane, [this.warningForFailure(assessment.primary)]);
    }
    // Canonical source-hash repair is a fenced state transition. Assess first so
    // the request still reports the transient partial condition, then rebuild
    // the attempt from the post-repair DB state.
    this.database.backfillSemanticSourceHashes(true);
    assessment = this.assessPlane(plane, materialFingerprint);
    this.recordAssessment(plane, assessment);
    if (!assessment.primary || assessment.eligible.size === 0 || assessment.primary.failureClass === "scale_limit") {
      return;
    }
    const claimed = this.database.claimSemanticReconciliation(plane, this.reconciliationOwner);
    if (!claimed.claim) return;
    const claim = claimed.claim;
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      if (!this.database.heartbeatSemanticReconciliation(claim)) leaseLost = true;
    }, 5_000);
    heartbeat.unref();
    try {
      const documents = plane === "code"
        ? this.database.getCurrentCodeSemanticDocuments()
        : this.database.getCurrentMemorySemanticDocuments();
      const commit = await this.prepareCommit(plane, documents, claim, materialFingerprint);
      if (leaseLost) return;
      if (commit.failure && (commit.newVectorCount ?? 0) === 0) {
        const diagnostics = [...assessment.diagnostics, ...(commit.diagnostics ?? [commit.failure])];
        const primary = choosePrimaryFailure(diagnostics) ?? commit.failure;
        this.database.completeSemanticReconciliationFailure(
          claim,
          primary,
          diagnostics,
          assessment.eligible.size,
          assessment.valid.size,
        );
        return;
      }
      const committed = plane === "code"
        ? claim.graphGeneration !== null &&
          this.database.commitCodeSemanticBackfill(claim.graphGeneration, commit, claim)
        : this.database.commitMemorySemanticBackfill(claim.semanticRevision, commit, undefined, claim);
      if (committed) this.caches.delete(plane);
    } catch (error) {
      if (error instanceof SemanticLeaseLostError) return;
      const failure = classifySemanticFailure(error, materialFingerprint);
      this.database.completeSemanticReconciliationFailure(
        claim,
        failure,
        [failure],
        assessment.eligible.size,
        assessment.valid.size,
      );
    } finally {
      clearInterval(heartbeat);
    }
  }

  async embedRememberedMemory(
    capture: MemorySemanticCapture | undefined,
    memory: MemoryFragmentRecord,
  ): Promise<string[]> {
    if (!capture) return [];
    try {
      const document = buildMemorySemanticDocument(memory);
      const committed = await this.withBackend(false, async (backend) => {
        const vector = (await backend.embedPassages([document.text]))[0];
        if (!vector) throw new Error("Embedding backend omitted remembered memory");
        return this.database.casUpsertMemoryEmbedding(
          capture,
          encodeVector(vector, backend.dimensions),
          backend.dimensions,
          VECTOR_CODEC,
        );
      });
      if (committed) this.caches.delete("memory");
      return [];
    } catch (error) {
      const fingerprint = await modelMaterialFingerprint(this.modelPath);
      return [this.warningForFailure(this.recordOperationFailure("memory", error, fingerprint))];
    }
  }

  async embedReflectedMemories(
    captures: MemorySemanticCapture[] | undefined,
    memories: MemoryFragmentRecord[],
  ): Promise<string[]> {
    if (!captures || captures.length === 0) return [];
    try {
      const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
      const documents = captures.map((capture) => {
        const memory = memoryById.get(capture.entityId);
        if (!memory) throw new Error(`Reflected memory is missing: ${capture.entityId}`);
        return buildMemorySemanticDocument(memory);
      });
      const committed = await this.withBackend(false, async (backend) => {
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
        return this.database.commitMemorySemanticBackfill(captures[0]!.semanticRevision, {
          modelKey: captures[0]!.modelKey,
          dimensions: backend.dimensions,
          codec: VECTOR_CODEC,
          entries,
        });
      });
      if (committed) this.caches.delete("memory");
      return [];
    } catch (error) {
      const fingerprint = await modelMaterialFingerprint(this.modelPath);
      return [this.warningForFailure(this.recordOperationFailure("memory", error, fingerprint))];
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

  /** Explicitly hydrate a ready plane without query inference or exact scanning. */
  warmCache(plane: SemanticPlane): { validEmbeddingCount: number; invalidRows: number } {
    const state = this.database.getSemanticState(plane);
    if (!state?.modelKey) return { validEmbeddingCount: 0, invalidRows: 0 };
    const cache = this.hydrateCache(plane, state);
    return { validEmbeddingCount: cache.entityIds.count, invalidRows: cache.invalidRows };
  }

  private hydrateCache(plane: SemanticPlane, state: SemanticStateRecord): MatrixCache {
    const key = this.cacheKey(plane, state);
    const existing = this.caches.get(plane);
    if (existing?.key === key) return existing;
    const dimensions = APPROVED_MODEL_MANIFEST.model.dimensions;
    let capacity = Math.max(1, state.eligibleEntityCount, state.validEmbeddingCount);
    if (capacity >= PACKED_HYDRATION_MIN_ENTITIES) {
      const packed = this.database.hydrateSemanticMatrix(plane, this.modelKey, dimensions);
      if (packed) {
        const cache = {
          key,
          entityIds: {
            bytes: packed.entityIdBytes,
            offsets: packed.entityIdOffsets,
            count: packed.entityIdOffsets.length - 1,
          },
          sourceHashBytes: packed.sourceHashBytes,
          matrix: packed.matrix,
          invalidRows: packed.invalidRows,
        };
        this.caches.set(plane, cache);
        return cache;
      }
    }
    let matrix = new Float32Array(capacity * dimensions);
    const ids: string[] = [];
    let sourceHashBytes = new Uint8Array(capacity * 32);
    let invalidRows = 0;
    for (const row of this.database.iterateSemanticEmbeddings(plane, this.modelKey)) {
      try {
        if (row.dimensions !== APPROVED_MODEL_MANIFEST.model.dimensions || row.codec !== VECTOR_CODEC) {
          throw new Error("Embedding metadata mismatch");
        }
        if (ids.length === capacity) {
          const nextCapacity = Math.min(MAX_EXACT_SCAN_ENTITIES, Math.max(capacity * 2, ids.length + 1));
          if (nextCapacity <= capacity) throw new Error("Semantic cache exceeds the exact-scan limit");
          const grownMatrix = new Float32Array(nextCapacity * dimensions);
          grownMatrix.set(matrix);
          matrix = grownMatrix;
          const grownHashes = new Uint8Array(nextCapacity * 32);
          grownHashes.set(sourceHashBytes);
          sourceHashBytes = grownHashes;
          capacity = nextCapacity;
        }
        decodeVectorInto(row.vector, row.dimensions, matrix, ids.length * dimensions);
        writeSha256Hex(sourceHashBytes, ids.length * 32, row.sourceHash);
        ids.push(row.entityId);
      } catch {
        invalidRows += 1;
      }
    }
    this.database.releaseTransientSemanticReadMemory();
    matrix = matrix.subarray(0, ids.length * dimensions);
    sourceHashBytes = sourceHashBytes.subarray(0, ids.length * 32);
    const cache = { key, entityIds: encodeEntityIds(ids), sourceHashBytes, matrix, invalidRows };
    this.caches.set(plane, cache);
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
      const failure = scaleLimitFailure(eligible.size, MAX_EXACT_SCAN_ENTITIES);
      this.database.updateSemanticFailure(plane, failure, [failure], eligible.size, 0);
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
    if (partial) this.recordAssessment(plane, this.assessPlane(plane));
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
    const reconciliationWarnings = this.takeReconciliationWarnings(plane);
    const appendReconciliationWarnings = (result: SemanticSearchResult): SemanticSearchResult => ({
      ...result,
      warnings: [...new Set([...reconciliationWarnings, ...result.warnings])],
    });
    const eligible = this.database.getEligibleSemanticEntityKeys(plane, undefined, filters);
    if (eligible.size === 0) {
      return appendReconciliationWarnings({
        candidates: [],
        warnings: [],
        eligibleEntityCount: 0,
        validEmbeddingCount: 0,
        snapshotKey: this.currentStateKey(plane),
      });
    }
    if (eligible.size > MAX_EXACT_SCAN_ENTITIES) {
      return appendReconciliationWarnings(this.scanStable(
        plane,
        new Float32Array(APPROVED_MODEL_MANIFEST.model.dimensions),
        limit,
        filters,
        null,
      ));
    }
    const durableFailure = this.durableUnavailableFailure(plane);
    if (durableFailure) {
      return appendReconciliationWarnings({
        candidates: [],
        warnings: [this.warningForFailure(durableFailure)],
        eligibleEntityCount: eligible.size,
        validEmbeddingCount: this.database.getSemanticState(plane)?.validEmbeddingCount ?? 0,
        snapshotKey: this.currentStateKey(plane),
      });
    }
    try {
      const queryVector = await this.withBackend(true, (backend) => backend.embedQuery(query));
      return appendReconciliationWarnings(this.scanStable(plane, queryVector, limit, filters));
    } catch (error) {
      // Query inference failures are deliberately non-durable. A bad query or a
      // retiring runtime must not rewrite the workspace reconciliation state.
      const failure = classifySemanticFailure(error);
      return appendReconciliationWarnings({
        candidates: [],
        warnings: [this.warningForFailure(failure)],
        eligibleEntityCount: eligible.size,
        validEmbeddingCount: 0,
        snapshotKey: this.currentStateKey(plane),
      });
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
    const codeReconciliationWarnings = includeCode ? this.takeReconciliationWarnings("code") : [];
    const memoryReconciliationWarnings = includeMemory ? this.takeReconciliationWarnings("memory") : [];
    const withPlaneWarnings = (plane: SemanticPlane, result: SemanticSearchResult): SemanticSearchResult => ({
      ...result,
      warnings: [
        ...new Set([
          ...(plane === "code" ? codeReconciliationWarnings : memoryReconciliationWarnings),
          ...result.warnings,
        ]),
      ],
    });
    const codeEligible = includeCode ? this.database.getEligibleSemanticEntityKeys("code") : new Map<string, string>();
    const memoryEligible = includeMemory
      ? this.database.getEligibleSemanticEntityKeys("memory")
      : new Map<string, string>();
    const codeDurableFailure = includeCode ? this.durableUnavailableFailure("code") : null;
    const memoryDurableFailure = includeMemory ? this.durableUnavailableFailure("memory") : null;
    const empty = (plane: SemanticPlane, count: number): SemanticSearchResult => ({
      candidates: [],
      warnings: [],
      eligibleEntityCount: count,
      validEmbeddingCount: 0,
      snapshotKey: this.currentStateKey(plane),
    });
    if (codeEligible.size === 0 && memoryEligible.size === 0) {
      return {
      code: includeCode ? withPlaneWarnings("code", empty("code", 0)) : null,
      memory: includeMemory ? withPlaneWarnings("memory", empty("memory", 0)) : null,
      };
    }
    try {
      const needsVector =
        (includeCode && !codeDurableFailure && codeEligible.size > 0 && codeEligible.size <= MAX_EXACT_SCAN_ENTITIES) ||
        (includeMemory && !memoryDurableFailure && memoryEligible.size > 0 && memoryEligible.size <= MAX_EXACT_SCAN_ENTITIES);
      const queryVector = needsVector
        ? await this.withBackend(true, (backend) => backend.embedQuery(query))
        : new Float32Array(APPROVED_MODEL_MANIFEST.model.dimensions);
      const blocked = (
        plane: SemanticPlane,
        count: number,
        failure: SemanticFailureDiagnostic,
      ): SemanticSearchResult => ({
        candidates: [],
        warnings: [this.warningForFailure(failure)],
        eligibleEntityCount: count,
        validEmbeddingCount: this.database.getSemanticState(plane)?.validEmbeddingCount ?? 0,
        snapshotKey: this.currentStateKey(plane),
      });
      return {
        code: includeCode
          ? withPlaneWarnings(
              "code",
              codeDurableFailure
                ? blocked("code", codeEligible.size, codeDurableFailure)
                : this.scanStable("code", queryVector, limit, {}, needsVector ? queryVector : null),
            )
          : null,
        memory: includeMemory
          ? withPlaneWarnings(
              "memory",
              memoryDurableFailure
                ? blocked("memory", memoryEligible.size, memoryDurableFailure)
                : this.scanStable("memory", queryVector, limit, {}, needsVector ? queryVector : null),
            )
          : null,
      };
    } catch (error) {
      const failure = classifySemanticFailure(error);
      const unavailable = (plane: SemanticPlane, count: number): SemanticSearchResult => {
        return {
          candidates: [],
          warnings: [this.warningForFailure(failure)],
          eligibleEntityCount: count,
          validEmbeddingCount: 0,
          snapshotKey: this.currentStateKey(plane),
        };
      };
      return {
        code: includeCode ? withPlaneWarnings("code", unavailable("code", codeEligible.size)) : null,
        memory: includeMemory ? withPlaneWarnings("memory", unavailable("memory", memoryEligible.size)) : null,
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
      const assessment = this.assessPlane(plane);
      const eligible = assessment.eligible;
      const valid = assessment.valid.size;
      const primary = assessment.primary;
      const derivedStatus =
        primary?.failureClass === "material_sticky" ||
        primary?.failureClass === "scale_limit" ||
        primary?.failureClass === "runtime_retryable"
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
        failureClass: primary?.failureClass ?? null,
        normalizedErrorCode: primary?.code ?? null,
        lastError: primary?.safeSummary ?? null,
        retryGeneration: state?.retryGeneration ?? 0,
        retryCount: state?.retryCount ?? 0,
        nextRetryEpoch: state?.nextRetryEpoch ?? null,
        reconciliation: this.database.getSemanticClaimDiagnostics(plane),
      };
    };
    return {
      enabled: true,
      modelKey: this.modelKey,
      model: APPROVED_MODEL_MANIFEST.model.repository,
      revision: APPROVED_MODEL_MANIFEST.model.revision,
      code: planeStatus("code"),
      memory: planeStatus("memory"),
      runtime: this.pipeline.peek()?.diagnostics ?? null,
    };
  }

  runtimeDiagnostics(): SemanticRuntimeDiagnostics | null {
    return this.pipeline.peek()?.diagnostics ?? null;
  }

  async dispose(): Promise<void> {
    await this.pipeline.close();
    this.caches.clear();
  }
}
