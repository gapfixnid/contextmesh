import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AdapterStateMap,
  AdapterStats,
  AssertionStatus,
  CodeEdgeKind,
  CodeEdgeRecord,
  EdgeStatus,
  CodeNodeKind,
  CodeNodeRecord,
  ExtractedGraph,
  ForgetInput,
  IndexMode,
  MemoryFragmentRecord,
  MemoryType,
  PrecisionProviderState,
  RecallInput,
  ReflectInput,
  RememberInput,
  UnresolvedReferenceRecord,
  WorkspaceRecord,
} from "../contracts.js";
import { AsyncMutex } from "../concurrency.js";
import { ContextMeshError } from "../errors.js";
import {
  buildCodeSemanticDocument,
  buildMemorySemanticDocument,
  semanticDocumentSetDigest,
  type SemanticDocument,
} from "../semantic/documents.js";
import type { SemanticPlane } from "../semantic/backend.js";
import { controlDigest } from "../semantic/control-json.js";
import {
  semanticFailureFingerprint,
  type SemanticFailureClass,
  type SemanticFailureDiagnostic,
} from "../semantic/failures.js";
import { validateEncodedVector, VECTOR_CODEC } from "../semantic/vector-codec.js";
import {
  buildFtsQuery,
  detectPathCaseSensitivity,
  normalizePathKey,
  sha256,
  tokenizeIdentifier,
  unique,
} from "../utils.js";

type SqlRow = Record<string, SQLOutputValue>;

export interface IndexRunHandle {
  id: string;
  generation: number;
  mode: IndexMode;
  leaseOwner: string;
  leaseToken: string;
}

const INDEX_WRITER_LEASE_SECONDS = 30;

export interface IndexCommitStats {
  scannedFiles: number;
  changedFiles: number;
  deletedFiles: number;
  failedFiles: number;
}

export interface IndexedFileBaseline {
  pathKey: string;
  relativePath: string;
  contentHash: string;
  sizeBytes: number;
  mtimeMs: number;
  language: string | null;
  ecosystem: string | null;
  sourceRoot: string;
  adapterConfigHash: string;
  parseStatus: "ok" | "partial" | "error";
  diagnosticCount: number;
}

export interface FreshnessState {
  currentGeneration: number;
  precisionRevision: number;
  successFenceGeneration: number;
  failureFenceGeneration: number;
  freshnessStale: boolean;
  freshnessStaleAt: string | null;
  freshnessReasons: string[];
  lastStrictCheckAt: string | null;
  stale: boolean;
}

export interface CodeSearchResult extends CodeNodeRecord {
  relativePath: string | null;
  fileContentHash: string | null;
  score: number;
}

export interface TraceEdgeResult {
  sourceId: string;
  targetId: string;
  kind: CodeEdgeKind;
  confidence: number;
  resolutionKind: string;
  depth: number;
  status: EdgeStatus;
  evidence: CodeEdgeRecord["evidence"];
}

export interface TraceResult {
  start: CodeSearchResult;
  nodes: CodeSearchResult[];
  edges: TraceEdgeResult[];
  unresolved: Array<{ sourceNodeId: string | null; kind: string; rawName: string; line: number; column: number; confidence: number; evidence: UnresolvedReferenceRecord["evidence"] }>;
  truncated: boolean;
}

export interface RememberResult {
  fragment: MemoryFragmentRecord;
  duplicate: boolean;
  warnings: string[];
  semanticCapture?: MemorySemanticCapture;
}

export interface RecallResult {
  anchors: MemoryFragmentRecord[];
  fragments: MemoryFragmentRecord[];
  truncated: boolean;
  nextOffset: number | null;
}

export interface DoctorResult {
  integrity: string;
  sqliteVersion: string;
  schemaVersions: number[];
  interruptedRunsRecovered: number;
  foreignKeyViolations: number;
  codeNodeRows: number;
  codeFtsRows: number;
  activeMemoryRows: number;
  memoryFtsRows: number;
  ftsConsistent: boolean;
}

export interface ExistingEdgeRelation {
  edge: CodeEdgeRecord;
  sourcePathKey: string | null;
}

export interface ExistingUnresolvedRelation {
  reference: UnresolvedReferenceRecord;
  filePathKey: string;
}

export interface ExistingRelations {
  externalNodes: CodeNodeRecord[];
  edges: ExistingEdgeRelation[];
  unresolved: ExistingUnresolvedRelation[];
}

export interface StoredGraphPartition {
  nodes: CodeNodeRecord[];
  edges: CodeEdgeRecord[];
  unresolvedReferences: UnresolvedReferenceRecord[];
}

export interface PrecisionClaim {
  provider: string;
  providerVersion: string;
  language: string;
  capability: "resolved" | "typed";
  baseGeneration: number;
  transitionEpoch: number;
  token: string;
  owner: string;
}

export interface PrecisionClaimResult {
  claim: PrecisionClaim | null;
  reason: "acquired" | "leased" | "not_indexed";
}

export interface PrecisionCommit {
  nodes?: Array<{
    nodeId: string;
    analysisLevel: "resolved" | "typed";
    signature: string;
    doc: string;
    contentHash: string;
    metadata: Record<string, unknown>;
  }>;
  edges: Array<{
    sourceId: string;
    targetId: string;
    kind: CodeEdgeKind;
    status: EdgeStatus;
    confidence: number;
    resolutionKind: CodeEdgeRecord["resolutionKind"];
    evidence: NonNullable<CodeEdgeRecord["evidence"]>;
  }>;
  eligibleEdges: number;
  diagnostics: string[];
  partial?: boolean;
}

export interface OperationalStatusRecord {
  component: "graph_kernel" | "watcher";
  status: "ready" | "failed";
  diagnostic: string | null;
  updatedAt: string;
}

export interface MemoryCodeProvenance {
  memoryId: string;
  codeNodeId: string | null;
  nodeLocalKey: string;
  relationType: string;
  confidence: number;
  locatorSnapshot: Record<string, unknown>;
}

export type SemanticStateStatus = "ready" | "partial" | "needs_backfill" | "unavailable";

export interface SemanticReconciliationOwner {
  ownerUuid: string;
  ownerPid: number;
  ownerHostname: string;
}

export interface SemanticReconciliationClaim extends SemanticReconciliationOwner {
  plane: SemanticPlane;
  attemptToken: string;
  modelKey: string;
  graphGeneration: number | null;
  semanticRevision: number;
  retryGeneration: number;
  leaseExpiryEpoch: number;
}

export interface SemanticReconciliationClaimResult {
  claim: SemanticReconciliationClaim | null;
  reason: "acquired" | "completed" | "leased" | "backoff" | "state_changed" | "not_configured";
}

export interface CodeIndexSemanticClaim extends SemanticReconciliationOwner {
  operation: "code_index";
  plane: "code";
  attemptToken: string;
  modelKey: string;
  baseGraphGeneration: number;
  targetGraphGeneration: number;
  baseSemanticRevision: number;
  eligibleEntityCount: number;
  documentSetDigest: string;
  materialFingerprint: string;
  leaseExpiryEpoch: number;
}

export interface CodeIndexSemanticClaimInput {
  expectedCurrentGeneration: number;
  targetGeneration: number;
  modelKey: string;
  eligibleEntityCount: number;
  documentSetDigest: string;
  materialFingerprint: string;
}

export interface CodeIndexSemanticClaimResult {
  claim: CodeIndexSemanticClaim | null;
  reason: "acquired" | "leased" | "state_changed" | "completed";
}

export interface SemanticClaimDiagnostics {
  activeAttemptToken: string | null;
  lastCompletedAttemptToken: string | null;
  claimCount: number;
  takeoverCount: number;
  supersedeCount: number;
  leaseExpiryEpoch: number | null;
}

export interface SemanticModelRegistration {
  modelKey: string;
  manifestDigest: string;
  manifestJson: string;
  dimensions: number;
  vectorCodec: string;
}

export interface SemanticStateRecord {
  workspaceId: string;
  plane: SemanticPlane;
  modelKey: string | null;
  graphGeneration: number | null;
  semanticRevision: number;
  status: SemanticStateStatus;
  eligibleEntityCount: number;
  validEmbeddingCount: number;
  coverage: number;
  lastError: string | null;
  failureClass: SemanticFailureClass | "scale_limit" | null;
  normalizedErrorCode: string | null;
  failureFingerprint: string | null;
  materialFingerprint: string | null;
  diagnostics: Array<{ failureClass: string; code: string; detailCode: string }>;
  retryGeneration: number;
  retryCount: number;
  nextRetryEpoch: number | null;
  updatedAt: string;
}

export interface StoredSemanticEmbedding {
  entityId: string;
  sourceHash: string;
  modelKey: string;
  generation: number | null;
  vector: Uint8Array;
  dimensions: number;
  codec: string;
}

export interface SemanticHydrationModel {
  modelId: number;
  dimensions: number;
  codec: string;
}

export interface RawSemanticHydrationRow {
  entityKey: Uint8Array;
  sourceHash: Uint8Array;
  vector: Uint8Array;
}

export interface SemanticCommitEntry {
  entityId: string;
  sourceHash: string;
  vector?: Uint8Array;
  reuse?: boolean;
}

export interface SemanticPlaneCommit {
  modelKey: string;
  dimensions: number;
  codec: string;
  entries: SemanticCommitEntry[];
  lastError?: string | null;
  unavailable?: boolean;
  failure?: SemanticFailureDiagnostic;
  diagnostics?: SemanticFailureDiagnostic[];
  newVectorCount?: number;
}

export interface MemorySemanticCapture {
  entityId: string;
  sourceHash: string;
  modelKey: string;
  semanticRevision: number;
}

export interface ReflectResult {
  episode: MemoryFragmentRecord;
  learnings: MemoryFragmentRecord[];
  duplicates: number;
  semanticCaptures?: MemorySemanticCapture[];
}

export interface ContextMeshDatabaseOptions {
  clock?: () => Date;
  /** Test-only fault injection after migration SQL and before commit. */
  migrationValidationHook?: (version: number) => void;
  /** Test-only fault injection after the pre-migration backup copy and before validation. */
  migrationBackupValidationHook?: (backupPath: string) => void;
}

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../../migrations", import.meta.url));
const PHASE4_PAGE_SIZE = 8_192;

function stringValue(value: SQLOutputValue | undefined): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : stringValue(value);
}

function numberValue(value: SQLOutputValue | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number(value ?? 0);
}

function hexValue(value: SQLOutputValue | undefined): string {
  return value instanceof Uint8Array ? Buffer.from(value).toString("hex") : stringValue(value);
}

function parseJson<T>(value: SQLOutputValue | undefined, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function mapWorkspace(row: SqlRow): WorkspaceRecord {
  return {
    id: stringValue(row.id),
    name: stringValue(row.name),
    rootPath: stringValue(row.root_path),
    rootPathKey: stringValue(row.root_path_key),
    currentGeneration: numberValue(row.current_generation),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function mapCodeNode(row: SqlRow): CodeSearchResult {
  return {
    id: stringValue(row.id),
    workspaceId: stringValue(row.workspace_id),
    fileId: nullableString(row.file_id),
    kind: stringValue(row.kind) as CodeNodeKind,
    name: stringValue(row.name),
    qualifiedName: stringValue(row.qualified_name),
    localKey: stringValue(row.local_key),
    signature: stringValue(row.signature),
    doc: stringValue(row.doc),
    isExported: numberValue(row.is_exported) === 1,
    startByte: numberValue(row.start_byte),
    endByte: numberValue(row.end_byte),
    startLine: numberValue(row.start_line),
    startColumn: numberValue(row.start_column),
    endLine: numberValue(row.end_line),
    endColumn: numberValue(row.end_column),
    contentHash: stringValue(row.content_hash),
    generation: numberValue(row.generation),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    language: stringValue(row.language) as NonNullable<CodeNodeRecord["language"]>,
    ecosystem: stringValue(row.ecosystem) as NonNullable<CodeNodeRecord["ecosystem"]>,
    nativeKind: stringValue(row.native_kind),
    analysisLevel: stringValue(row.analysis_level) as NonNullable<CodeNodeRecord["analysisLevel"]>,
    relativePath: nullableString(row.relative_path),
    fileContentHash: nullableString(row.file_content_hash),
    score: numberValue(row.score),
  };
}

function mapMemory(row: SqlRow): MemoryFragmentRecord {
  return {
    id: stringValue(row.id),
    workspaceId: stringValue(row.workspace_id),
    type: stringValue(row.type) as MemoryType,
    topic: stringValue(row.topic),
    content: stringValue(row.content),
    keywords: parseJson<string[]>(row.keywords_json, []),
    importance: numberValue(row.importance),
    isAnchor: numberValue(row.is_anchor) === 1,
    assertionStatus: stringValue(row.assertion_status) as AssertionStatus,
    state: stringValue(row.state) as MemoryFragmentRecord["state"],
    sessionId: nullableString(row.session_id),
    supersedesId: nullableString(row.supersedes_id),
    accessCount: numberValue(row.access_count),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
    lastAccessedAt: nullableString(row.last_accessed_at),
    expiresAt: nullableString(row.expires_at),
  };
}

function mapSemanticState(row: SqlRow): SemanticStateRecord {
  const eligibleEntityCount = numberValue(row.eligible_entity_count);
  const validEmbeddingCount = numberValue(row.valid_embedding_count);
  return {
    workspaceId: stringValue(row.workspace_id),
    plane: stringValue(row.plane) as SemanticPlane,
    modelKey: nullableString(row.model_key),
    graphGeneration: row.graph_generation === null ? null : numberValue(row.graph_generation),
    semanticRevision: numberValue(row.semantic_revision),
    status: stringValue(row.status) as SemanticStateStatus,
    eligibleEntityCount,
    validEmbeddingCount,
    coverage: eligibleEntityCount === 0 ? 1 : validEmbeddingCount / eligibleEntityCount,
    lastError: nullableString(row.last_error),
    failureClass: nullableString(row.failure_class) as SemanticStateRecord["failureClass"],
    normalizedErrorCode: nullableString(row.normalized_error_code),
    failureFingerprint: nullableString(row.failure_fingerprint),
    materialFingerprint: nullableString(row.material_fingerprint),
    diagnostics: parseJson<SemanticStateRecord["diagnostics"]>(row.diagnostics_json, []),
    retryGeneration: numberValue(row.retry_generation),
    retryCount: numberValue(row.retry_count),
    nextRetryEpoch: row.next_retry_epoch === null ? null : numberValue(row.next_retry_epoch),
    updatedAt: stringValue(row.updated_at),
  };
}

function mapPrecisionState(row: SqlRow): PrecisionProviderState {
  const eligibleEdges = numberValue(row.eligible_edges);
  const resolvedEdges = numberValue(row.resolved_edges);
  const status = stringValue(row.status) as PrecisionProviderState["status"];
  return {
    language: stringValue(row.language),
    provider: stringValue(row.provider),
    providerVersion: stringValue(row.provider_version),
    capability: stringValue(row.capability) as PrecisionProviderState["capability"],
    status,
    baseGeneration: numberValue(row.base_generation),
    precisionRevision: numberValue(row.precision_revision),
    eligibleEdges,
    resolvedEdges,
    rejectedEdges: numberValue(row.rejected_edges),
    coverage: status === "ready" || status === "partial" ? (eligibleEdges === 0 ? 1 : resolvedEdges / eligibleEdges) : 0,
    lastError: nullableString(row.last_error),
    leaseExpiresAt: row.lease_expires_epoch === null ? null : new Date(numberValue(row.lease_expires_epoch)).toISOString(),
    updatedAt: stringValue(row.updated_at),
  };
}

function mergeCodeEvidence(groups: Array<CodeEdgeRecord["evidence"]>): NonNullable<CodeEdgeRecord["evidence"]> {
  const key = (item: NonNullable<CodeEdgeRecord["evidence"]>[number]): string =>
    `${item.provider}\0${item.providerVersion}\0${item.source}\0${item.confidence}\0${JSON.stringify(item.sourceSpan ?? null)}\0${JSON.stringify(item.details ?? null)}`;
  const items = new Map<string, NonNullable<CodeEdgeRecord["evidence"]>[number]>();
  for (const item of groups.flatMap((group) => group ?? [])) items.set(key(item), item);
  return [...items.values()].sort((left, right) => key(left).localeCompare(key(right)));
}

function memoryHash(input: Pick<RememberInput, "type" | "topic" | "content">): string {
  return sha256(`${input.type}\0${input.topic.trim().toLocaleLowerCase()}\0${input.content.trim()}`);
}

export interface ContextMeshStorage {
  readonly dbPath: string;
  readonly rootPath: string;
  readonly caseSensitivePaths: boolean;
  readonly caseSensitivityWarning: string | null;
  readonly workspace: WorkspaceRecord;
  close(): void;
  recoverInterruptedRuns(): number;
  getWorkspace(): WorkspaceRecord;
  setOperationalStatus(component: OperationalStatusRecord["component"], status: OperationalStatusRecord["status"], diagnostic?: string | null): void;
  getOperationalStatus(): Record<OperationalStatusRecord["component"], OperationalStatusRecord | null>;
  getFileHashes(): Map<string, string>;
  getIndexedFileBaseline(): IndexedFileBaseline[];
  getIndexConfigHash(): string | null;
  getAdapterState(): AdapterStateMap;
  setAdapterState(state: AdapterStateMap): void;
  updateIndexRunAdapterStats(runId: string, adapterStats: AdapterStats[]): void;
  getPrecisionRevision(): number;
  getPrecisionProviderStates(): PrecisionProviderState[];
  registerPrecisionProvider(input: Omit<PrecisionProviderState, "baseGeneration" | "precisionRevision" | "eligibleEdges" | "resolvedEdges" | "rejectedEdges" | "coverage" | "lastError" | "leaseExpiresAt" | "updatedAt"> & { lastError?: string | null }): void;
  transitionPrecisionProvider(input: Omit<PrecisionProviderState, "baseGeneration" | "precisionRevision" | "eligibleEdges" | "resolvedEdges" | "rejectedEdges" | "coverage" | "lastError" | "leaseExpiresAt" | "updatedAt"> & { lastError?: string | null }): void;
  claimPrecisionProvider(input: { provider: string; providerVersion: string; language: string; capability: "resolved" | "typed"; owner: string; leaseMs?: number }): PrecisionClaimResult;
  heartbeatPrecisionProvider(claim: PrecisionClaim, leaseMs?: number): boolean;
  commitPrecisionOverlay(claim: PrecisionClaim, commit: PrecisionCommit): boolean;
  failPrecisionProvider(claim: PrecisionClaim, error: string): boolean;
  abandonPrecisionProvider(claim: PrecisionClaim, error: string): boolean;
  getFreshnessState(): FreshnessState;
  recordFreshnessStale(
    reason: string,
    expectedGeneration?: number,
    expectedSuccessFence?: number,
  ): boolean;
  recordStrictCheck(timestamp: string): void;
  withReadSnapshot<T>(operation: () => T): Promise<T>;
  hasUnresolvedIndexFailure(): boolean;
  getReverseDependencyClosure(seedPathKeys: Iterable<string>): Set<string>;
  getExistingRelations(): ExistingRelations;
  getStoredGraphPartition(language: "python" | "non-python", includePrecision?: boolean): StoredGraphPartition;
  startIndexRun(mode: IndexMode): IndexRunHandle;
  heartbeatIndexRun(handle: IndexRunHandle): boolean;
  failIndexRun(handle: IndexRunHandle, diagnostics: string[]): void;
  completeNoOpRun(
    handle: IndexRunHandle,
    stats: IndexCommitStats,
    diagnostics: string[],
    indexConfigHash: string,
    adapterStats: AdapterStats[],
    adapterState: AdapterStateMap,
  ): void;
  commitGraph(
    handle: IndexRunHandle,
    graph: ExtractedGraph,
    stats: IndexCommitStats,
    indexConfigHash: string,
    adapterState: AdapterStateMap,
    semantic?: SemanticPlaneCommit,
    semanticClaim?: CodeIndexSemanticClaim,
    semanticGraph?: ExtractedGraph,
  ): void;
  getStatus(): Record<string, unknown>;
  searchCode(query: string, kinds: CodeNodeKind[] | undefined, limit: number, offset?: number): CodeSearchResult[];
  getCodeNode(id: string): CodeSearchResult | null;
  getCodeNodesByIds(ids: string[]): CodeSearchResult[];
  traceCode(
    symbolId: string,
    direction: "in" | "out" | "both",
    edgeKinds: CodeEdgeKind[] | undefined,
    maxDepth: number,
    limit: number,
  ): TraceResult;
  remember(input: RememberInput): RememberResult;
  recall(input: RecallInput): RecallResult;
  recallSnapshot(input: RecallInput): RecallResult;
  recordMemoryAccess(memoryIds: string[], query: string | null, timestamp: string): void;
  getMemoriesLinkedToNodes(nodeIds: string[], limit?: number): MemoryFragmentRecord[];
  getMemoryCodeProvenance(memoryIds: string[]): Map<string, MemoryCodeProvenance[]>;
  getRelatedMemories(memoryIds: string[], limit?: number): MemoryFragmentRecord[];
  getMemoriesByIds(memoryIds: string[], timestamp?: string): MemoryFragmentRecord[];
  reflect(input: ReflectInput): ReflectResult;
  forget(input: ForgetInput): MemoryFragmentRecord;
  configureSemanticModel(model: SemanticModelRegistration): void;
  backfillSemanticSourceHashes(repairMismatches?: boolean): void;
  getSemanticState(plane: SemanticPlane): SemanticStateRecord | null;
  getCurrentCodeSemanticDocuments(): SemanticDocument[];
  getCurrentMemorySemanticDocuments(timestamp?: string): SemanticDocument[];
  iterateSemanticEmbeddings(
    plane: SemanticPlane,
    modelKey: string,
    timestamp?: string,
  ): Iterable<StoredSemanticEmbedding>;
  getSemanticHydrationModel(modelKey: string): SemanticHydrationModel | null;
  iterateSemanticHydrationRows(
    plane: SemanticPlane,
    modelId: number,
    timestamp?: string,
  ): Iterable<RawSemanticHydrationRow>;
  releaseTransientSemanticReadMemory(): void;
  loadSemanticEmbeddings(plane: SemanticPlane, modelKey: string, timestamp?: string): StoredSemanticEmbedding[];
  getEligibleSemanticEntityKeys(
    plane: SemanticPlane,
    timestamp?: string,
    filters?: { kinds?: CodeNodeKind[]; types?: MemoryType[]; topic?: string },
  ): Map<string, string>;
  updateSemanticFailure(
    plane: SemanticPlane,
    primary: SemanticFailureDiagnostic | null,
    diagnostics: readonly SemanticFailureDiagnostic[],
    eligibleEntityCount: number,
    validEmbeddingCount: number,
    materialFingerprint?: string | null,
  ): void;
  claimSemanticReconciliation(
    plane: SemanticPlane,
    owner: SemanticReconciliationOwner,
  ): SemanticReconciliationClaimResult;
  claimCodeIndexEmbedding(
    input: CodeIndexSemanticClaimInput,
    owner: SemanticReconciliationOwner,
  ): CodeIndexSemanticClaimResult;
  heartbeatCodeIndexEmbedding(claim: CodeIndexSemanticClaim): boolean;
  abandonCodeIndexClaim(claim: CodeIndexSemanticClaim, reason: "index_failed" | "lease_lost"): boolean;
  heartbeatSemanticReconciliation(claim: SemanticReconciliationClaim): boolean;
  completeSemanticReconciliationFailure(
    claim: SemanticReconciliationClaim,
    primary: SemanticFailureDiagnostic,
    diagnostics: readonly SemanticFailureDiagnostic[],
    eligibleEntityCount: number,
    validEmbeddingCount: number,
  ): boolean;
  getSemanticClaimDiagnostics(plane: SemanticPlane): SemanticClaimDiagnostics;
  commitCodeSemanticBackfill(
    expectedGeneration: number,
    commit: SemanticPlaneCommit,
    claim?: SemanticReconciliationClaim,
  ): boolean;
  commitMemorySemanticBackfill(
    expectedRevision: number,
    commit: SemanticPlaneCommit,
    timestamp?: string,
    claim?: SemanticReconciliationClaim,
  ): boolean;
  casUpsertMemoryEmbedding(
    capture: MemorySemanticCapture,
    vector: Uint8Array,
    dimensions: number,
    codec: string,
    timestamp?: string,
  ): boolean;
  markSemanticUnavailable(plane: SemanticPlane, error: string): void;
  markSemanticNeedsBackfill(plane: SemanticPlane, error: string): void;
  doctor(): DoctorResult;
}

export class ContextMeshDatabase implements ContextMeshStorage {
  readonly dbPath: string;
  readonly rootPath: string;
  readonly caseSensitivePaths: boolean;
  readonly caseSensitivityWarning: string | null;
  readonly workspace: WorkspaceRecord;
  private readonly db: DatabaseSync;
  private readonly snapshotMutex = new AsyncMutex();
  private readonly clock: () => Date;
  private readonly migrationValidationHook: ((version: number) => void) | undefined;
  private readonly migrationBackupValidationHook: ((backupPath: string) => void) | undefined;
  private readonly indexWriterOwner = `writer_${process.pid}_${randomUUID()}`;
  private lastBulkCommitMs = 0;

  constructor(rootPath: string, databasePath?: string, options: ContextMeshDatabaseOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.migrationValidationHook = options.migrationValidationHook;
    this.migrationBackupValidationHook = options.migrationBackupValidationHook;
    const resolvedRoot = path.resolve(rootPath);
    if (!existsSync(resolvedRoot)) {
      throw new ContextMeshError("INVALID_ARGUMENT", `Workspace does not exist: ${resolvedRoot}`);
    }
    this.rootPath = realpathSync(resolvedRoot);
    const casePolicy = detectPathCaseSensitivity(this.rootPath);
    this.caseSensitivePaths = casePolicy.caseSensitive;
    this.caseSensitivityWarning = casePolicy.warning;
    if (casePolicy.warning) console.error(`[ContextMesh] ${casePolicy.warning}`);
    this.dbPath =
      databasePath === ":memory:"
        ? ":memory:"
        : databasePath
          ? path.resolve(databasePath)
          : path.join(this.rootPath, ".contextmesh", "contextmesh.sqlite3");
    if (this.dbPath !== ":memory:") mkdirSync(path.dirname(this.dbPath), { recursive: true });

    this.db = new DatabaseSync(this.dbPath, { timeout: 5_000, defensive: true });
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    const schemaObjects = this.db.prepare("SELECT count(*) AS count FROM sqlite_schema").get();
    if (numberValue(schemaObjects?.count) === 0) this.db.exec(`PRAGMA page_size = ${PHASE4_PAGE_SIZE}`);
    try {
      this.applyMigrations();
    } catch (error) {
      this.db.close();
      throw error;
    }
    if (this.dbPath !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.recoverInterruptedRuns();
    this.workspace = this.ensureWorkspace();
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async withReadSnapshot<T>(operation: () => T): Promise<T> {
    return this.snapshotMutex.runExclusive(() => {
      this.db.exec("BEGIN DEFERRED");
      try {
        const result = operation();
        if (result instanceof Promise) {
          throw new ContextMeshError("INTERNAL_ERROR", "Read snapshot callback must be synchronous");
        }
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  private applyMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const applied = new Set(
      this.db
        .prepare("SELECT version FROM schema_migrations")
        .all()
        .map((row) => numberValue(row.version)),
    );
    const migrations = readdirSync(MIGRATIONS_DIRECTORY)
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const pendingMigrations = migrations.filter((name) => {
      const version = Number.parseInt(name.split("_", 1)[0] ?? "", 10);
      return Number.isSafeInteger(version) && !applied.has(version);
    });
    if (pendingMigrations.length > 0 && applied.size > 0 && this.dbPath !== ":memory:") {
      const checkpoint = this.db.prepare("PRAGMA wal_checkpoint(FULL)").get();
      const busy = numberValue(checkpoint?.busy);
      const logFrames = numberValue(checkpoint?.log);
      const checkpointedFrames = numberValue(checkpoint?.checkpointed);
      if (busy !== 0 || checkpointedFrames !== logFrames) {
        throw new Error(
          `Migration backup checkpoint incomplete (busy=${busy}, log=${logFrames}, checkpointed=${checkpointedFrames})`,
        );
      }
      const timestamp = this.nowIso().replace(/[:.]/g, "-");
      const backupPath = `${this.dbPath}.backup-${timestamp}`;
      copyFileSync(this.dbPath, backupPath);
      this.migrationBackupValidationHook?.(backupPath);
      this.validateMigrationBackup(backupPath, [...applied].sort((left, right) => left - right));
    }
    const semanticMigrationPending = pendingMigrations.some(
      (name) => Number.parseInt(name.split("_", 1)[0] ?? "", 10) === 4,
    );
    const pageSize = numberValue(this.db.prepare("PRAGMA page_size").get()?.page_size);
    if (semanticMigrationPending && applied.size > 0 && pageSize !== PHASE4_PAGE_SIZE) {
      this.db.exec(
        `PRAGMA wal_checkpoint(FULL);
         PRAGMA journal_mode = DELETE;
         PRAGMA page_size = ${PHASE4_PAGE_SIZE};
         VACUUM;`,
      );
    }
    for (const name of pendingMigrations) {
      const version = Number.parseInt(name.split("_", 1)[0] ?? "", 10);
      const sql = readFileSync(path.join(MIGRATIONS_DIRECTORY, name), "utf8");
      this.transaction(() => {
        const preserved = version === 7 || version === 9 ? this.multilanguageMigrationState() : null;
        this.db.exec(sql);
        this.migrationValidationHook?.(version);
        if (preserved) this.verifyMultilanguageMigration(preserved, version);
        this.db
          .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(version, name, this.nowIso());
      });
    }
  }

  private multilanguageMigrationState(): Record<string, number> {
    const count = (table: string): number =>
      numberValue(this.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count);
    return {
      sourceFiles: count("source_files"), codeNodes: count("code_nodes"), codeEdges: count("code_edges"),
      unresolved: count("unresolved_refs"), memoryLinks: count("memory_code_links"),
      codeFts: count("code_nodes_fts"), memoryFts: count("memory_fragments_fts"),
      generations: numberValue(this.db.prepare("SELECT coalesce(sum(current_generation), 0) AS value FROM workspaces").get()?.value),
    };
  }

  private verifyMultilanguageMigration(before: Record<string, number>, version = 7): void {
    const after = this.multilanguageMigrationState();
    for (const [key, value] of Object.entries(before)) {
      if (after[key] !== value) throw new Error(`Migration ${String(version).padStart(3, "0")} preservation check failed for ${key}`);
    }
    if (this.db.prepare("PRAGMA foreign_key_check").all().length > 0) {
      throw new Error(`Migration ${String(version).padStart(3, "0")} foreign-key validation failed`);
    }
    const missingTargets = numberValue(this.db.prepare(
      `SELECT count(*) AS count FROM memory_code_links link
       WHERE link.code_node_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM code_nodes node WHERE node.id = link.code_node_id)`,
    ).get()?.count);
    if (missingTargets > 0) throw new Error(`Migration ${String(version).padStart(3, "0")} memory link target validation failed`);
  }

  private ensureWorkspace(): WorkspaceRecord {
    const rootPathKey = normalizePathKey(this.rootPath, this.caseSensitivePaths);
    let row = this.db.prepare("SELECT * FROM workspaces WHERE root_path_key = ?").get(rootPathKey);
    if (!row) {
      const existingRows = this.db.prepare("SELECT * FROM workspaces ORDER BY created_at LIMIT 2").all();
      if (existingRows.length === 1) {
        const existing = existingRows[0];
        if (!existing) throw new ContextMeshError("INTERNAL_ERROR", "Workspace lookup failed");
        this.db
          .prepare("UPDATE workspaces SET name = ?, root_path = ?, root_path_key = ?, updated_at = ? WHERE id = ?")
          .run(path.basename(this.rootPath), this.rootPath, rootPathKey, this.nowIso(), stringValue(existing.id));
        row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(stringValue(existing.id));
      } else {
        const id = `ws_${randomUUID()}`;
        const timestamp = this.nowIso();
        this.db
          .prepare(
            "INSERT INTO workspaces(id, name, root_path, root_path_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(id, path.basename(this.rootPath), this.rootPath, rootPathKey, timestamp, timestamp);
        row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
      }
    }
    if (!row) throw new ContextMeshError("INTERNAL_ERROR", "Failed to initialize workspace");
    return mapWorkspace(row);
  }

  recoverInterruptedRuns(): number {
    return this.transaction(() => {
      const nowEpoch = this.databaseEpoch();
      const result = this.db
        .prepare(
          `UPDATE index_runs
           SET status = 'failed', completed_at = ?, diagnostics_json = ?
           WHERE status = 'running'
             AND NOT EXISTS (
               SELECT 1 FROM index_writer_leases lease
               WHERE lease.run_id = index_runs.id
                 AND lease.workspace_id = index_runs.workspace_id
                 AND lease.lease_expiry_epoch > ?
             )`,
        )
        .run(
          this.nowIso(),
          JSON.stringify(["Indexing writer lease expired or the process exited before the run completed"]),
          nowEpoch,
        );
      this.db
        .prepare(
          `DELETE FROM index_writer_leases
           WHERE lease_expiry_epoch <= ?
              OR NOT EXISTS (
                SELECT 1 FROM index_runs run
                WHERE run.id = index_writer_leases.run_id AND run.status = 'running'
              )`,
        )
        .run(nowEpoch);
      return Number(result.changes);
    });
  }

  private validateMigrationBackup(backupPath: string, expectedVersions: number[]): void {
    let backup: DatabaseSync | null = null;
    try {
      backup = new DatabaseSync(backupPath, { readOnly: true, timeout: 5_000, defensive: true });
      const integrity = backup.prepare("PRAGMA integrity_check").all();
      if (
        integrity.length !== 1 ||
        stringValue(integrity[0]?.integrity_check).toLocaleLowerCase("en-US") !== "ok"
      ) {
        throw new Error(`integrity_check returned ${JSON.stringify(integrity)}`);
      }
      const versions = backup
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all()
        .map((row) => numberValue(row.version));
      if (JSON.stringify(versions) !== JSON.stringify(expectedVersions)) {
        throw new Error(`schema versions changed in backup (${versions.join(",")})`);
      }
      const foreignKeyErrors = backup.prepare("PRAGMA foreign_key_check").all();
      if (foreignKeyErrors.length > 0) {
        throw new Error(`foreign_key_check returned ${foreignKeyErrors.length} row(s)`);
      }
    } catch (error) {
      throw new Error(
        `Migration backup validation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (backup?.isOpen) backup.close();
      for (const suffix of ["-wal", "-shm"]) {
        rmSync(`${backupPath}${suffix}`, { force: true });
      }
    }
  }

  getWorkspace(): WorkspaceRecord {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(this.workspace.id);
    if (!row) throw new ContextMeshError("INTERNAL_ERROR", "Workspace record is missing");
    return mapWorkspace(row);
  }

  setOperationalStatus(
    component: OperationalStatusRecord["component"],
    status: OperationalStatusRecord["status"],
    diagnostic: string | null = null,
  ): void {
    this.db.prepare(
      `INSERT INTO operational_status(workspace_id, component, status, diagnostic, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, component) DO UPDATE SET
         status = excluded.status, diagnostic = excluded.diagnostic, updated_at = excluded.updated_at`,
    ).run(this.workspace.id, component, status, diagnostic, this.nowIso());
  }

  getOperationalStatus(): Record<OperationalStatusRecord["component"], OperationalStatusRecord | null> {
    const result: Record<OperationalStatusRecord["component"], OperationalStatusRecord | null> = {
      graph_kernel: null,
      watcher: null,
    };
    const rows = this.db.prepare(
      "SELECT component, status, diagnostic, updated_at FROM operational_status WHERE workspace_id = ? ORDER BY component",
    ).all(this.workspace.id);
    for (const row of rows) {
      const component = stringValue(row.component) as OperationalStatusRecord["component"];
      result[component] = {
        component,
        status: stringValue(row.status) as OperationalStatusRecord["status"],
        diagnostic: nullableString(row.diagnostic),
        updatedAt: stringValue(row.updated_at),
      };
    }
    return result;
  }

  getFileHashes(): Map<string, string> {
    const rows = this.db
      .prepare("SELECT path_key, content_hash FROM source_files WHERE workspace_id = ?")
      .all(this.workspace.id);
    return new Map(rows.map((row) => [stringValue(row.path_key), stringValue(row.content_hash)]));
  }

  getIndexedFileBaseline(): IndexedFileBaseline[] {
    return this.db
      .prepare(
        `SELECT path_key, relative_path, content_hash, size_bytes, mtime_ms, language, ecosystem,
                source_root, adapter_config_hash, parse_status, diagnostic_count
         FROM source_files WHERE workspace_id = ? ORDER BY path_key`,
      )
      .all(this.workspace.id)
      .map((row) => ({
        pathKey: stringValue(row.path_key),
        relativePath: stringValue(row.relative_path),
        contentHash: stringValue(row.content_hash),
        sizeBytes: numberValue(row.size_bytes),
        mtimeMs: numberValue(row.mtime_ms),
        language: nullableString(row.language),
        ecosystem: nullableString(row.ecosystem),
        sourceRoot: stringValue(row.source_root),
        adapterConfigHash: stringValue(row.adapter_config_hash),
        parseStatus: stringValue(row.parse_status) as IndexedFileBaseline["parseStatus"],
        diagnosticCount: numberValue(row.diagnostic_count),
      }));
  }

  getIndexConfigHash(): string | null {
    const row = this.db
      .prepare("SELECT index_config_hash FROM workspaces WHERE id = ?")
      .get(this.workspace.id);
    return nullableString(row?.index_config_hash);
  }

  getFreshnessState(): FreshnessState {
    const workspace = this.db
      .prepare(
        `SELECT workspace.current_generation, workspace.precision_revision,
                workspace.freshness_stale, workspace.freshness_stale_at,
                workspace.freshness_reasons_json, workspace.last_strict_check_at,
                coalesce(max(CASE WHEN run.status IN ('succeeded', 'partial') THEN run.generation END), 0) AS success_generation,
                coalesce(max(CASE WHEN run.status IN ('failed', 'running') THEN run.generation END), 0) AS failure_generation
         FROM workspaces workspace
         LEFT JOIN index_runs run ON run.workspace_id = workspace.id
         WHERE workspace.id = ?
         GROUP BY workspace.id`,
      )
      .get(this.workspace.id);
    if (!workspace) throw new ContextMeshError("INTERNAL_ERROR", "Workspace record is missing");
    const currentGeneration = numberValue(workspace.current_generation);
    const successFenceGeneration = numberValue(workspace.success_generation);
    const failureFenceGeneration = numberValue(workspace.failure_generation);
    const freshnessStale = numberValue(workspace.freshness_stale) === 1;
    return {
      currentGeneration,
      precisionRevision: numberValue(workspace.precision_revision),
      successFenceGeneration,
      failureFenceGeneration,
      freshnessStale,
      freshnessStaleAt: nullableString(workspace.freshness_stale_at),
      freshnessReasons: parseJson<string[]>(workspace.freshness_reasons_json, []),
      lastStrictCheckAt: nullableString(workspace.last_strict_check_at),
      stale:
        currentGeneration > 0 &&
        (freshnessStale || failureFenceGeneration > successFenceGeneration),
    };
  }

  recordFreshnessStale(
    reason: string,
    expectedGeneration?: number,
    expectedSuccessFence?: number,
  ): boolean {
    return this.transaction(() => {
      const state = this.getFreshnessState();
      if (state.currentGeneration === 0) return false;
      if (
        expectedGeneration !== undefined &&
        (state.currentGeneration !== expectedGeneration ||
          state.successFenceGeneration !== expectedSuccessFence)
      ) {
        return false;
      }
      const timestamp = this.nowIso();
      const reasons = unique([...state.freshnessReasons, reason]);
      this.db
        .prepare(
          `UPDATE workspaces SET freshness_stale = 1,
           freshness_stale_at = coalesce(freshness_stale_at, ?), freshness_reasons_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(timestamp, JSON.stringify(reasons), timestamp, this.workspace.id);
      return true;
    });
  }

  recordStrictCheck(timestamp: string): void {
    this.db
      .prepare("UPDATE workspaces SET last_strict_check_at = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, timestamp, this.workspace.id);
  }

  hasUnresolvedIndexFailure(): boolean {
    const state = this.getFreshnessState();
    return state.failureFenceGeneration > state.successFenceGeneration;
  }

  getReverseDependencyClosure(seedPathKeys: Iterable<string>): Set<string> {
    const closure = new Set(seedPathKeys);
    if (closure.size === 0) return closure;
    const rows = this.db
      .prepare(
        `SELECT DISTINCT source_file.path_key AS source_path_key,
                         target_file.path_key AS target_path_key
         FROM code_edges edge
         JOIN code_nodes source_node ON source_node.id = edge.source_id
         JOIN source_files source_file ON source_file.id = source_node.file_id
         JOIN code_nodes target_node ON target_node.id = edge.target_id
         JOIN source_files target_file ON target_file.id = target_node.file_id
         WHERE edge.workspace_id = ? AND source_file.path_key <> target_file.path_key
         ORDER BY target_file.path_key, source_file.path_key`,
      )
      .all(this.workspace.id);
    const reverse = new Map<string, string[]>();
    for (const row of rows) {
      const target = stringValue(row.target_path_key);
      const sources = reverse.get(target) ?? [];
      sources.push(stringValue(row.source_path_key));
      reverse.set(target, sources);
    }
    const queue = [...closure];
    while (queue.length > 0) {
      const target = queue.shift();
      if (!target) continue;
      for (const source of reverse.get(target) ?? []) {
        if (closure.has(source)) continue;
        closure.add(source);
        queue.push(source);
      }
    }
    return closure;
  }

  getExistingRelations(): ExistingRelations {
    const externalNodes = this.db
      .prepare(
        `SELECT n.*, NULL AS relative_path, NULL AS file_content_hash, 0.0 AS score
         FROM code_nodes n WHERE n.workspace_id = ? AND n.file_id IS NULL
         ORDER BY n.qualified_name, n.id`,
      )
      .all(this.workspace.id)
      .map(mapCodeNode);
    const edgeRows = this.db
      .prepare(
        `SELECT edge.*, source_file.path_key AS source_path_key
         FROM code_edges edge
         JOIN code_nodes source_node ON source_node.id = edge.source_id
         LEFT JOIN source_files source_file ON source_file.id = source_node.file_id
         WHERE edge.workspace_id = ? ORDER BY edge.kind, edge.source_id, edge.target_id`,
      )
      .all(this.workspace.id);
    const unresolvedRows = this.db
      .prepare(
        `SELECT reference.*, file.path_key AS file_path_key
         FROM unresolved_refs reference
         JOIN source_files file ON file.id = reference.file_id
         WHERE reference.workspace_id = ?
         ORDER BY file.path_key, reference.line, reference.column, reference.id`,
      )
      .all(this.workspace.id);
    return {
      externalNodes,
      edges: edgeRows.map((row) => ({
        sourcePathKey: nullableString(row.source_path_key),
        edge: {
          workspaceId: stringValue(row.workspace_id),
          sourceId: stringValue(row.source_id),
          targetId: stringValue(row.target_id),
          kind: stringValue(row.kind) as CodeEdgeKind,
          confidence: numberValue(row.confidence),
          resolutionKind: stringValue(row.resolution_kind) as CodeEdgeRecord["resolutionKind"],
          generation: numberValue(row.generation),
          metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
        },
      })),
      unresolved: unresolvedRows.map((row) => ({
        filePathKey: stringValue(row.file_path_key),
        reference: {
          workspaceId: stringValue(row.workspace_id),
          fileId: stringValue(row.file_id),
          sourceNodeId: nullableString(row.source_node_id),
          kind: stringValue(row.kind),
          rawName: stringValue(row.raw_name),
          qualifier: nullableString(row.qualifier),
          line: numberValue(row.line),
          column: numberValue(row.column),
          candidates: parseJson<string[]>(row.candidates_json, []),
          generation: numberValue(row.generation),
        },
      })),
    };
  }

  getAdapterState(): AdapterStateMap {
    const row = this.db
      .prepare("SELECT adapter_state_json FROM workspaces WHERE id = ?")
      .get(this.workspace.id);
    return parseJson<AdapterStateMap>(row?.adapter_state_json, {});
  }

  setAdapterState(state: AdapterStateMap): void {
    this.db.prepare("UPDATE workspaces SET adapter_state_json=?,updated_at=? WHERE id=?")
      .run(JSON.stringify(state), this.nowIso(), this.workspace.id);
  }

  updateIndexRunAdapterStats(runId: string, adapterStats: AdapterStats[]): void {
    this.db.prepare(
      `UPDATE index_runs SET adapter_stats_json=?
       WHERE id=? AND workspace_id=? AND status IN ('succeeded','partial')`,
    ).run(JSON.stringify(adapterStats), runId, this.workspace.id);
  }

  private precisionNodeIds(provider: string): string[] {
    return this.db.prepare(
      "SELECT node_id FROM precision_nodes WHERE workspace_id=? AND provider=? ORDER BY node_id",
    ).all(this.workspace.id, provider).map((row) => stringValue(row.node_id));
  }

  private hasVisiblePrecisionOverlay(provider: string): boolean {
    const generation = this.getWorkspace().currentGeneration;
    return Boolean(this.db.prepare(
      `SELECT 1
       FROM precision_provider_state state
       WHERE state.workspace_id=? AND state.provider=?
         AND state.status IN ('ready','partial','running')
         AND (
           EXISTS(SELECT 1 FROM precision_nodes node
                  WHERE node.workspace_id=state.workspace_id AND node.provider=state.provider
                    AND node.base_generation=? AND node.precision_revision=state.precision_revision)
           OR EXISTS(SELECT 1 FROM precision_edges edge
                     WHERE edge.workspace_id=state.workspace_id AND edge.provider=state.provider
                       AND edge.base_generation=? AND edge.precision_revision=state.precision_revision)
         )
       LIMIT 1`,
    ).get(this.workspace.id, provider, generation, generation));
  }

  private fencePrecisionOverlayWithdrawal(provider: string): void {
    const revision = this.getPrecisionRevision() + 1;
    const timestamp = this.nowIso();
    this.db.prepare("UPDATE workspaces SET precision_revision=?,updated_at=? WHERE id=?")
      .run(revision, timestamp, this.workspace.id);
    this.db.prepare(
      "UPDATE precision_provider_state SET precision_revision=?,updated_at=? WHERE workspace_id=? AND provider=?",
    ).run(revision, timestamp, this.workspace.id, provider);
  }

  private applyPrecisionNodeOverlays<T extends CodeSearchResult>(nodes: T[]): T[] {
    if (nodes.length === 0) return nodes;
    const currentGeneration = this.getWorkspace().currentGeneration;
    if (currentGeneration === 0) return nodes;
    const selectedIds = new Set(nodes.map((node) => node.id));
    const selected = new Map<string, SqlRow>();
    const ids = [...selectedIds].sort();
    for (let offset = 0; offset < ids.length; offset += 400) {
      const chunk = ids.slice(offset, offset + 400);
      const rows = this.db.prepare(
        `SELECT overlay.*
         FROM precision_nodes overlay
         JOIN precision_provider_state state
           ON state.workspace_id=overlay.workspace_id AND state.provider=overlay.provider
         WHERE overlay.workspace_id=? AND overlay.base_generation=?
           AND state.base_generation=overlay.base_generation
           AND state.precision_revision=overlay.precision_revision
           AND state.status IN ('ready','partial','running')
           AND overlay.node_id IN (${placeholders(chunk.length)})
         ORDER BY overlay.node_id,
           CASE overlay.analysis_level WHEN 'typed' THEN 2 ELSE 1 END DESC,
           overlay.precision_revision DESC, overlay.provider ASC`,
      ).all(this.workspace.id, currentGeneration, ...chunk);
      for (const row of rows) {
        const nodeId = stringValue(row.node_id);
        if (!selected.has(nodeId)) selected.set(nodeId, row);
      }
    }
    return nodes.map((node) => {
      const overlay = selected.get(node.id);
      if (!overlay) return node;
      return {
        ...node,
        signature: stringValue(overlay.signature),
        doc: stringValue(overlay.doc),
        contentHash: stringValue(overlay.content_hash),
        metadata: {
          ...node.metadata,
          ...parseJson<Record<string, unknown>>(overlay.metadata_json, {}),
          precisionProvider: stringValue(overlay.provider),
        },
        analysisLevel: stringValue(overlay.analysis_level) as "resolved" | "typed",
      };
    });
  }

  private markCodeSemanticMaterializationChanged(changes: number): void {
    if (changes === 0) return;
    this.supersedeSemanticClaim("code");
    this.db.prepare(
      `UPDATE workspace_semantic_state SET
         semantic_revision=semantic_revision+1,
         status=CASE WHEN failure_class IN ('material_sticky','runtime_retryable','scale_limit')
                     THEN status ELSE 'needs_backfill' END,
         valid_embedding_count=0,last_error=NULL,updated_at=?
       WHERE workspace_id=? AND plane='code'`,
    ).run(this.nowIso(), this.workspace.id);
  }

  private refreshEffectiveNodeMaterializations(nodeIds: Iterable<string>): void {
    const ids = unique([...nodeIds]).sort();
    if (ids.length === 0) return;
    const rows: SqlRow[] = [];
    for (let offset = 0; offset < ids.length; offset += 400) {
      const chunk = ids.slice(offset, offset + 400);
      rows.push(...this.db.prepare(
        `SELECT node.*, file.relative_path, file.content_hash AS file_content_hash, 0.0 AS score
         FROM code_nodes node LEFT JOIN source_files file ON file.id=node.file_id
         WHERE node.workspace_id=? AND node.id IN (${placeholders(chunk.length)})
         ORDER BY node.id`,
      ).all(this.workspace.id, ...chunk));
    }
    const priorHash = new Map(rows.map((row) => [stringValue(row.id), nullableString(row.semantic_source_hash)]));
    const nodes = this.applyPrecisionNodeOverlays(rows.map(mapCodeNode));
    const deleteFts = this.db.prepare("DELETE FROM code_nodes_fts WHERE node_id=?");
    const insertFts = this.db.prepare(
      `INSERT INTO code_nodes_fts(node_id,name,qualified_name,signature,doc,search_tokens)
       VALUES (?,?,?,?,?,?)`,
    );
    const updateHash = this.db.prepare(
      "UPDATE code_nodes SET semantic_source_hash=? WHERE workspace_id=? AND id=? AND semantic_source_hash IS NOT ?",
    );
    let semanticChanges = 0;
    for (const node of nodes) {
      deleteFts.run(node.id);
      insertFts.run(
        node.id,
        node.name,
        node.qualifiedName,
        node.signature,
        node.doc,
        tokenizeIdentifier(`${node.name} ${node.qualifiedName}`),
      );
      const semantic = buildCodeSemanticDocument(node, node.relativePath);
      if (priorHash.get(node.id) !== semantic.sourceHash) {
        semanticChanges += Number(updateHash.run(semantic.sourceHash, this.workspace.id, node.id, semantic.sourceHash).changes);
      }
    }
    this.markCodeSemanticMaterializationChanged(semanticChanges);
  }

  getPrecisionRevision(): number {
    const row = this.db.prepare("SELECT precision_revision FROM workspaces WHERE id = ?").get(this.workspace.id);
    return numberValue(row?.precision_revision);
  }

  getPrecisionProviderStates(): PrecisionProviderState[] {
    return this.db.prepare(
      "SELECT * FROM precision_provider_state WHERE workspace_id = ? ORDER BY language, provider",
    ).all(this.workspace.id).map(mapPrecisionState);
  }

  registerPrecisionProvider(
    input: Omit<PrecisionProviderState, "baseGeneration" | "precisionRevision" | "eligibleEdges" | "resolvedEdges" | "rejectedEdges" | "coverage" | "lastError" | "leaseExpiresAt" | "updatedAt"> & { lastError?: string | null },
  ): void {
    this.transaction(() => {
      const affectedNodes = this.precisionNodeIds(input.provider);
      const overlayWasVisible = this.hasVisiblePrecisionOverlay(input.provider);
      const timestamp = this.nowIso();
      this.db.prepare(
        `INSERT INTO precision_provider_state(
           workspace_id, language, provider, provider_version, capability, status, base_generation, last_error, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, provider) DO UPDATE SET
           language=excluded.language, provider_version=excluded.provider_version,
           capability=excluded.capability,
           status=CASE WHEN precision_provider_state.provider_version <> excluded.provider_version
                       AND precision_provider_state.status IN ('ready','partial') THEN 'stale'
                       ELSE excluded.status END,
           base_generation=excluded.base_generation,last_error=excluded.last_error,updated_at=excluded.updated_at`,
      ).run(this.workspace.id, input.language, input.provider, input.providerVersion, input.capability, input.status,
        this.getWorkspace().currentGeneration, input.lastError ?? null, timestamp);
      const state = this.db.prepare(
        "SELECT status FROM precision_provider_state WHERE workspace_id=? AND provider=?",
      ).get(this.workspace.id, input.provider);
      if (overlayWasVisible && !["ready", "partial", "running"].includes(stringValue(state?.status))) {
        this.fencePrecisionOverlayWithdrawal(input.provider);
      }
      this.refreshEffectiveNodeMaterializations(affectedNodes);
    });
  }

  transitionPrecisionProvider(
    input: Omit<PrecisionProviderState, "baseGeneration" | "precisionRevision" | "eligibleEdges" | "resolvedEdges" | "rejectedEdges" | "coverage" | "lastError" | "leaseExpiresAt" | "updatedAt"> & { lastError?: string | null },
  ): void {
    this.transaction(() => {
      const affectedNodes = this.precisionNodeIds(input.provider);
      const overlayWasVisible = this.hasVisiblePrecisionOverlay(input.provider);
      const currentRevision = this.getPrecisionRevision();
      const nextRevision = overlayWasVisible ? currentRevision + 1 : currentRevision;
      const timestamp = this.nowIso();
      this.db.prepare(
        `INSERT INTO precision_provider_state(
           workspace_id,language,provider,provider_version,capability,status,base_generation,
           precision_revision,last_error,lease_owner,lease_token,lease_expires_epoch,transition_epoch,updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,1,?)
         ON CONFLICT(workspace_id,provider) DO UPDATE SET
           language=excluded.language,provider_version=excluded.provider_version,capability=excluded.capability,
           status=excluded.status,base_generation=excluded.base_generation,
           precision_revision=excluded.precision_revision,last_error=excluded.last_error,
           lease_owner=NULL,lease_token=NULL,lease_expires_epoch=NULL,
           transition_epoch=precision_provider_state.transition_epoch+1,updated_at=excluded.updated_at`,
      ).run(this.workspace.id, input.language, input.provider, input.providerVersion, input.capability, input.status,
        this.getWorkspace().currentGeneration, nextRevision, input.lastError ?? null, timestamp);
      if (overlayWasVisible) {
        this.db.prepare("UPDATE workspaces SET precision_revision=?,updated_at=? WHERE id=?")
          .run(nextRevision, timestamp, this.workspace.id);
      }
      this.refreshEffectiveNodeMaterializations(affectedNodes);
    });
  }

  claimPrecisionProvider(input: {
    provider: string; providerVersion: string; language: string; capability: "resolved" | "typed"; owner: string; leaseMs?: number;
  }): PrecisionClaimResult {
    const workspace = this.getWorkspace();
    if (workspace.currentGeneration === 0) return { claim: null, reason: "not_indexed" };
    const now = Date.parse(this.nowIso());
    const leaseExpiry = now + (input.leaseMs ?? 30_000);
    const token = `precision_${randomUUID()}`;
    let acquired = false;
    let transitionEpoch = 0;
    this.transaction(() => {
      const affectedNodes = this.precisionNodeIds(input.provider);
      const existing = this.db.prepare(
        "SELECT status, lease_expires_epoch FROM precision_provider_state WHERE workspace_id=? AND provider=?",
      ).get(this.workspace.id, input.provider);
      if (existing && stringValue(existing.status) === "running" && numberValue(existing.lease_expires_epoch) > now) return;
      this.db.prepare(
        `INSERT INTO precision_provider_state(
           workspace_id,language,provider,provider_version,capability,status,base_generation,
           lease_owner,lease_token,lease_expires_epoch,transition_epoch,updated_at
         ) VALUES (?,?,?,?,?,'running',?,?,?,?,1,?)
         ON CONFLICT(workspace_id,provider) DO UPDATE SET
           language=excluded.language,provider_version=excluded.provider_version,capability=excluded.capability,
           status='running',base_generation=excluded.base_generation,last_error=NULL,
           lease_owner=excluded.lease_owner,lease_token=excluded.lease_token,
           lease_expires_epoch=excluded.lease_expires_epoch,
           transition_epoch=precision_provider_state.transition_epoch+1,updated_at=excluded.updated_at`,
      ).run(this.workspace.id, input.language, input.provider, input.providerVersion, input.capability,
        workspace.currentGeneration, input.owner, token, leaseExpiry, this.nowIso());
      transitionEpoch = numberValue(this.db.prepare(
        "SELECT transition_epoch FROM precision_provider_state WHERE workspace_id=? AND provider=?",
      ).get(this.workspace.id, input.provider)?.transition_epoch);
      this.refreshEffectiveNodeMaterializations(affectedNodes);
      acquired = true;
    });
    return acquired ? { claim: { provider: input.provider, providerVersion: input.providerVersion, language: input.language,
      capability: input.capability, baseGeneration: workspace.currentGeneration, transitionEpoch, token, owner: input.owner }, reason: "acquired" }
      : { claim: null, reason: "leased" };
  }

  heartbeatPrecisionProvider(claim: PrecisionClaim, leaseMs = 30_000): boolean {
    const nowIso = this.nowIso();
    const now = Date.parse(nowIso);
    const expiry = now + leaseMs;
    const result = this.db.prepare(
      `UPDATE precision_provider_state SET lease_expires_epoch=?,updated_at=?
       WHERE workspace_id=? AND provider=? AND provider_version=? AND status='running'
         AND lease_token=? AND lease_owner=? AND base_generation=? AND transition_epoch=? AND lease_expires_epoch>?`,
    ).run(expiry, nowIso, this.workspace.id, claim.provider, claim.providerVersion, claim.token, claim.owner,
      claim.baseGeneration, claim.transitionEpoch, now);
    return Number(result.changes) === 1;
  }

  commitPrecisionOverlay(claim: PrecisionClaim, commit: PrecisionCommit): boolean {
    let committed = false;
    this.transaction(() => {
      const current = this.getWorkspace().currentGeneration;
      const state = this.db.prepare(
        "SELECT status,provider_version,lease_token,lease_owner,base_generation,precision_revision,lease_expires_epoch,transition_epoch FROM precision_provider_state WHERE workspace_id=? AND provider=?",
      ).get(this.workspace.id, claim.provider);
      if (current !== claim.baseGeneration || !state || stringValue(state.status) !== "running" ||
          stringValue(state.provider_version) !== claim.providerVersion ||
          stringValue(state.lease_token) !== claim.token || stringValue(state.lease_owner) !== claim.owner ||
          numberValue(state.base_generation) !== claim.baseGeneration ||
          numberValue(state.transition_epoch) !== claim.transitionEpoch ||
          numberValue(state.lease_expires_epoch) <= Date.parse(this.nowIso())) return;
      const rejectCommit = (reason: string): void => {
        const overlayWasVisible = this.hasVisiblePrecisionOverlay(claim.provider);
        const result = this.db.prepare(
          `UPDATE precision_provider_state SET status='failed',last_error=?,lease_owner=NULL,lease_token=NULL,
             lease_expires_epoch=NULL,updated_at=?
           WHERE workspace_id=? AND provider=? AND provider_version=? AND status='running'
             AND lease_token=? AND lease_owner=? AND base_generation=? AND transition_epoch=?`,
        ).run(`PRECISION_OVERLAY_INVALID: ${reason}`, this.nowIso(), this.workspace.id, claim.provider,
          claim.providerVersion, claim.token, claim.owner, claim.baseGeneration, claim.transitionEpoch);
        if (overlayWasVisible && Number(result.changes) === 1) {
          const affectedNodes = this.precisionNodeIds(claim.provider);
          this.fencePrecisionOverlayWithdrawal(claim.provider);
          this.refreshEffectiveNodeMaterializations(affectedNodes);
        }
      };
      const sorted = [...commit.edges].sort((left, right) =>
        `${left.kind}\0${left.sourceId}\0${left.targetId}`.localeCompare(`${right.kind}\0${right.sourceId}\0${right.targetId}`));
      const sortedNodes = [...(commit.nodes ?? [])].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
      if (!Number.isSafeInteger(commit.eligibleEdges) || commit.eligibleEdges < 0) {
        rejectCommit("eligibleEdges must be a non-negative safe integer");
        return;
      }
      if (new Set(sorted.map((edge) => `${edge.sourceId}\0${edge.targetId}\0${edge.kind}`)).size !== sorted.length) {
        rejectCommit("duplicate precision edge");
        return;
      }
      if (new Set(sortedNodes.map((node) => node.nodeId)).size !== sortedNodes.length) {
        rejectCommit("duplicate precision node");
        return;
      }
      if (claim.capability === "resolved" && sortedNodes.some((node) => node.analysisLevel === "typed")) {
        rejectCommit("resolved provider cannot commit typed node metadata");
        return;
      }
      const baseNode = this.db.prepare(
        "SELECT content_hash,generation,language FROM code_nodes WHERE workspace_id=? AND id=?",
      );
      const languageMatches = (nodeLanguage: string): boolean => claim.language === "typescript/javascript"
        ? ["typescript", "tsx", "javascript", "jsx", "mjs", "cjs"].includes(nodeLanguage)
        : nodeLanguage === claim.language;
      if (sortedNodes.some((node) => {
        const row = baseNode.get(this.workspace.id, node.nodeId);
        const nodeLanguage = stringValue(row?.language);
        return !row || numberValue(row.generation) !== claim.baseGeneration ||
          !languageMatches(nodeLanguage) || stringValue(row.content_hash) !== node.contentHash ||
          !node.metadata || Array.isArray(node.metadata);
      })) {
        rejectCommit("node overlay is outside the provider generation, language, or content identity");
        return;
      }
      const semanticEvidenceSources = new Set(["resolver", "type_checker", "language_server", "manifest"]);
      for (const edge of sorted) {
        const source = baseNode.get(this.workspace.id, edge.sourceId);
        const target = baseNode.get(this.workspace.id, edge.targetId);
        if (!source || !target || numberValue(source.generation) !== claim.baseGeneration ||
            numberValue(target.generation) !== claim.baseGeneration) {
          rejectCommit("edge endpoint is outside the active base generation");
          return;
        }
        if (!languageMatches(stringValue(source.language)) || !languageMatches(stringValue(target.language))) {
          rejectCommit("edge endpoint is outside the claiming provider language");
          return;
        }
        if (!Number.isFinite(edge.confidence) || edge.confidence < 0 || edge.confidence > 1) {
          rejectCommit("edge confidence must be between zero and one");
          return;
        }
        if (!Array.isArray(edge.evidence) || edge.evidence.length === 0 || edge.evidence.some((item) =>
          item.provider !== claim.provider || item.providerVersion !== claim.providerVersion ||
          !semanticEvidenceSources.has(item.source) || !Number.isFinite(item.confidence) ||
          item.confidence < 0 || item.confidence > 1 || Math.abs(item.confidence - edge.confidence) > 1e-9 ||
          (item.details !== undefined && (!item.details || Array.isArray(item.details))))) {
          rejectCommit("edge evidence does not match the claiming provider contract");
          return;
        }
      }
      const baseCandidate = this.db.prepare(
        `SELECT 1 FROM code_edges
         WHERE workspace_id=? AND source_id=? AND target_id=? AND kind=?
           AND status='candidate' AND generation=? LIMIT 1`,
      );
      if (sorted.some((edge) => edge.status === "rejected" && !baseCandidate.get(
        this.workspace.id, edge.sourceId, edge.targetId, edge.kind, claim.baseGeneration,
      ))) {
        rejectCommit("rejected edge has no current base candidate");
        return;
      }
      const currentRevision = this.getPrecisionRevision();
      const priorEdges = this.db.prepare(
        `SELECT source_id,target_id,kind,status,confidence,resolution_kind,evidence_json
         FROM precision_edges WHERE workspace_id=? AND provider=? AND base_generation=? AND precision_revision=?
         ORDER BY kind,source_id,target_id`,
      ).all(this.workspace.id, claim.provider, claim.baseGeneration, numberValue(state.precision_revision));
      const priorNodes = this.db.prepare(
        `SELECT node_id,analysis_level,signature,doc,content_hash,metadata_json
         FROM precision_nodes WHERE workspace_id=? AND provider=? AND base_generation=? AND precision_revision=?
         ORDER BY node_id`,
      ).all(this.workspace.id, claim.provider, claim.baseGeneration, numberValue(state.precision_revision));
      const desiredEdges = sorted.map((edge) => ({
        source_id: edge.sourceId, target_id: edge.targetId, kind: edge.kind, status: edge.status,
        confidence: edge.confidence, resolution_kind: edge.resolutionKind, evidence_json: JSON.stringify(edge.evidence),
      }));
      const desiredNodes = sortedNodes.map((node) => ({
        node_id: node.nodeId, analysis_level: node.analysisLevel, signature: node.signature, doc: node.doc,
        content_hash: node.contentHash, metadata_json: JSON.stringify(node.metadata),
      }));
      const graphChanged = JSON.stringify(priorEdges) !== JSON.stringify(desiredEdges) ||
        JSON.stringify(priorNodes) !== JSON.stringify(desiredNodes);
      const revision = graphChanged ? currentRevision + 1 : currentRevision;
      const affectedNodes = new Set(this.precisionNodeIds(claim.provider));
      if (graphChanged) {
        this.db.prepare("DELETE FROM precision_edges WHERE workspace_id=? AND provider=?").run(this.workspace.id, claim.provider);
        this.db.prepare("DELETE FROM precision_nodes WHERE workspace_id=? AND provider=?").run(this.workspace.id, claim.provider);
      }
      const insert = this.db.prepare(
        `INSERT INTO precision_edges(workspace_id,provider,source_id,target_id,kind,status,confidence,resolution_kind,evidence_json,base_generation,precision_revision)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      );
      if (graphChanged) {
        for (const edge of sorted) insert.run(this.workspace.id, claim.provider, edge.sourceId, edge.targetId, edge.kind,
          edge.status, edge.confidence, edge.resolutionKind, JSON.stringify(edge.evidence), claim.baseGeneration, revision);
      }
      const insertNode = this.db.prepare(
        `INSERT INTO precision_nodes(
           workspace_id,provider,node_id,analysis_level,signature,doc,content_hash,metadata_json,
           base_generation,precision_revision
         ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      );
      if (graphChanged) {
        for (const node of sortedNodes) {
          insertNode.run(
            this.workspace.id,
            claim.provider,
            node.nodeId,
            node.analysisLevel,
            node.signature,
            node.doc,
            node.contentHash,
            JSON.stringify(node.metadata),
            claim.baseGeneration,
            revision,
          );
          affectedNodes.add(node.nodeId);
        }
      }
      const resolved = sorted.filter((edge) => edge.status === "resolved").length;
      const rejected = sorted.filter((edge) => edge.status === "rejected").length;
      if (graphChanged) {
        this.db.prepare("UPDATE workspaces SET precision_revision=?,updated_at=? WHERE id=?")
          .run(revision, this.nowIso(), this.workspace.id);
      }
      const stateUpdate = this.db.prepare(
        `UPDATE precision_provider_state SET status=?,precision_revision=?,eligible_edges=?,resolved_edges=?,rejected_edges=?,
         last_error=?,lease_owner=NULL,lease_token=NULL,lease_expires_epoch=NULL,updated_at=?
         WHERE workspace_id=? AND provider=? AND provider_version=? AND status='running'
           AND lease_token=? AND lease_owner=? AND base_generation=? AND transition_epoch=?`,
      ).run(commit.partial ? "partial" : "ready", revision, commit.eligibleEdges, resolved, rejected,
        commit.diagnostics.length > 0 ? commit.diagnostics.join("; ") : null, this.nowIso(), this.workspace.id, claim.provider,
        claim.providerVersion, claim.token, claim.owner, claim.baseGeneration, claim.transitionEpoch);
      if (Number(stateUpdate.changes) !== 1) return;
      this.refreshEffectiveNodeMaterializations(affectedNodes);
      committed = true;
    });
    return committed;
  }

  failPrecisionProvider(claim: PrecisionClaim, error: string): boolean {
    return this.transaction(() => {
      const affectedNodes = this.precisionNodeIds(claim.provider);
      const overlayWasVisible = this.hasVisiblePrecisionOverlay(claim.provider);
      const nowIso = this.nowIso();
      const now = Date.parse(nowIso);
      const result = this.db.prepare(
        `UPDATE precision_provider_state SET status='failed',last_error=?,lease_owner=NULL,lease_token=NULL,
         lease_expires_epoch=NULL,updated_at=? WHERE workspace_id=? AND provider=? AND status='running'
         AND provider_version=? AND lease_token=? AND lease_owner=? AND base_generation=?
         AND transition_epoch=? AND lease_expires_epoch>?`,
      ).run(error, nowIso, this.workspace.id, claim.provider, claim.providerVersion, claim.token, claim.owner,
        claim.baseGeneration, claim.transitionEpoch, now);
      if (Number(result.changes) === 1) {
        if (overlayWasVisible) this.fencePrecisionOverlayWithdrawal(claim.provider);
        this.refreshEffectiveNodeMaterializations(affectedNodes);
      }
      return Number(result.changes) === 1;
    });
  }

  abandonPrecisionProvider(claim: PrecisionClaim, error: string): boolean {
    return this.transaction(() => {
      const affectedNodes = this.precisionNodeIds(claim.provider);
      const overlayWasVisible = this.hasVisiblePrecisionOverlay(claim.provider);
      const timestamp = this.nowIso();
      const result = this.db.prepare(
        `UPDATE precision_provider_state SET status='failed',last_error=?,lease_owner=NULL,lease_token=NULL,
         lease_expires_epoch=NULL,updated_at=? WHERE workspace_id=? AND provider=? AND status='running'
         AND provider_version=? AND lease_token=? AND lease_owner=? AND base_generation=? AND transition_epoch=?`,
      ).run(error, timestamp, this.workspace.id, claim.provider, claim.providerVersion, claim.token, claim.owner,
        claim.baseGeneration, claim.transitionEpoch);
      if (Number(result.changes) === 1) {
        if (overlayWasVisible) this.fencePrecisionOverlayWithdrawal(claim.provider);
        this.refreshEffectiveNodeMaterializations(affectedNodes);
      }
      return Number(result.changes) === 1;
    });
  }

  getStoredGraphPartition(language: "python" | "non-python", includePrecision = true): StoredGraphPartition {
    const comparison = language === "python" ? "=" : "<>";
    const nodeRows = this.db.prepare(
      `SELECT n.*, f.relative_path, f.content_hash AS file_content_hash, 0 AS score
       FROM code_nodes n LEFT JOIN source_files f ON f.id=n.file_id
       WHERE n.workspace_id=? AND n.language ${comparison} 'python' ORDER BY n.id`,
    ).all(this.workspace.id);
    const baseNodes = nodeRows.map(mapCodeNode);
    const nodes = includePrecision ? this.applyPrecisionNodeOverlays(baseNodes) : baseNodes;
    const ids = new Set(nodes.map((node) => node.id));
    const edgeRows = this.db.prepare(
      `SELECT edge.* FROM code_edges edge
       JOIN code_nodes source ON source.id=edge.source_id
       JOIN code_nodes target ON target.id=edge.target_id
       WHERE edge.workspace_id=? AND source.language ${comparison} 'python' AND target.language ${comparison} 'python'
       ORDER BY edge.kind,edge.source_id,edge.target_id`,
    ).all(this.workspace.id);
    const precisionRows = this.db.prepare(
      `SELECT edge.* FROM precision_edges edge
       JOIN precision_provider_state state ON state.workspace_id=edge.workspace_id AND state.provider=edge.provider
       JOIN code_nodes source ON source.id=edge.source_id
       JOIN code_nodes target ON target.id=edge.target_id
       WHERE edge.workspace_id=? AND edge.base_generation=?
         AND state.base_generation=edge.base_generation
         AND state.precision_revision=edge.precision_revision
         AND state.status IN ('ready','partial','running')
         AND source.language ${comparison} 'python' AND target.language ${comparison} 'python'
       ORDER BY edge.kind,edge.source_id,edge.target_id,edge.provider`,
    ).all(this.workspace.id, this.getWorkspace().currentGeneration);
    const unresolvedRows = this.db.prepare(
      `SELECT reference.* FROM unresolved_refs reference JOIN source_files file ON file.id=reference.file_id
       WHERE reference.workspace_id=? AND file.language ${comparison} 'python'
       ORDER BY reference.file_id,reference.line,reference.column`,
    ).all(this.workspace.id);
    const baseEdges: CodeEdgeRecord[] = edgeRows.filter((row) => ids.has(stringValue(row.source_id)) && ids.has(stringValue(row.target_id))).map((row) => ({
        workspaceId: stringValue(row.workspace_id), sourceId: stringValue(row.source_id), targetId: stringValue(row.target_id),
        kind: stringValue(row.kind) as CodeEdgeKind, confidence: numberValue(row.confidence),
        resolutionKind: stringValue(row.resolution_kind) as CodeEdgeRecord["resolutionKind"], generation: numberValue(row.generation),
        metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}), status: stringValue(row.status) as EdgeStatus,
        evidence: parseJson<NonNullable<CodeEdgeRecord["evidence"]>>(row.evidence_json, []),
      }));
    const edgeKey = (edge: Pick<CodeEdgeRecord, "sourceId" | "targetId" | "kind">): string => `${edge.sourceId}\0${edge.targetId}\0${edge.kind}`;
    const effective = new Map<string, CodeEdgeRecord>(baseEdges.map((edge) => [edgeKey(edge), edge]));
    for (const row of includePrecision ? precisionRows : []) {
      const overlay: CodeEdgeRecord = {
        workspaceId: stringValue(row.workspace_id), sourceId: stringValue(row.source_id), targetId: stringValue(row.target_id),
        kind: stringValue(row.kind) as CodeEdgeKind, confidence: numberValue(row.confidence),
        resolutionKind: stringValue(row.resolution_kind) as CodeEdgeRecord["resolutionKind"],
        generation: numberValue(row.base_generation), metadata: { precisionProvider: stringValue(row.provider) },
        status: stringValue(row.status) as EdgeStatus, evidence: parseJson(row.evidence_json, []),
      };
      const key = edgeKey(overlay);
      const prior = effective.get(key);
      if (!prior) { effective.set(key, overlay); continue; }
      const rank = (status: EdgeStatus | undefined): number => status === "resolved" ? 3 : status === "rejected" ? 2 : 1;
      effective.set(key, {
        ...(rank(overlay.status) >= rank(prior.status) ? overlay : prior),
        evidence: mergeCodeEvidence([prior.evidence, overlay.evidence]),
        metadata: { ...prior.metadata, precisionProviders: [...new Set([...(Array.isArray(prior.metadata.precisionProviders) ? prior.metadata.precisionProviders.filter((item): item is string => typeof item === "string") : []), stringValue(row.provider)])].sort() },
      });
    }
    return {
      nodes,
      edges: [...effective.values()].sort((left, right) => edgeKey(left).localeCompare(edgeKey(right))),
      unresolvedReferences: unresolvedRows.map((row) => ({
        workspaceId: stringValue(row.workspace_id), fileId: stringValue(row.file_id), sourceNodeId: nullableString(row.source_node_id),
        kind: stringValue(row.kind), rawName: stringValue(row.raw_name), qualifier: nullableString(row.qualifier),
        line: numberValue(row.line), column: numberValue(row.column), candidates: parseJson(row.candidates_json, []),
        generation: numberValue(row.generation), confidence: numberValue(row.confidence), evidence: parseJson(row.evidence_json, []),
      })),
    };
  }

  startIndexRun(mode: IndexMode): IndexRunHandle {
    return this.transaction(() => {
      const nowEpoch = this.databaseEpoch();
      const activeLease = this.db
        .prepare(
          `SELECT run_id, lease_expiry_epoch FROM index_writer_leases
           WHERE workspace_id = ?`,
        )
        .get(this.workspace.id);
      if (activeLease && numberValue(activeLease.lease_expiry_epoch) > nowEpoch) {
        throw new ContextMeshError("DB_BUSY", "Another index writer holds the workspace lease");
      }
      if (activeLease) {
        this.db
          .prepare(
            `UPDATE index_runs SET status = 'failed', failed_files = 1,
               diagnostics_json = ?, completed_at = ?
             WHERE id = ? AND workspace_id = ? AND status = 'running'`,
          )
          .run(
            JSON.stringify(["Indexing writer lease expired before the run completed"]),
            this.nowIso(),
            stringValue(activeLease.run_id),
            this.workspace.id,
          );
        this.db.prepare("DELETE FROM index_writer_leases WHERE workspace_id = ?").run(this.workspace.id);
      }

      const latestRun = this.db
        .prepare("SELECT max(generation) AS generation FROM index_runs WHERE workspace_id = ?")
        .get(this.workspace.id);
      const handle: IndexRunHandle = {
        id: `idx_${randomUUID()}`,
        generation: numberValue(latestRun?.generation) + 1,
        mode,
        leaseOwner: this.indexWriterOwner,
        leaseToken: `iwl_${randomUUID()}`,
      };
      const timestamp = this.nowIso();
      this.db
        .prepare(
          `INSERT INTO index_runs(id, workspace_id, generation, mode, status, started_at)
           VALUES (?, ?, ?, ?, 'running', ?)`,
        )
        .run(handle.id, this.workspace.id, handle.generation, handle.mode, timestamp);
      this.db
        .prepare(
          `INSERT INTO index_writer_leases(
             workspace_id, run_id, owner_id, lease_token, heartbeat_epoch,
             lease_expiry_epoch, acquired_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.workspace.id,
          handle.id,
          handle.leaseOwner,
          handle.leaseToken,
          nowEpoch,
          nowEpoch + INDEX_WRITER_LEASE_SECONDS,
          timestamp,
          timestamp,
        );
      return handle;
    });
  }

  heartbeatIndexRun(handle: IndexRunHandle): boolean {
    return this.transaction(() => {
      const nowEpoch = this.databaseEpoch();
      const result = this.db
        .prepare(
          `UPDATE index_writer_leases SET
             heartbeat_epoch = ?, lease_expiry_epoch = ?, updated_at = ?
           WHERE workspace_id = ? AND run_id = ? AND owner_id = ? AND lease_token = ?
             AND lease_expiry_epoch > ?
             AND EXISTS (
               SELECT 1 FROM index_runs run
               WHERE run.id = index_writer_leases.run_id AND run.status = 'running'
             )`,
        )
        .run(
          nowEpoch,
          nowEpoch + INDEX_WRITER_LEASE_SECONDS,
          this.nowIso(),
          this.workspace.id,
          handle.id,
          handle.leaseOwner,
          handle.leaseToken,
          nowEpoch,
        );
      return Number(result.changes) === 1;
    });
  }

  private assertIndexWriterLease(handle: IndexRunHandle): void {
    const nowEpoch = this.databaseEpoch();
    const row = this.db
      .prepare(
        `SELECT lease.lease_expiry_epoch, run.status
         FROM index_writer_leases lease
         JOIN index_runs run ON run.id = lease.run_id
         WHERE lease.workspace_id = ? AND lease.run_id = ?
           AND lease.owner_id = ? AND lease.lease_token = ?`,
      )
      .get(this.workspace.id, handle.id, handle.leaseOwner, handle.leaseToken);
    if (
      !row ||
      stringValue(row.status) !== "running" ||
      numberValue(row.lease_expiry_epoch) <= nowEpoch
    ) {
      throw new ContextMeshError("DB_BUSY", "Index writer lease was lost or expired");
    }
  }

  private releaseIndexWriterLease(handle: IndexRunHandle): void {
    const result = this.db
      .prepare(
        `DELETE FROM index_writer_leases
         WHERE workspace_id = ? AND run_id = ? AND owner_id = ? AND lease_token = ?`,
      )
      .run(this.workspace.id, handle.id, handle.leaseOwner, handle.leaseToken);
    if (Number(result.changes) !== 1) {
      throw new ContextMeshError("DB_BUSY", "Index writer lease could not be released");
    }
  }

  failIndexRun(handle: IndexRunHandle, diagnostics: string[]): void {
    this.transaction(() => {
      this.assertIndexWriterLease(handle);
      const result = this.db
        .prepare(
          `UPDATE index_runs SET status = 'failed', failed_files = 1,
           diagnostics_json = ?, completed_at = ?
           WHERE id = ? AND workspace_id = ? AND status = 'running'`,
        )
        .run(JSON.stringify(diagnostics), this.nowIso(), handle.id, this.workspace.id);
      if (Number(result.changes) !== 1) {
        throw new ContextMeshError("DB_BUSY", "Index run is no longer owned by this writer");
      }
      this.releaseIndexWriterLease(handle);
    });
  }

  completeNoOpRun(
    handle: IndexRunHandle,
    stats: IndexCommitStats,
    diagnostics: string[],
    indexConfigHash: string,
    adapterStats: AdapterStats[],
    adapterState: AdapterStateMap,
  ): void {
    const timestamp = this.nowIso();
    this.transaction(() => {
      this.assertIndexWriterLease(handle);
      this.db
        .prepare(
          `UPDATE index_runs SET status = 'succeeded', scanned_files = ?, changed_files = ?,
           deleted_files = ?, failed_files = ?, diagnostics_json = ?, adapter_stats_json = ?, completed_at = ? WHERE id = ?`,
        )
        .run(
          stats.scannedFiles,
          stats.changedFiles,
          stats.deletedFiles,
          stats.failedFiles,
          JSON.stringify(diagnostics),
          JSON.stringify(adapterStats),
          timestamp,
          handle.id,
        );
      this.db
        .prepare(
          `UPDATE workspaces SET index_config_hash = ?, adapter_state_json = ?, freshness_stale = 0,
           freshness_stale_at = NULL, freshness_reasons_json = '[]', updated_at = ? WHERE id = ?`,
        )
        .run(indexConfigHash, JSON.stringify(adapterState), timestamp, this.workspace.id);
      this.releaseIndexWriterLease(handle);
    });
  }

  private relinkStaleMemoryCodeLinks(timestamp: string): number {
    const staleLinks = this.db
      .prepare(
        `SELECT id, memory_id, locator_snapshot_json, language
         FROM memory_code_links WHERE workspace_id = ? AND code_node_id IS NULL`,
      )
      .all(this.workspace.id);
    if (staleLinks.length === 0) return 0;

    const nodeRows = this.db
      .prepare(
        `SELECT n.id, n.local_key, n.kind, n.name, n.qualified_name, n.content_hash, n.language,
                n.start_line, n.end_line, f.relative_path
         FROM code_nodes n LEFT JOIN source_files f ON f.id = n.file_id
         WHERE n.workspace_id = ? ORDER BY n.qualified_name, n.id`,
      )
      .all(this.workspace.id);
    const byHash = new Map<string, SqlRow[]>();
    const bySuffix = new Map<string, SqlRow[]>();
    const byKindAndName = new Map<string, SqlRow[]>();
    const addCandidate = (index: Map<string, SqlRow[]>, key: string, row: SqlRow): void => {
      const matches = index.get(key) ?? [];
      matches.push(row);
      index.set(key, matches);
    };
    for (const row of nodeRows) {
      const qualifiedName = stringValue(row.qualified_name);
      const separator = qualifiedName.indexOf("#");
      const suffix = separator >= 0 ? qualifiedName.slice(separator + 1) : qualifiedName;
      addCandidate(byHash, stringValue(row.content_hash), row);
      addCandidate(bySuffix, suffix, row);
      addCandidate(byKindAndName, `${stringValue(row.kind)}\0${stringValue(row.name)}`, row);
    }

    const update = this.db.prepare(
      `UPDATE memory_code_links
       SET code_node_id = ?, node_local_key = ?, confidence = ?, locator_snapshot_json = ?
       WHERE id = ? AND code_node_id IS NULL`,
    );
    const event = this.db.prepare(
      `INSERT INTO memory_events(workspace_id, fragment_id, event_type, payload_json, created_at)
       VALUES (?, ?, 'linked', ?, ?)`,
    );
    let relinked = 0;
    for (const link of staleLinks) {
      const snapshot = parseJson<Record<string, unknown>>(link.locator_snapshot_json, {});
      const qualifiedName = typeof snapshot.qualifiedName === "string" ? snapshot.qualifiedName : "";
      const separator = qualifiedName.indexOf("#");
      const suffix = separator >= 0 ? qualifiedName.slice(separator + 1) : qualifiedName;
      const contentHash = typeof snapshot.contentHash === "string" ? snapshot.contentHash : "";
      const kind = typeof snapshot.kind === "string" ? snapshot.kind : "";
      const name =
        typeof snapshot.name === "string"
          ? snapshot.name
          : suffix.includes(".")
            ? suffix.slice(suffix.lastIndexOf(".") + 1)
            : suffix;

      const linkLanguage = nullableString(link.language);
      const sameLanguage = (row: SqlRow): boolean => !linkLanguage || stringValue(row.language) === linkLanguage;

      let candidates = contentHash ? (byHash.get(contentHash) ?? []).filter(sameLanguage) : [];
      let confidence = 0.95;
      let strategy = "content_hash";
      if (candidates.length !== 1) {
        candidates = suffix ? (bySuffix.get(suffix) ?? []).filter(sameLanguage) : [];
        confidence = 0.85;
        strategy = "qualified_name_suffix";
      }
      if (candidates.length !== 1 && kind && name) {
        candidates = (byKindAndName.get(`${kind}\0${name}`) ?? []).filter(sameLanguage);
        confidence = 0.65;
        strategy = "kind_and_name";
      }
      if (candidates.length !== 1) continue;

      const candidate = candidates[0];
      if (!candidate) continue;
      const currentLocator = {
        relativePath: nullableString(candidate.relative_path),
        qualifiedName: stringValue(candidate.qualified_name),
        kind: stringValue(candidate.kind),
        name: stringValue(candidate.name),
        contentHash: stringValue(candidate.content_hash),
        startLine: numberValue(candidate.start_line),
        endLine: numberValue(candidate.end_line),
        relinkedFrom: {
          relativePath: snapshot.relativePath ?? null,
          qualifiedName: snapshot.qualifiedName ?? null,
          kind: snapshot.kind ?? null,
          name: snapshot.name ?? null,
          contentHash: snapshot.contentHash ?? null,
          startLine: snapshot.startLine ?? null,
          endLine: snapshot.endLine ?? null,
        },
        relinkStrategy: strategy,
      };
      const result = update.run(
        stringValue(candidate.id),
        stringValue(candidate.local_key),
        confidence,
        JSON.stringify(currentLocator),
        numberValue(link.id),
      );
      if (Number(result.changes) === 0) continue;
      relinked += 1;
      event.run(
        this.workspace.id,
        stringValue(link.memory_id),
        JSON.stringify({ codeNodeId: stringValue(candidate.id), strategy, confidence }),
        timestamp,
      );
    }
    return relinked;
  }

  private semanticStatusForCounts(
    eligibleEntityCount: number,
    validEmbeddingCount: number,
    unavailable: boolean,
  ): SemanticStateStatus {
    if (unavailable) return "unavailable";
    if (eligibleEntityCount === validEmbeddingCount) return "ready";
    return validEmbeddingCount > 0 ? "partial" : "needs_backfill";
  }

  private databaseEpoch(): number {
    return numberValue(this.db.prepare("SELECT unixepoch('now') AS epoch").get()?.epoch);
  }

  private databaseIso(): string {
    return stringValue(
      this.db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS timestamp").get()?.timestamp,
    );
  }

  private ensureSemanticClaimRow(plane: SemanticPlane): void {
    this.db
      .prepare("INSERT OR IGNORE INTO semantic_reconciliation_claims(workspace_id, plane) VALUES (?, ?)")
      .run(this.workspace.id, plane);
  }

  private semanticAttemptToken(state: SemanticStateRecord, retryGeneration = state.retryGeneration): string {
    return controlDigest({
      plane: state.plane,
      modelKey: state.modelKey,
      graphGeneration: state.graphGeneration,
      semanticRevision: state.semanticRevision,
      status: state.status,
      eligibleEntityCount: state.eligibleEntityCount,
      validEmbeddingCount: state.validEmbeddingCount,
      failureClass: state.failureClass,
      normalizedErrorCode: state.normalizedErrorCode,
      failureFingerprint: state.failureFingerprint,
      materialFingerprint: state.materialFingerprint,
      retryGeneration,
    });
  }

  private codeIndexAttemptToken(input: {
    modelKey: string;
    baseGraphGeneration: number;
    targetGraphGeneration: number;
    baseSemanticRevision: number;
    eligibleEntityCount: number;
    documentSetDigest: string;
    materialFingerprint: string;
  }): string {
    return controlDigest({
      operation: "code_index",
      plane: "code",
      modelKey: input.modelKey,
      baseGraphGeneration: input.baseGraphGeneration,
      targetGraphGeneration: input.targetGraphGeneration,
      baseSemanticRevision: input.baseSemanticRevision,
      eligibleEntityCount: input.eligibleEntityCount,
      documentSetDigest: input.documentSetDigest,
      materialFingerprint: input.materialFingerprint,
    });
  }

  private codeIndexDocumentSetDigest(graph: ExtractedGraph): string {
    const relativePathByFileId = new Map(graph.files.map((file) => [file.id, file.relativePath]));
    return semanticDocumentSetDigest(
      graph.nodes.map((node) =>
        buildCodeSemanticDocument(node, node.fileId ? (relativePathByFileId.get(node.fileId) ?? null) : null),
      ),
    );
  }

  private verifyCodeIndexClaim(
    claim: CodeIndexSemanticClaim,
    handle?: IndexRunHandle,
    graph?: ExtractedGraph,
    nowEpoch = this.databaseEpoch(),
  ): boolean {
    const workspace = this.getWorkspace();
    const state = this.getSemanticState("code");
    if (
      !state ||
      workspace.currentGeneration !== claim.baseGraphGeneration ||
      state.modelKey !== claim.modelKey ||
      state.graphGeneration !== claim.baseGraphGeneration ||
      state.semanticRevision !== claim.baseSemanticRevision ||
      (handle && claim.targetGraphGeneration !== handle.generation) ||
      (graph && (
        claim.eligibleEntityCount !== graph.nodes.length ||
        claim.documentSetDigest !== this.codeIndexDocumentSetDigest(graph)
      )) ||
      this.codeIndexAttemptToken(claim) !== claim.attemptToken
    ) {
      return false;
    }
    const row = this.db
      .prepare(
        `SELECT 1 FROM semantic_reconciliation_claims
         WHERE workspace_id = ? AND plane = 'code' AND active_attempt_token = ? AND owner_uuid = ?
           AND target_model_key = ? AND target_graph_generation = ? AND target_semantic_revision = ?
           AND lease_expiry_epoch > ?`,
      )
      .get(
        this.workspace.id,
        claim.attemptToken,
        claim.ownerUuid,
        claim.modelKey,
        claim.targetGraphGeneration,
        claim.baseSemanticRevision,
        nowEpoch,
      );
    return Boolean(row);
  }

  private completeCodeIndexClaim(
    claim: CodeIndexSemanticClaim,
    outcome: "succeeded" | "failed",
  ): boolean {
    const nowEpoch = this.databaseEpoch();
    const result = this.db
      .prepare(
        `UPDATE semantic_reconciliation_claims SET
           active_attempt_token = NULL, target_model_key = NULL, target_graph_generation = NULL,
           target_semantic_revision = NULL, owner_uuid = NULL, owner_pid = NULL, owner_hostname = NULL,
           heartbeat_epoch = NULL, lease_expiry_epoch = NULL,
           last_completed_attempt_token = ?, completed_outcome = ?, completed_epoch = ?
         WHERE workspace_id = ? AND plane = 'code' AND active_attempt_token = ? AND owner_uuid = ?`,
      )
      .run(
        claim.attemptToken,
        outcome,
        nowEpoch,
        this.workspace.id,
        claim.attemptToken,
        claim.ownerUuid,
      );
    return Number(result.changes) === 1;
  }

  /**
   * Re-check time-sensitive eligibility and vector validity inside the same
   * BEGIN IMMEDIATE transaction that will mint an attempt token. A changed
   * snapshot is persisted but deliberately not claimed until the caller has
   * rebuilt its detailed failure fingerprint from that new snapshot.
   */
  private refreshSemanticClaimCounts(plane: SemanticPlane, state: SemanticStateRecord): boolean {
    if (!state.modelKey) return false;
    const timestamp = this.databaseIso();
    const eligible = this.getEligibleSemanticEntityKeys(plane, timestamp);
    let valid = 0;
    for (const row of this.loadSemanticEmbeddings(plane, state.modelKey, timestamp)) {
      try {
        if (row.codec !== VECTOR_CODEC || eligible.get(row.entityId) !== row.sourceHash) continue;
        validateEncodedVector(row.vector, row.dimensions);
        valid += 1;
      } catch {
        // Invalid rows cannot contribute to an attempt-token count.
      }
    }
    if (eligible.size === state.eligibleEntityCount && valid === state.validEmbeddingCount) return false;
    this.supersedeSemanticClaim(plane);
    this.db
      .prepare(
        `UPDATE workspace_semantic_state SET status = ?, eligible_entity_count = ?,
           valid_embedding_count = ?, updated_at = ?
         WHERE workspace_id = ? AND plane = ? AND model_key = ?
           AND graph_generation IS ? AND semantic_revision = ?`,
      )
      .run(
        this.semanticStatusForFailure(state.failureClass, eligible.size, valid),
        eligible.size,
        valid,
        this.nowIso(),
        this.workspace.id,
        plane,
        state.modelKey,
        state.graphGeneration,
        state.semanticRevision,
      );
    return true;
  }

  private semanticStatusForFailure(
    failureClass: SemanticFailureClass | null,
    eligibleEntityCount: number,
    validEmbeddingCount: number,
  ): SemanticStateStatus {
    if (failureClass === "material_sticky" || failureClass === "scale_limit") return "unavailable";
    if (failureClass === "runtime_retryable") return validEmbeddingCount > 0 ? "partial" : "unavailable";
    return this.semanticStatusForCounts(eligibleEntityCount, validEmbeddingCount, false);
  }

  private safeDiagnostics(diagnostics: readonly SemanticFailureDiagnostic[]): string {
    return JSON.stringify(
      diagnostics.map((diagnostic) => ({
        failureClass: diagnostic.failureClass,
        code: diagnostic.code,
        detailCode: diagnostic.detailCode,
      })),
    );
  }

  private applySemanticCommitDiagnostics(
    plane: SemanticPlane,
    commit: SemanticPlaneCommit,
    eligibleEntityCount: number,
    validEmbeddingCount: number,
  ): void {
    if (!commit.failure) {
      if (eligibleEntityCount === validEmbeddingCount) {
        this.db
          .prepare(
            `UPDATE workspace_semantic_state SET failure_class = NULL, normalized_error_code = NULL,
               failure_fingerprint = NULL, diagnostics_json = '[]', retry_count = 0, next_retry_epoch = NULL
             WHERE workspace_id = ? AND plane = ?`,
          )
          .run(this.workspace.id, plane);
      }
      return;
    }
    const state = this.getSemanticState(plane);
    if (!state) return;
    const retryCount = commit.failure.failureClass === "runtime_retryable" ? state.retryCount + 1 : 0;
    const delays = [30, 120, 600] as const;
    const nextRetryEpoch = commit.failure.failureClass === "runtime_retryable"
      ? this.databaseEpoch() + delays[Math.min(retryCount - 1, delays.length - 1)]!
      : null;
    this.db
      .prepare(
        `UPDATE workspace_semantic_state SET status = ?, last_error = ?, failure_class = ?,
           normalized_error_code = ?, failure_fingerprint = ?, material_fingerprint = ?,
           diagnostics_json = ?, retry_count = ?, next_retry_epoch = ?
         WHERE workspace_id = ? AND plane = ?`,
      )
      .run(
        this.semanticStatusForFailure(commit.failure.failureClass, eligibleEntityCount, validEmbeddingCount),
        commit.failure.safeSummary,
        commit.failure.failureClass,
        commit.failure.code,
        semanticFailureFingerprint(commit.failure),
        commit.failure.materialFingerprint ?? state.materialFingerprint,
        this.safeDiagnostics(commit.diagnostics ?? [commit.failure]),
        retryCount,
        nextRetryEpoch,
        this.workspace.id,
        plane,
      );
  }

  private verifySemanticClaim(claim: SemanticReconciliationClaim, nowEpoch = this.databaseEpoch()): boolean {
    const state = this.getSemanticState(claim.plane);
    if (
      !state ||
      state.modelKey !== claim.modelKey ||
      state.graphGeneration !== claim.graphGeneration ||
      state.semanticRevision !== claim.semanticRevision ||
      this.semanticAttemptToken(state) !== claim.attemptToken
    ) {
      return false;
    }
    const row = this.db
      .prepare(
        `SELECT 1 FROM semantic_reconciliation_claims
         WHERE workspace_id = ? AND plane = ? AND active_attempt_token = ? AND owner_uuid = ?
           AND target_model_key = ?
           AND target_graph_generation IS ? AND target_semantic_revision = ?
           AND lease_expiry_epoch > ?`,
      )
      .get(
        this.workspace.id,
        claim.plane,
        claim.attemptToken,
        claim.ownerUuid,
        claim.modelKey,
        claim.graphGeneration,
        claim.semanticRevision,
        nowEpoch,
      );
    return Boolean(row);
  }

  private completeSemanticClaim(
    claim: SemanticReconciliationClaim,
    outcome: "succeeded" | "failed",
    stateMayHaveAdvanced = false,
  ): boolean {
    const nowEpoch = this.databaseEpoch();
    if (!stateMayHaveAdvanced && !this.verifySemanticClaim(claim, nowEpoch)) return false;
    if (stateMayHaveAdvanced) {
      const active = this.db
        .prepare(
          `SELECT 1 FROM semantic_reconciliation_claims
           WHERE workspace_id = ? AND plane = ? AND active_attempt_token = ? AND owner_uuid = ?
             AND lease_expiry_epoch > ?`,
        )
        .get(this.workspace.id, claim.plane, claim.attemptToken, claim.ownerUuid, nowEpoch);
      if (!active) return false;
    }
    const state = this.getSemanticState(claim.plane);
    const completedToken = state ? this.semanticAttemptToken(state) : claim.attemptToken;
    const result = this.db
      .prepare(
        `UPDATE semantic_reconciliation_claims SET
           active_attempt_token = NULL, target_model_key = NULL, target_graph_generation = NULL,
           target_semantic_revision = NULL, owner_uuid = NULL, owner_pid = NULL, owner_hostname = NULL,
           heartbeat_epoch = NULL, lease_expiry_epoch = NULL,
           last_completed_attempt_token = ?, completed_outcome = ?, completed_epoch = ?
         WHERE workspace_id = ? AND plane = ? AND active_attempt_token = ? AND owner_uuid = ?`,
      )
      .run(
        completedToken,
        outcome,
        nowEpoch,
        this.workspace.id,
        claim.plane,
        claim.attemptToken,
        claim.ownerUuid,
      );
    return Number(result.changes) === 1;
  }

  private supersedeSemanticClaim(plane: SemanticPlane, preservedAttemptToken?: string): void {
    this.ensureSemanticClaimRow(plane);
    const nowEpoch = this.databaseEpoch();
    this.db
      .prepare(
        `UPDATE semantic_reconciliation_claims SET
           last_completed_attempt_token = active_attempt_token, completed_outcome = 'superseded',
           completed_epoch = ?, active_attempt_token = NULL, target_model_key = NULL,
           target_graph_generation = NULL, target_semantic_revision = NULL, owner_uuid = NULL,
           owner_pid = NULL, owner_hostname = NULL, heartbeat_epoch = NULL, lease_expiry_epoch = NULL,
           supersede_count = supersede_count + 1
         WHERE workspace_id = ? AND plane = ? AND active_attempt_token IS NOT NULL
           AND (? IS NULL OR active_attempt_token <> ?)`,
      )
      .run(nowEpoch, this.workspace.id, plane, preservedAttemptToken ?? null, preservedAttemptToken ?? null);
  }

  private semanticWorkspaceKey(): bigint {
    const digest = Buffer.from(sha256(this.workspace.id), "hex");
    return digest.readBigUInt64BE(0) & 0x7fff_ffff_ffff_ffffn;
  }

  private semanticEntityKey(plane: SemanticPlane, entityId: string): Uint8Array {
    if (plane === "code") {
      if (!/^[0-9a-f]{64}$/.test(entityId)) {
        throw new ContextMeshError("INTERNAL_ERROR", `Invalid code semantic entity ID: ${entityId}`);
      }
      return Buffer.from(entityId, "hex");
    }
    const key = Buffer.from(entityId, "utf8");
    if (key.length === 0) throw new ContextMeshError("INTERNAL_ERROR", "Memory semantic entity ID is empty");
    return key;
  }

  private semanticEntityId(plane: SemanticPlane, entityKey: SQLOutputValue | undefined): string {
    if (!(entityKey instanceof Uint8Array)) {
      throw new ContextMeshError("INTERNAL_ERROR", "Semantic entity key is not a BLOB");
    }
    return plane === "code" ? Buffer.from(entityKey).toString("hex") : Buffer.from(entityKey).toString("utf8");
  }

  private semanticEntityMapKey(plane: SemanticPlane, entityId: string): string {
    return Buffer.from(this.semanticEntityKey(plane, entityId)).toString("hex");
  }

  private semanticEmbeddingIds(plane: SemanticPlane, modelKey: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT embedding.embedding_id, embedding.entity_key
         FROM semantic_embeddings embedding
         JOIN semantic_models model ON model.model_id = embedding.model_id
         WHERE embedding.workspace_key = ? AND embedding.plane = ? AND model.model_key = ?
         ORDER BY embedding.embedding_id`,
      )
      .all(this.semanticWorkspaceKey(), plane, modelKey);
    return new Map(
      rows.map((row) => [Buffer.from(row.entity_key as Uint8Array).toString("hex"), numberValue(row.embedding_id)]),
    );
  }

  private writeSemanticEntry(
    plane: SemanticPlane,
    generation: number | null,
    commit: SemanticPlaneCommit,
    entry: SemanticCommitEntry,
    existingEmbeddingId: number | undefined,
  ): void {
    if (entry.vector) {
      if (commit.codec !== VECTOR_CODEC) {
        throw new ContextMeshError("INTERNAL_ERROR", `Unsupported semantic vector codec: ${commit.codec}`);
      }
      try {
        validateEncodedVector(entry.vector, commit.dimensions);
      } catch (error) {
        throw new ContextMeshError(
          "INTERNAL_ERROR",
          `Invalid semantic vector for ${entry.entityId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const statement = existingEmbeddingId === undefined
        ? this.db.prepare(
            `INSERT INTO semantic_embeddings(
               workspace_key, plane, entity_key, source_hash, model_id, generation, vector
             ) VALUES (?, ?, ?, ?, (SELECT model_id FROM semantic_models WHERE model_key = ?), ?, ?)`,
          )
        : this.db.prepare(
            `UPDATE semantic_embeddings SET source_hash = ?, generation = ?, vector = ?
             WHERE embedding_id = ? AND workspace_key = ? AND plane = ? AND entity_key = ?
               AND model_id = (SELECT model_id FROM semantic_models WHERE model_key = ?)`,
          );
      const written = existingEmbeddingId === undefined
        ? statement.run(
            this.semanticWorkspaceKey(),
            plane,
            this.semanticEntityKey(plane, entry.entityId),
            Buffer.from(entry.sourceHash, "hex"),
            commit.modelKey,
            generation,
            entry.vector,
          )
        : statement.run(
            Buffer.from(entry.sourceHash, "hex"),
            generation,
            entry.vector,
            existingEmbeddingId,
            this.semanticWorkspaceKey(),
            plane,
            this.semanticEntityKey(plane, entry.entityId),
            commit.modelKey,
          );
      if (Number(written.changes) !== 1) {
        throw new ContextMeshError("INTERNAL_ERROR", `Semantic embedding write conflict for ${entry.entityId}`);
      }
      return;
    }
    if (entry.reuse && existingEmbeddingId !== undefined) {
      const reused = this.db
        .prepare(
          `UPDATE semantic_embeddings
           SET generation = ?
           WHERE embedding_id = ? AND workspace_key = ? AND plane = ? AND entity_key = ?
             AND model_id = (SELECT model_id FROM semantic_models WHERE model_key = ?)
             AND source_hash = ? AND length(vector) = ?`,
        )
        .run(
          generation,
          existingEmbeddingId,
          this.semanticWorkspaceKey(),
          plane,
          this.semanticEntityKey(plane, entry.entityId),
          commit.modelKey,
          Buffer.from(entry.sourceHash, "hex"),
          commit.dimensions * Float32Array.BYTES_PER_ELEMENT,
        );
      if (Number(reused.changes) > 0) return;
    }
    if (existingEmbeddingId !== undefined) {
      this.db
        .prepare("DELETE FROM semantic_embeddings WHERE embedding_id = ? AND workspace_key = ?")
        .run(existingEmbeddingId, this.semanticWorkspaceKey());
    }
  }

  private applyCodeSemanticCommit(generation: number, commit: SemanticPlaneCommit, timestamp: string): void {
    const existingIds = this.semanticEmbeddingIds("code", commit.modelKey);
    for (const entry of commit.entries) {
      this.writeSemanticEntry(
        "code",
        generation,
        commit,
        entry,
        existingIds.get(this.semanticEntityMapKey("code", entry.entityId)),
      );
    }
    this.db
      .prepare(
        `DELETE FROM semantic_embeddings
         WHERE workspace_key = ? AND plane = 'code'
           AND model_id = (SELECT model_id FROM semantic_models WHERE model_key = ?)
           AND (generation <> ? OR NOT EXISTS (
             SELECT 1 FROM code_nodes node
             WHERE node.workspace_id = ? AND node.id = lower(hex(semantic_embeddings.entity_key))
               AND node.semantic_source_hash = lower(hex(semantic_embeddings.source_hash))
               AND node.generation = ?
           ))`,
      )
      .run(this.semanticWorkspaceKey(), commit.modelKey, generation, this.workspace.id, generation);
    const counts = this.db
      .prepare(
        `SELECT
           (SELECT count(*) FROM code_nodes
           WHERE workspace_id = ? AND generation = ? AND semantic_source_hash IS NOT NULL) AS eligible,
           (SELECT count(*) FROM semantic_embeddings embedding
            JOIN semantic_models model ON model.model_id = embedding.model_id
            JOIN code_nodes node ON node.workspace_id = ? AND node.id = lower(hex(embedding.entity_key))
              AND node.semantic_source_hash = lower(hex(embedding.source_hash))
              AND node.generation = embedding.generation
            WHERE embedding.workspace_key = ? AND embedding.plane = 'code'
              AND model.model_key = ? AND embedding.generation = ?
              AND length(embedding.vector) = ?) AS valid`,
      )
      .get(
        this.workspace.id,
        generation,
        this.workspace.id,
        this.semanticWorkspaceKey(),
        commit.modelKey,
        generation,
        commit.dimensions * Float32Array.BYTES_PER_ELEMENT,
      );
    const eligible = numberValue(counts?.eligible);
    const valid = numberValue(counts?.valid);
    const status = this.semanticStatusForCounts(eligible, valid, commit.unavailable ?? false);
    this.db
      .prepare(
        `INSERT INTO workspace_semantic_state(
           workspace_id, plane, model_key, graph_generation, semantic_revision, status,
           eligible_entity_count, valid_embedding_count, last_error, updated_at
         ) VALUES (?, 'code', ?, ?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, plane) DO UPDATE SET
           model_key = excluded.model_key,
           graph_generation = excluded.graph_generation,
           semantic_revision = workspace_semantic_state.semantic_revision + 1,
           status = excluded.status,
           eligible_entity_count = excluded.eligible_entity_count,
           valid_embedding_count = excluded.valid_embedding_count,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`,
      )
      .run(
        this.workspace.id,
        commit.modelKey,
        generation,
        status,
        eligible,
        valid,
        commit.lastError ?? null,
        timestamp,
      );
    this.applySemanticCommitDiagnostics("code", commit, eligible, valid);
  }

  commitGraph(
    handle: IndexRunHandle,
    graph: ExtractedGraph,
    stats: IndexCommitStats,
    indexConfigHash: string,
    adapterState: AdapterStateMap,
    semantic?: SemanticPlaneCommit,
    semanticClaim?: CodeIndexSemanticClaim,
    semanticGraph?: ExtractedGraph,
  ): void {
    const timestamp = this.nowIso();
    const startedAt = performance.now();
    this.transaction(() => {
      this.assertIndexWriterLease(handle);
      this.db.exec("PRAGMA defer_foreign_keys = ON");
      const claimValid = semanticClaim
        ? this.verifyCodeIndexClaim(semanticClaim, handle, semanticGraph ?? graph)
        : false;
      const acceptedSemantic = claimValid ? semantic : undefined;
      this.supersedeSemanticClaim("code", claimValid ? semanticClaim?.attemptToken : undefined);
      this.db.prepare("DELETE FROM code_nodes_fts").run();
      this.db.prepare(
        `UPDATE precision_provider_state SET
           status=CASE WHEN status='not_configured' THEN status ELSE 'stale' END,
           lease_owner=NULL,lease_token=NULL,lease_expires_epoch=NULL,updated_at=?
         WHERE workspace_id=?`,
      ).run(timestamp, this.workspace.id);
      this.db.prepare("DELETE FROM unresolved_refs WHERE workspace_id = ?").run(this.workspace.id);
      this.db.prepare("DELETE FROM code_edges WHERE workspace_id = ?").run(this.workspace.id);
      this.db.prepare("DELETE FROM code_nodes WHERE workspace_id = ?").run(this.workspace.id);
      this.db.prepare("DELETE FROM source_files WHERE workspace_id = ?").run(this.workspace.id);

      const insertFile = this.db.prepare(
        `INSERT INTO source_files(
          id, workspace_id, relative_path, path_key, language, ecosystem, source_root, adapter_config_hash, content_hash,
          size_bytes, mtime_ms, parse_status, diagnostic_count, last_generation, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const file of graph.files) {
        insertFile.run(
          file.id,
          file.workspaceId,
          file.relativePath,
          file.pathKey,
          file.language,
          file.ecosystem ?? "npm",
          file.sourceRoot ?? "",
          file.adapterConfigHash ?? indexConfigHash,
          file.contentHash,
          file.sizeBytes,
          file.mtimeMs,
          file.parseStatus,
          file.diagnosticCount,
          handle.generation,
          timestamp,
        );
      }

      const relativePathByFileId = new Map(graph.files.map((file) => [file.id, file.relativePath]));
      const semanticSourceHashByNodeId = acceptedSemantic
        ? new Map(acceptedSemantic.entries.map((entry) => [entry.entityId, entry.sourceHash]))
        : null;
      const insertNode = this.db.prepare(
        `INSERT INTO code_nodes(
          id, workspace_id, file_id, kind, name, qualified_name, local_key, signature, doc,
          is_exported, start_byte, end_byte, start_line, start_column, end_line, end_column,
          content_hash, generation, metadata_json, semantic_source_hash,
          language, ecosystem, native_kind, analysis_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertNodeFts = this.db.prepare(
        `INSERT INTO code_nodes_fts(node_id, name, qualified_name, signature, doc, search_tokens)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const node of graph.nodes) {
        const semanticDocument = buildCodeSemanticDocument(
          node,
          node.fileId ? (relativePathByFileId.get(node.fileId) ?? null) : null,
        );
        insertNode.run(
          node.id,
          node.workspaceId,
          node.fileId,
          node.kind,
          node.name,
          node.qualifiedName,
          node.localKey,
          node.signature,
          node.doc,
          node.isExported ? 1 : 0,
          node.startByte,
          node.endByte,
          node.startLine,
          node.startColumn,
          node.endLine,
          node.endColumn,
          node.contentHash,
          handle.generation,
          JSON.stringify(node.metadata),
          semanticSourceHashByNodeId?.get(node.id) ?? semanticDocument.sourceHash,
          node.language ?? (node.metadata.language as string | undefined) ?? "typescript",
          node.ecosystem ?? "npm",
          node.nativeKind ?? (node.metadata.syntaxKind as string | undefined) ?? node.kind,
          node.analysisLevel ?? "typed",
        );
        insertNodeFts.run(
          node.id,
          node.name,
          node.qualifiedName,
          node.signature,
          node.doc,
          tokenizeIdentifier(`${node.name} ${node.qualifiedName}`),
        );
      }

      const insertEdge = this.db.prepare(
        `INSERT OR IGNORE INTO code_edges(
          workspace_id, source_id, target_id, kind, confidence, resolution_kind, generation, metadata_json,
          status, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const edge of graph.edges) {
        insertEdge.run(
          edge.workspaceId,
          edge.sourceId,
          edge.targetId,
          edge.kind,
          edge.confidence,
          edge.resolutionKind,
          handle.generation,
          JSON.stringify(edge.metadata),
          edge.status ?? "resolved",
          JSON.stringify(edge.evidence ?? []),
        );
      }

      const insertUnresolved = this.db.prepare(
        `INSERT INTO unresolved_refs(
          workspace_id, file_id, source_node_id, kind, raw_name, qualifier,
          line, column, candidates_json, generation, confidence, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const reference of graph.unresolvedReferences) {
        insertUnresolved.run(
          reference.workspaceId,
          reference.fileId,
          reference.sourceNodeId,
          reference.kind,
          reference.rawName,
          reference.qualifier,
          reference.line,
          reference.column,
          JSON.stringify(reference.candidates),
          handle.generation,
          reference.confidence ?? 0.5,
          JSON.stringify(reference.evidence ?? []),
        );
      }

      this.db
        .prepare(
          `UPDATE memory_code_links
           SET code_node_id = (
             SELECT id FROM code_nodes
             WHERE code_nodes.workspace_id = memory_code_links.workspace_id
               AND code_nodes.local_key = memory_code_links.node_local_key
               AND (memory_code_links.language IS NULL OR code_nodes.language = memory_code_links.language)
             LIMIT 1
           ), language = coalesce(language, (SELECT language FROM code_nodes
              WHERE code_nodes.workspace_id = memory_code_links.workspace_id
                AND code_nodes.local_key = memory_code_links.node_local_key LIMIT 1))
           WHERE workspace_id = ?`,
        )
        .run(this.workspace.id);
      this.relinkStaleMemoryCodeLinks(timestamp);

      this.db
        .prepare(
          `UPDATE workspaces SET current_generation = ?, index_config_hash = ?, adapter_state_json = ?, freshness_stale = 0,
           freshness_stale_at = NULL, freshness_reasons_json = '[]', updated_at = ? WHERE id = ?`,
        )
        .run(handle.generation, indexConfigHash, JSON.stringify(adapterState), timestamp, this.workspace.id);
      if (acceptedSemantic) {
        this.applyCodeSemanticCommit(handle.generation, acceptedSemantic, timestamp);
      } else {
        const semanticState = this.getSemanticState("code");
        if (semanticState?.modelKey) {
          this.db
            .prepare(
              `DELETE FROM semantic_embeddings
               WHERE workspace_key = ? AND plane = 'code' AND generation <> ?`,
            )
            .run(this.semanticWorkspaceKey(), handle.generation);
          const eligible = numberValue(
            this.db
              .prepare(
                `SELECT count(*) AS count FROM code_nodes
                 WHERE workspace_id = ? AND generation = ? AND semantic_source_hash IS NOT NULL`,
              )
              .get(this.workspace.id, handle.generation)?.count,
          );
          this.db
            .prepare(
              `UPDATE workspace_semantic_state SET graph_generation = ?,
                 semantic_revision = semantic_revision + 1,
                 status = CASE
                   WHEN failure_class IN ('material_sticky', 'scale_limit') THEN 'unavailable'
                   WHEN failure_class = 'runtime_retryable' THEN 'unavailable'
                   ELSE 'needs_backfill'
                 END,
                 eligible_entity_count = ?, valid_embedding_count = 0, updated_at = ?
               WHERE workspace_id = ? AND plane = 'code' AND model_key IS NOT NULL`,
            )
            .run(handle.generation, eligible, timestamp, this.workspace.id);
        }
      }
      if (
        claimValid &&
        semanticClaim &&
        !this.completeCodeIndexClaim(
          semanticClaim,
          acceptedSemantic?.failure || !acceptedSemantic ? "failed" : "succeeded",
        )
      ) {
        throw new ContextMeshError("INTERNAL_ERROR", "Code index semantic claim could not be completed");
      }
      this.db
        .prepare(
          `UPDATE index_runs SET status = ?, scanned_files = ?, changed_files = ?, deleted_files = ?,
           failed_files = ?, diagnostics_json = ?, adapter_stats_json = ?, completed_at = ? WHERE id = ?`,
        )
        .run(
          stats.failedFiles > 0 ? "partial" : "succeeded",
          stats.scannedFiles,
          stats.changedFiles,
          stats.deletedFiles,
          stats.failedFiles,
          JSON.stringify(graph.diagnostics),
          JSON.stringify(graph.adapterStats ?? []),
          timestamp,
          handle.id,
      );
      this.releaseIndexWriterLease(handle);
    });
    this.lastBulkCommitMs = performance.now() - startedAt;
  }

  bulkCommitMetrics(): { lastCommitMs: number; mode: "prepared-bulk-deferred-fk-transaction" } {
    return { lastCommitMs: this.lastBulkCommitMs, mode: "prepared-bulk-deferred-fk-transaction" };
  }

  configureSemanticModel(model: SemanticModelRegistration): void {
    const timestamp = this.nowIso();
    this.transaction(() => {
      const workspaceKey = this.semanticWorkspaceKey();
      this.db
        .prepare("INSERT OR IGNORE INTO semantic_workspaces(workspace_key, workspace_id) VALUES (?, ?)")
        .run(workspaceKey, this.workspace.id);
      const semanticWorkspace = this.db
        .prepare("SELECT workspace_id FROM semantic_workspaces WHERE workspace_key = ?")
        .get(workspaceKey);
      if (stringValue(semanticWorkspace?.workspace_id) !== this.workspace.id) {
        throw new ContextMeshError("INTERNAL_ERROR", "Semantic workspace key collision");
      }
      this.db
        .prepare(
          `INSERT INTO semantic_models(
             model_key, manifest_digest, manifest_json, dimensions, vector_codec, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(model_key) DO UPDATE SET
             manifest_digest = excluded.manifest_digest,
             manifest_json = excluded.manifest_json,
             dimensions = excluded.dimensions,
             vector_codec = excluded.vector_codec`,
        )
        .run(
          model.modelKey,
          model.manifestDigest,
          model.manifestJson,
          model.dimensions,
          model.vectorCodec,
          timestamp,
        );
      const generation = this.getWorkspace().currentGeneration;
      for (const plane of ["code", "memory"] as const) {
        this.ensureSemanticClaimRow(plane);
        const existing = this.getSemanticState(plane);
        if (!existing) {
          this.db
            .prepare(
              `INSERT INTO workspace_semantic_state(
                 workspace_id, plane, model_key, graph_generation, semantic_revision, status,
                 eligible_entity_count, valid_embedding_count, updated_at
               ) VALUES (?, ?, ?, ?, 0, 'needs_backfill', 0, 0, ?)`,
            )
            .run(this.workspace.id, plane, model.modelKey, plane === "code" ? generation : null, timestamp);
          continue;
        }
        if (existing.modelKey === model.modelKey) continue;
        this.supersedeSemanticClaim(plane);
        this.db
          .prepare(
            `UPDATE workspace_semantic_state SET
               model_key = ?, graph_generation = ?, semantic_revision = semantic_revision + 1,
               status = 'needs_backfill', eligible_entity_count = 0, valid_embedding_count = 0,
               last_error = NULL, updated_at = ?
             WHERE workspace_id = ? AND plane = ?`,
          )
          .run(model.modelKey, plane === "code" ? generation : null, timestamp, this.workspace.id, plane);
      }
      this.db
        .prepare(
          `DELETE FROM semantic_embeddings
           WHERE workspace_key = ?
             AND model_id <> (SELECT model_id FROM semantic_models WHERE model_key = ?)`,
        )
        .run(workspaceKey, model.modelKey);
    });
  }

  backfillSemanticSourceHashes(repairMismatches = false): void {
    const timestamp = this.nowIso();
    this.transaction(() => {
      let codeChanges = 0;
      const codeRows = this.db
        .prepare(
          `SELECT node.*, file.relative_path, file.content_hash AS file_content_hash, 0.0 AS score
           FROM code_nodes node LEFT JOIN source_files file ON file.id = node.file_id
           WHERE node.workspace_id = ?${repairMismatches ? "" : " AND node.semantic_source_hash IS NULL"}
           ORDER BY node.id`,
        )
        .all(this.workspace.id);
      const updateCode = this.db.prepare(
        "UPDATE code_nodes SET semantic_source_hash = ? WHERE workspace_id = ? AND id = ? AND semantic_source_hash IS NOT ?",
      );
      for (const node of this.applyPrecisionNodeOverlays(codeRows.map(mapCodeNode))) {
        const semantic = buildCodeSemanticDocument(node, node.relativePath);
        codeChanges += Number(updateCode.run(semantic.sourceHash, this.workspace.id, node.id, semantic.sourceHash).changes);
      }

      let memoryChanges = 0;
      const memoryRows = this.db
        .prepare(
          `SELECT * FROM memory_fragments WHERE workspace_id = ?${repairMismatches ? "" : " AND semantic_source_hash IS NULL"}
           ORDER BY id`,
        )
        .all(this.workspace.id);
      const updateMemory = this.db.prepare(
        "UPDATE memory_fragments SET semantic_source_hash = ? WHERE workspace_id = ? AND id = ? AND semantic_source_hash IS NOT ?",
      );
      for (const row of memoryRows) {
        const memory = mapMemory(row);
        const semantic = buildMemorySemanticDocument(memory);
        memoryChanges += Number(
          updateMemory.run(semantic.sourceHash, this.workspace.id, memory.id, semantic.sourceHash).changes,
        );
      }
      for (const [plane, changes] of [
        ["code", codeChanges],
        ["memory", memoryChanges],
      ] as const) {
        if (changes === 0) continue;
        this.supersedeSemanticClaim(plane);
        this.db
          .prepare(
            `UPDATE workspace_semantic_state SET
               semantic_revision = semantic_revision + 1, status = 'needs_backfill',
               valid_embedding_count = 0, last_error = NULL, updated_at = ?
             WHERE workspace_id = ? AND plane = ?`,
          )
          .run(timestamp, this.workspace.id, plane);
      }
    });
  }

  getSemanticState(plane: SemanticPlane): SemanticStateRecord | null {
    const row = this.db
      .prepare("SELECT * FROM workspace_semantic_state WHERE workspace_id = ? AND plane = ?")
      .get(this.workspace.id, plane);
    return row ? mapSemanticState(row) : null;
  }

  getCurrentCodeSemanticDocuments(): SemanticDocument[] {
    const rows = this.db
      .prepare(
        `SELECT node.*, file.relative_path, file.content_hash AS file_content_hash, 0.0 AS score
         FROM code_nodes node LEFT JOIN source_files file ON file.id = node.file_id
         WHERE node.workspace_id = ? AND node.generation = ? ORDER BY node.id`,
      )
      .all(this.workspace.id, this.getWorkspace().currentGeneration);
    return this.applyPrecisionNodeOverlays(rows.map(mapCodeNode))
      .map((node) => buildCodeSemanticDocument(node, node.relativePath));
  }

  getCurrentMemorySemanticDocuments(timestamp = this.nowIso()): SemanticDocument[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_fragments
         WHERE workspace_id = ? AND state = 'active'
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY id`,
      )
      .all(this.workspace.id, timestamp)
      .map((row) => buildMemorySemanticDocument(mapMemory(row)));
  }

  *iterateSemanticEmbeddings(
    plane: SemanticPlane,
    modelKey: string,
    timestamp = this.nowIso(),
  ): IterableIterator<StoredSemanticEmbedding> {
    const rows =
      plane === "code"
        ? this.db
            .prepare(
              `SELECT embedding.entity_key, embedding.source_hash, model.model_key,
                      embedding.generation, embedding.vector,
                      model.dimensions, model.vector_codec AS codec
               FROM semantic_embeddings embedding
               JOIN semantic_models model ON model.model_id = embedding.model_id
               JOIN code_nodes node ON node.workspace_id = ? AND node.id = lower(hex(embedding.entity_key))
                 AND node.semantic_source_hash = lower(hex(embedding.source_hash))
                 AND node.generation = embedding.generation
               JOIN workspaces workspace ON workspace.id = node.workspace_id
                 AND workspace.current_generation = node.generation
               WHERE embedding.workspace_key = ? AND embedding.plane = 'code'
                 AND model.model_key = ?
               ORDER BY embedding.entity_key`,
            )
            .iterate(this.workspace.id, this.semanticWorkspaceKey(), modelKey)
        : this.db
            .prepare(
              `SELECT embedding.entity_key, embedding.source_hash, model.model_key,
                      embedding.generation, embedding.vector,
                      model.dimensions, model.vector_codec AS codec
               FROM semantic_embeddings embedding
               JOIN semantic_models model ON model.model_id = embedding.model_id
               JOIN memory_fragments memory ON memory.workspace_id = ?
                 AND memory.id = CAST(embedding.entity_key AS TEXT)
                 AND memory.semantic_source_hash = lower(hex(embedding.source_hash))
               WHERE embedding.workspace_key = ? AND embedding.plane = 'memory'
                 AND model.model_key = ? AND memory.state = 'active'
                 AND (memory.expires_at IS NULL OR memory.expires_at > ?)
               ORDER BY embedding.entity_key`,
            )
            .iterate(this.workspace.id, this.semanticWorkspaceKey(), modelKey, timestamp);
    for (const row of rows) {
      yield {
        entityId: this.semanticEntityId(plane, row.entity_key),
        sourceHash: hexValue(row.source_hash),
        modelKey: stringValue(row.model_key),
        generation: row.generation === null ? null : numberValue(row.generation),
        vector: row.vector instanceof Uint8Array ? row.vector : new Uint8Array(),
        dimensions: numberValue(row.dimensions),
        codec: stringValue(row.codec),
      };
    }
  }

  getSemanticHydrationModel(modelKey: string): SemanticHydrationModel | null {
    const row = this.db
      .prepare("SELECT model_id, dimensions, vector_codec FROM semantic_models WHERE model_key = ?")
      .get(modelKey);
    if (!row) return null;
    return {
      modelId: numberValue(row.model_id),
      dimensions: numberValue(row.dimensions),
      codec: stringValue(row.vector_codec),
    };
  }

  *iterateSemanticHydrationRows(
    plane: SemanticPlane,
    modelId: number,
    timestamp = this.nowIso(),
  ): IterableIterator<RawSemanticHydrationRow> {
    const workspaceKey = this.semanticWorkspaceKey();
    const rows =
      plane === "code"
        ? this.db
            .prepare(
              `SELECT embedding.entity_key, embedding.source_hash, embedding.vector
               FROM semantic_embeddings embedding
               JOIN code_nodes node ON node.workspace_id = ? AND node.id = lower(hex(embedding.entity_key))
                 AND node.semantic_source_hash = lower(hex(embedding.source_hash))
                 AND node.generation = embedding.generation
               WHERE embedding.workspace_key = ? AND embedding.plane = 'code'
                 AND embedding.model_id = ? AND embedding.generation = ?
               ORDER BY embedding.entity_key`,
            )
            .iterate(this.workspace.id, workspaceKey, modelId, this.getWorkspace().currentGeneration)
        : this.db
            .prepare(
              `SELECT embedding.entity_key, embedding.source_hash, embedding.vector
               FROM semantic_embeddings embedding
               JOIN memory_fragments memory ON memory.workspace_id = ?
                 AND memory.id = CAST(embedding.entity_key AS TEXT)
                 AND memory.semantic_source_hash = lower(hex(embedding.source_hash))
               WHERE embedding.workspace_key = ? AND embedding.plane = 'memory'
                 AND embedding.model_id = ? AND memory.state = 'active'
                 AND (memory.expires_at IS NULL OR memory.expires_at > ?)
               ORDER BY embedding.entity_key`,
            )
            .iterate(this.workspace.id, workspaceKey, modelId, timestamp);
    for (const row of rows) {
      yield {
        entityKey: row.entity_key instanceof Uint8Array ? row.entity_key : new Uint8Array(),
        sourceHash: row.source_hash instanceof Uint8Array ? row.source_hash : new Uint8Array(),
        vector: row.vector instanceof Uint8Array ? row.vector : new Uint8Array(),
      };
    }
  }

  loadSemanticEmbeddings(
    plane: SemanticPlane,
    modelKey: string,
    timestamp = this.nowIso(),
  ): StoredSemanticEmbedding[] {
    return [...this.iterateSemanticEmbeddings(plane, modelKey, timestamp)];
  }

  releaseTransientSemanticReadMemory(): void {
    // Hydration reads large BLOBs exactly once. Ask SQLite to return transient
    // page/lookaside allocations after they have been copied into the warm matrix.
    this.db.exec("PRAGMA shrink_memory");
  }

  getEligibleSemanticEntityKeys(
    plane: SemanticPlane,
    timestamp = this.nowIso(),
    filters: { kinds?: CodeNodeKind[]; types?: MemoryType[]; topic?: string } = {},
  ): Map<string, string> {
    if (plane === "code") {
      const kindClause = filters.kinds?.length ? ` AND kind IN (${placeholders(filters.kinds.length)})` : "";
      const rows = this.db
        .prepare(
          `SELECT id, semantic_source_hash FROM code_nodes
           WHERE workspace_id = ? AND generation = ? AND semantic_source_hash IS NOT NULL${kindClause}
           ORDER BY id`,
        )
        .all(this.workspace.id, this.getWorkspace().currentGeneration, ...(filters.kinds ?? []));
      return new Map(rows.map((row) => [stringValue(row.id), stringValue(row.semantic_source_hash)]));
    }
    const typeClause = filters.types?.length ? ` AND type IN (${placeholders(filters.types.length)})` : "";
    const topicClause = filters.topic ? " AND lower(topic) = lower(?)" : "";
    const rows = this.db
      .prepare(
        `SELECT id, semantic_source_hash FROM memory_fragments
         WHERE workspace_id = ? AND state = 'active' AND semantic_source_hash IS NOT NULL
           AND (expires_at IS NULL OR expires_at > ?)${typeClause}${topicClause}
         ORDER BY id`,
      )
      .all(
        this.workspace.id,
        timestamp,
        ...(filters.types ?? []),
        ...(filters.topic ? [filters.topic] : []),
      );
    return new Map(rows.map((row) => [stringValue(row.id), stringValue(row.semantic_source_hash)]));
  }

  updateSemanticFailure(
    plane: SemanticPlane,
    primary: SemanticFailureDiagnostic | null,
    diagnostics: readonly SemanticFailureDiagnostic[],
    eligibleEntityCount: number,
    validEmbeddingCount: number,
    materialFingerprint: string | null = primary?.materialFingerprint ?? null,
  ): void {
    const failureClass = primary?.failureClass ?? null;
    const status = this.semanticStatusForFailure(failureClass, eligibleEntityCount, validEmbeddingCount);
    const fingerprint = primary ? semanticFailureFingerprint(primary) : null;
    this.db
      .prepare(
        `UPDATE workspace_semantic_state SET
           status = ?, eligible_entity_count = ?, valid_embedding_count = ?,
           last_error = ?, failure_class = ?, normalized_error_code = ?, failure_fingerprint = ?,
           material_fingerprint = ?, diagnostics_json = ?,
           retry_count = CASE WHEN ? = 'runtime_retryable' THEN retry_count ELSE 0 END,
           next_retry_epoch = CASE WHEN ? = 'runtime_retryable' THEN next_retry_epoch ELSE NULL END,
           updated_at = ?
         WHERE workspace_id = ? AND plane = ?`,
      )
      .run(
        status,
        eligibleEntityCount,
        validEmbeddingCount,
        primary?.safeSummary ?? null,
        failureClass,
        primary?.code ?? null,
        fingerprint,
        materialFingerprint,
        this.safeDiagnostics(diagnostics),
        failureClass,
        failureClass,
        this.nowIso(),
        this.workspace.id,
        plane,
      );
  }

  claimCodeIndexEmbedding(
    input: CodeIndexSemanticClaimInput,
    owner: SemanticReconciliationOwner,
  ): CodeIndexSemanticClaimResult {
    return this.transaction(() => {
      this.ensureSemanticClaimRow("code");
      const workspace = this.getWorkspace();
      const state = this.getSemanticState("code");
      if (
        !state?.modelKey ||
        workspace.currentGeneration !== input.expectedCurrentGeneration ||
        state.graphGeneration !== workspace.currentGeneration ||
        state.modelKey !== input.modelKey ||
        input.targetGeneration <= workspace.currentGeneration ||
        input.eligibleEntityCount < 0
      ) {
        return { claim: null, reason: "state_changed" };
      }
      const attemptInput = {
        modelKey: state.modelKey,
        baseGraphGeneration: workspace.currentGeneration,
        targetGraphGeneration: input.targetGeneration,
        baseSemanticRevision: state.semanticRevision,
        eligibleEntityCount: input.eligibleEntityCount,
        documentSetDigest: input.documentSetDigest,
        materialFingerprint: input.materialFingerprint,
      };
      const attemptToken = this.codeIndexAttemptToken(attemptInput);
      const nowEpoch = this.databaseEpoch();
      const row = this.db
        .prepare("SELECT * FROM semantic_reconciliation_claims WHERE workspace_id = ? AND plane = 'code'")
        .get(this.workspace.id);
      const activeToken = nullableString(row?.active_attempt_token);
      const activeOwner = nullableString(row?.owner_uuid);
      const leaseExpiry = row?.lease_expiry_epoch === null ? null : numberValue(row?.lease_expiry_epoch);
      const completedToken = nullableString(row?.last_completed_attempt_token);
      const makeClaim = (expiry: number): CodeIndexSemanticClaim => ({
        operation: "code_index",
        plane: "code",
        attemptToken,
        ...attemptInput,
        leaseExpiryEpoch: expiry,
        ...owner,
      });

      if (
        activeToken === attemptToken &&
        activeOwner === owner.ownerUuid &&
        leaseExpiry !== null &&
        leaseExpiry > nowEpoch &&
        completedToken !== attemptToken
      ) {
        const expiry = nowEpoch + 30;
        const renewed = this.db
          .prepare(
            `UPDATE semantic_reconciliation_claims SET heartbeat_epoch = ?, lease_expiry_epoch = ?
             WHERE workspace_id = ? AND plane = 'code' AND active_attempt_token = ? AND owner_uuid = ?
               AND lease_expiry_epoch > ?`,
          )
          .run(nowEpoch, expiry, this.workspace.id, attemptToken, owner.ownerUuid, nowEpoch);
        return Number(renewed.changes) === 1
          ? { claim: makeClaim(expiry), reason: "acquired" }
          : { claim: null, reason: "state_changed" };
      }
      if (activeToken && leaseExpiry !== null && leaseExpiry > nowEpoch) {
        return { claim: null, reason: "leased" };
      }
      if (activeToken === attemptToken && completedToken !== attemptToken) {
        const expiry = nowEpoch + 30;
        const taken = this.db
          .prepare(
            `UPDATE semantic_reconciliation_claims SET
               owner_uuid = ?, owner_pid = ?, owner_hostname = ?, heartbeat_epoch = ?, lease_expiry_epoch = ?,
               takeover_count = takeover_count + 1
             WHERE workspace_id = ? AND plane = 'code' AND active_attempt_token = ?
               AND (lease_expiry_epoch IS NULL OR lease_expiry_epoch <= ?)
               AND last_completed_attempt_token IS NOT ?`,
          )
          .run(
            owner.ownerUuid,
            owner.ownerPid,
            owner.ownerHostname,
            nowEpoch,
            expiry,
            this.workspace.id,
            attemptToken,
            nowEpoch,
            attemptToken,
          );
        return Number(taken.changes) === 1
          ? { claim: makeClaim(expiry), reason: "acquired" }
          : { claim: null, reason: "state_changed" };
      }
      if (completedToken === attemptToken) return { claim: null, reason: "completed" };

      const expiry = nowEpoch + 30;
      const acquired = this.db
        .prepare(
          `UPDATE semantic_reconciliation_claims SET
             last_completed_attempt_token = CASE
               WHEN active_attempt_token IS NULL THEN last_completed_attempt_token ELSE active_attempt_token END,
             completed_outcome = CASE
               WHEN active_attempt_token IS NULL THEN completed_outcome ELSE 'superseded' END,
             completed_epoch = CASE WHEN active_attempt_token IS NULL THEN completed_epoch ELSE ? END,
             active_attempt_token = ?, target_model_key = ?, target_graph_generation = ?,
             target_semantic_revision = ?, owner_uuid = ?, owner_pid = ?, owner_hostname = ?,
             heartbeat_epoch = ?, lease_expiry_epoch = ?, claim_count = claim_count + 1,
             supersede_count = supersede_count + CASE WHEN active_attempt_token IS NULL THEN 0 ELSE 1 END
           WHERE workspace_id = ? AND plane = 'code'
             AND (active_attempt_token IS NULL OR lease_expiry_epoch <= ?)
             AND last_completed_attempt_token IS NOT ?`,
        )
        .run(
          nowEpoch,
          attemptToken,
          state.modelKey,
          input.targetGeneration,
          state.semanticRevision,
          owner.ownerUuid,
          owner.ownerPid,
          owner.ownerHostname,
          nowEpoch,
          expiry,
          this.workspace.id,
          nowEpoch,
          attemptToken,
        );
      return Number(acquired.changes) === 1
        ? { claim: makeClaim(expiry), reason: "acquired" }
        : { claim: null, reason: "state_changed" };
    });
  }

  heartbeatCodeIndexEmbedding(claim: CodeIndexSemanticClaim): boolean {
    return this.transaction(() => {
      const nowEpoch = this.databaseEpoch();
      if (!this.verifyCodeIndexClaim(claim, undefined, undefined, nowEpoch)) return false;
      const expiry = nowEpoch + 30;
      const result = this.db
        .prepare(
          `UPDATE semantic_reconciliation_claims SET heartbeat_epoch = ?, lease_expiry_epoch = ?
           WHERE workspace_id = ? AND plane = 'code' AND active_attempt_token = ? AND owner_uuid = ?`,
        )
        .run(nowEpoch, expiry, this.workspace.id, claim.attemptToken, claim.ownerUuid);
      return Number(result.changes) === 1;
    });
  }

  abandonCodeIndexClaim(
    claim: CodeIndexSemanticClaim,
    _reason: "index_failed" | "lease_lost",
  ): boolean {
    return this.transaction(() => {
      const nowEpoch = this.databaseEpoch();
      const result = this.db
        .prepare(
          `UPDATE semantic_reconciliation_claims SET
             active_attempt_token = NULL, target_model_key = NULL, target_graph_generation = NULL,
             target_semantic_revision = NULL, owner_uuid = NULL, owner_pid = NULL, owner_hostname = NULL,
             heartbeat_epoch = NULL, lease_expiry_epoch = NULL,
             last_completed_attempt_token = ?, completed_outcome = 'lost', completed_epoch = ?
           WHERE workspace_id = ? AND plane = 'code' AND active_attempt_token = ? AND owner_uuid = ?`,
        )
        .run(claim.attemptToken, nowEpoch, this.workspace.id, claim.attemptToken, claim.ownerUuid);
      return Number(result.changes) === 1;
    });
  }

  claimSemanticReconciliation(
    plane: SemanticPlane,
    owner: SemanticReconciliationOwner,
  ): SemanticReconciliationClaimResult {
    return this.transaction(() => {
      this.ensureSemanticClaimRow(plane);
      const state = this.getSemanticState(plane);
      if (!state?.modelKey) return { claim: null, reason: "not_configured" };
      if (this.refreshSemanticClaimCounts(plane, state)) {
        return { claim: null, reason: "state_changed" };
      }
      const nowEpoch = this.databaseEpoch();
      const retryDue =
        state.failureClass === "runtime_retryable" &&
        state.nextRetryEpoch !== null &&
        state.nextRetryEpoch <= nowEpoch;
      if (
        state.failureClass === "runtime_retryable" &&
        state.nextRetryEpoch !== null &&
        !retryDue
      ) {
        return { claim: null, reason: "backoff" };
      }
      const retryGeneration = retryDue ? state.retryGeneration + 1 : state.retryGeneration;
      const attemptToken = this.semanticAttemptToken(state, retryGeneration);
      const row = this.db
        .prepare("SELECT * FROM semantic_reconciliation_claims WHERE workspace_id = ? AND plane = ?")
        .get(this.workspace.id, plane);
      const activeToken = nullableString(row?.active_attempt_token);
      const activeOwner = nullableString(row?.owner_uuid);
      const leaseExpiry = row?.lease_expiry_epoch === null ? null : numberValue(row?.lease_expiry_epoch);
      const completedToken = nullableString(row?.last_completed_attempt_token);
      const makeClaim = (expiry: number): SemanticReconciliationClaim => ({
        plane,
        attemptToken,
        modelKey: state.modelKey!,
        graphGeneration: state.graphGeneration,
        semanticRevision: state.semanticRevision,
        retryGeneration,
        leaseExpiryEpoch: expiry,
        ...owner,
      });

      if (
        activeToken === attemptToken &&
        activeOwner === owner.ownerUuid &&
        leaseExpiry !== null &&
        leaseExpiry > nowEpoch &&
        completedToken !== attemptToken
      ) {
        const expiry = nowEpoch + 30;
        const renewed = this.db
          .prepare(
            `UPDATE semantic_reconciliation_claims SET heartbeat_epoch = ?, lease_expiry_epoch = ?
             WHERE workspace_id = ? AND plane = ? AND active_attempt_token = ? AND owner_uuid = ?
               AND lease_expiry_epoch > ?`,
          )
          .run(nowEpoch, expiry, this.workspace.id, plane, attemptToken, owner.ownerUuid, nowEpoch);
        return Number(renewed.changes) === 1
          ? { claim: makeClaim(expiry), reason: "acquired" }
          : { claim: null, reason: "state_changed" };
      }
      if (activeToken && leaseExpiry !== null && leaseExpiry > nowEpoch) {
        return { claim: null, reason: "leased" };
      }
      if (activeToken === attemptToken && completedToken !== attemptToken) {
        const expiry = nowEpoch + 30;
        const taken = this.db
          .prepare(
            `UPDATE semantic_reconciliation_claims SET
               owner_uuid = ?, owner_pid = ?, owner_hostname = ?, heartbeat_epoch = ?, lease_expiry_epoch = ?,
               takeover_count = takeover_count + 1
             WHERE workspace_id = ? AND plane = ? AND active_attempt_token = ?
               AND (lease_expiry_epoch IS NULL OR lease_expiry_epoch <= ?)
               AND last_completed_attempt_token IS NOT ?`,
          )
          .run(
            owner.ownerUuid,
            owner.ownerPid,
            owner.ownerHostname,
            nowEpoch,
            expiry,
            this.workspace.id,
            plane,
            attemptToken,
            nowEpoch,
            attemptToken,
          );
        return Number(taken.changes) === 1
          ? { claim: makeClaim(expiry), reason: "acquired" }
          : { claim: null, reason: "state_changed" };
      }
      if (completedToken === attemptToken) return { claim: null, reason: "completed" };

      const expiry = nowEpoch + 30;
      const acquired = this.db
        .prepare(
          `UPDATE semantic_reconciliation_claims SET
             active_attempt_token = ?, target_model_key = ?, target_graph_generation = ?,
             target_semantic_revision = ?, owner_uuid = ?, owner_pid = ?, owner_hostname = ?,
             heartbeat_epoch = ?, lease_expiry_epoch = ?, claim_count = claim_count + 1,
             supersede_count = supersede_count + CASE WHEN active_attempt_token IS NULL THEN 0 ELSE 1 END
           WHERE workspace_id = ? AND plane = ?
             AND (active_attempt_token IS NULL OR lease_expiry_epoch <= ?)
             AND last_completed_attempt_token IS NOT ?`,
        )
        .run(
          attemptToken,
          state.modelKey,
          state.graphGeneration,
          state.semanticRevision,
          owner.ownerUuid,
          owner.ownerPid,
          owner.ownerHostname,
          nowEpoch,
          expiry,
          this.workspace.id,
          plane,
          nowEpoch,
          attemptToken,
        );
      if (Number(acquired.changes) !== 1) return { claim: null, reason: "state_changed" };
      if (retryDue) {
        const advanced = this.db
          .prepare(
            `UPDATE workspace_semantic_state SET retry_generation = ?, next_retry_epoch = NULL
             WHERE workspace_id = ? AND plane = ? AND retry_generation = ?
               AND next_retry_epoch IS NOT NULL AND next_retry_epoch <= ?`,
          )
          .run(retryGeneration, this.workspace.id, plane, state.retryGeneration, nowEpoch);
        if (Number(advanced.changes) !== 1) throw new ContextMeshError("INTERNAL_ERROR", "Semantic retry claim lost its state fence");
      }
      return { claim: makeClaim(expiry), reason: "acquired" };
    });
  }

  heartbeatSemanticReconciliation(claim: SemanticReconciliationClaim): boolean {
    return this.transaction(() => {
      const nowEpoch = this.databaseEpoch();
      if (!this.verifySemanticClaim(claim, nowEpoch)) return false;
      const expiry = nowEpoch + 30;
      const result = this.db
        .prepare(
          `UPDATE semantic_reconciliation_claims SET heartbeat_epoch = ?, lease_expiry_epoch = ?
           WHERE workspace_id = ? AND plane = ? AND active_attempt_token = ? AND owner_uuid = ?`,
        )
        .run(nowEpoch, expiry, this.workspace.id, claim.plane, claim.attemptToken, claim.ownerUuid);
      return Number(result.changes) === 1;
    });
  }

  completeSemanticReconciliationFailure(
    claim: SemanticReconciliationClaim,
    primary: SemanticFailureDiagnostic,
    diagnostics: readonly SemanticFailureDiagnostic[],
    eligibleEntityCount: number,
    validEmbeddingCount: number,
  ): boolean {
    return this.transaction(() => {
      const nowEpoch = this.databaseEpoch();
      const current = this.getSemanticState(claim.plane);
      if (!current || this.refreshSemanticClaimCounts(claim.plane, current)) return false;
      if (
        current.eligibleEntityCount !== eligibleEntityCount ||
        current.validEmbeddingCount !== validEmbeddingCount
      ) {
        return false;
      }
      if (!this.verifySemanticClaim(claim, nowEpoch)) return false;
      const state = this.getSemanticState(claim.plane);
      if (!state) return false;
      const retryCount = primary.failureClass === "runtime_retryable" ? state.retryCount + 1 : 0;
      const delays = [30, 120, 600] as const;
      const nextRetryEpoch = primary.failureClass === "runtime_retryable"
        ? nowEpoch + delays[Math.min(retryCount - 1, delays.length - 1)]!
        : null;
      const status = this.semanticStatusForFailure(primary.failureClass, eligibleEntityCount, validEmbeddingCount);
      this.db
        .prepare(
          `UPDATE workspace_semantic_state SET
             status = ?, eligible_entity_count = ?, valid_embedding_count = ?, last_error = ?,
             failure_class = ?, normalized_error_code = ?, failure_fingerprint = ?,
             material_fingerprint = ?, diagnostics_json = ?, retry_count = ?, next_retry_epoch = ?, updated_at = ?
           WHERE workspace_id = ? AND plane = ? AND model_key = ?
             AND graph_generation IS ? AND semantic_revision = ?`,
        )
        .run(
          status,
          eligibleEntityCount,
          validEmbeddingCount,
          primary.safeSummary,
          primary.failureClass,
          primary.code,
          semanticFailureFingerprint(primary),
          primary.materialFingerprint ?? state.materialFingerprint,
          this.safeDiagnostics(diagnostics),
          retryCount,
          nextRetryEpoch,
          this.nowIso(),
          this.workspace.id,
          claim.plane,
          claim.modelKey,
          claim.graphGeneration,
          claim.semanticRevision,
        );
      return this.completeSemanticClaim(claim, "failed", true);
    });
  }

  getSemanticClaimDiagnostics(plane: SemanticPlane): SemanticClaimDiagnostics {
    this.ensureSemanticClaimRow(plane);
    const row = this.db
      .prepare("SELECT * FROM semantic_reconciliation_claims WHERE workspace_id = ? AND plane = ?")
      .get(this.workspace.id, plane);
    return {
      activeAttemptToken: nullableString(row?.active_attempt_token),
      lastCompletedAttemptToken: nullableString(row?.last_completed_attempt_token),
      claimCount: numberValue(row?.claim_count),
      takeoverCount: numberValue(row?.takeover_count),
      supersedeCount: numberValue(row?.supersede_count),
      leaseExpiryEpoch: row?.lease_expiry_epoch === null ? null : numberValue(row?.lease_expiry_epoch),
    };
  }

  getCodeNodesByIds(ids: string[]): CodeSearchResult[] {
    const uniqueIds = unique(ids);
    if (uniqueIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT node.*, file.relative_path, file.content_hash AS file_content_hash, 0.0 AS score
         FROM code_nodes node LEFT JOIN source_files file ON file.id = node.file_id
         WHERE node.workspace_id = ? AND node.id IN (${placeholders(uniqueIds.length)})`,
      )
      .all(this.workspace.id, ...uniqueIds);
    const byId = new Map(this.applyPrecisionNodeOverlays(rows.map(mapCodeNode)).map((node) => {
      return [node.id, node] as const;
    }));
    return uniqueIds.flatMap((id) => {
      const node = byId.get(id);
      return node ? [node] : [];
    });
  }

  getMemoriesByIds(memoryIds: string[], timestamp = this.nowIso()): MemoryFragmentRecord[] {
    const ids = unique(memoryIds);
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_fragments
         WHERE workspace_id = ? AND id IN (${placeholders(ids.length)}) AND state = 'active'
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .all(this.workspace.id, ...ids, timestamp);
    const byId = new Map(rows.map((row) => {
      const memory = mapMemory(row);
      return [memory.id, memory] as const;
    }));
    return ids.flatMap((id) => {
      const memory = byId.get(id);
      return memory ? [memory] : [];
    });
  }

  commitCodeSemanticBackfill(
    expectedGeneration: number,
    commit: SemanticPlaneCommit,
    claim?: SemanticReconciliationClaim,
  ): boolean {
    const timestamp = this.nowIso();
    return this.transaction(() => {
      if (this.getWorkspace().currentGeneration !== expectedGeneration) return false;
      if (claim && !this.verifySemanticClaim(claim)) return false;
      this.applyCodeSemanticCommit(expectedGeneration, commit, timestamp);
      if (claim && !this.completeSemanticClaim(claim, commit.failure ? "failed" : "succeeded", true)) {
        throw new ContextMeshError("INTERNAL_ERROR", "Semantic code claim could not be completed");
      }
      return true;
    });
  }

  private refreshMemorySemanticState(
    commit: SemanticPlaneCommit,
    timestamp: string,
    preservedAttemptToken?: string,
  ): void {
    this.supersedeSemanticClaim("memory", preservedAttemptToken);
    this.db
      .prepare(
        `DELETE FROM semantic_embeddings
         WHERE workspace_key = ? AND plane = 'memory'
           AND model_id = (SELECT model_id FROM semantic_models WHERE model_key = ?)
           AND NOT EXISTS (
             SELECT 1 FROM memory_fragments memory
             WHERE memory.workspace_id = ?
               AND memory.id = CAST(semantic_embeddings.entity_key AS TEXT)
               AND memory.semantic_source_hash = lower(hex(semantic_embeddings.source_hash))
               AND memory.state = 'active'
               AND (memory.expires_at IS NULL OR memory.expires_at > ?)
           )`,
      )
      .run(this.semanticWorkspaceKey(), commit.modelKey, this.workspace.id, timestamp);
    const counts = this.db
      .prepare(
        `SELECT
           (SELECT count(*) FROM memory_fragments
           WHERE workspace_id = ? AND state = 'active' AND semantic_source_hash IS NOT NULL
              AND (expires_at IS NULL OR expires_at > ?)) AS eligible,
           (SELECT count(*) FROM semantic_embeddings embedding
            JOIN semantic_models model ON model.model_id = embedding.model_id
            JOIN memory_fragments memory ON memory.workspace_id = ?
              AND memory.id = CAST(embedding.entity_key AS TEXT)
              AND memory.semantic_source_hash = lower(hex(embedding.source_hash))
            WHERE embedding.workspace_key = ? AND embedding.plane = 'memory'
              AND model.model_key = ? AND memory.state = 'active'
              AND (memory.expires_at IS NULL OR memory.expires_at > ?)
              AND length(embedding.vector) = ?) AS valid`,
      )
      .get(
        this.workspace.id,
        timestamp,
        this.workspace.id,
        this.semanticWorkspaceKey(),
        commit.modelKey,
        timestamp,
        commit.dimensions * Float32Array.BYTES_PER_ELEMENT,
      );
    const eligible = numberValue(counts?.eligible);
    const valid = numberValue(counts?.valid);
    const status = this.semanticStatusForCounts(eligible, valid, commit.unavailable ?? false);
    this.db
      .prepare(
        `UPDATE workspace_semantic_state SET
           semantic_revision = semantic_revision + 1, status = ?,
           eligible_entity_count = ?, valid_embedding_count = ?, last_error = ?, updated_at = ?
         WHERE workspace_id = ? AND plane = 'memory' AND model_key = ?`,
      )
      .run(
        status,
        eligible,
        valid,
        commit.lastError ?? null,
        timestamp,
        this.workspace.id,
        commit.modelKey,
      );
    this.applySemanticCommitDiagnostics("memory", commit, eligible, valid);
  }

  commitMemorySemanticBackfill(
    expectedRevision: number,
    commit: SemanticPlaneCommit,
    timestamp = this.nowIso(),
    claim?: SemanticReconciliationClaim,
  ): boolean {
    return this.transaction(() => {
      const eligibilityTimestamp = claim ? this.databaseIso() : timestamp;
      const state = this.getSemanticState("memory");
      if (!state || state.modelKey !== commit.modelKey || state.semanticRevision !== expectedRevision) return false;
      if (claim && !this.verifySemanticClaim(claim)) return false;
      const check = this.db.prepare(
        `SELECT id FROM memory_fragments
         WHERE workspace_id = ? AND id = ? AND semantic_source_hash = ? AND state = 'active'
           AND (expires_at IS NULL OR expires_at > ?)`,
      );
      for (const entry of commit.entries) {
        if (!check.get(this.workspace.id, entry.entityId, entry.sourceHash, eligibilityTimestamp)) {
          // Expiry is not revisioned by the memory row itself. Prune any old
          // vector and advance the semantic revision now so warm readers cannot
          // retain a stale BLOB until a later reconciliation request.
          this.refreshMemorySemanticState(commit, eligibilityTimestamp, claim?.attemptToken);
          // Fence the stale owner immediately so a new DB-time snapshot need
          // not wait for the crash-recovery lease to expire.
          if (claim) this.supersedeSemanticClaim("memory");
          return false;
        }
      }
      const existingIds = this.semanticEmbeddingIds("memory", commit.modelKey);
      for (const entry of commit.entries) {
        this.writeSemanticEntry(
          "memory",
          null,
          commit,
          entry,
          existingIds.get(this.semanticEntityMapKey("memory", entry.entityId)),
        );
      }
      this.refreshMemorySemanticState(commit, eligibilityTimestamp, claim?.attemptToken);
      if (claim && !this.completeSemanticClaim(claim, commit.failure ? "failed" : "succeeded", true)) {
        throw new ContextMeshError("INTERNAL_ERROR", "Semantic memory claim could not be completed");
      }
      return true;
    });
  }

  casUpsertMemoryEmbedding(
    capture: MemorySemanticCapture,
    vector: Uint8Array,
    dimensions: number,
    codec: string,
    timestamp = this.nowIso(),
  ): boolean {
    return this.transaction(() => {
      const state = this.getSemanticState("memory");
      if (
        !state ||
        state.modelKey !== capture.modelKey ||
        state.semanticRevision !== capture.semanticRevision
      ) {
        return false;
      }
      const row = this.db
        .prepare(
          `SELECT id FROM memory_fragments
           WHERE workspace_id = ? AND id = ? AND semantic_source_hash = ? AND state = 'active'
             AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .get(this.workspace.id, capture.entityId, capture.sourceHash, timestamp);
      if (!row) return false;
      const commit: SemanticPlaneCommit = {
        modelKey: capture.modelKey,
        dimensions,
        codec,
        entries: [{ entityId: capture.entityId, sourceHash: capture.sourceHash, vector }],
      };
      const existingId = this.semanticEmbeddingIds("memory", commit.modelKey).get(
        this.semanticEntityMapKey("memory", capture.entityId),
      );
      this.writeSemanticEntry("memory", null, commit, commit.entries[0]!, existingId);
      this.refreshMemorySemanticState(commit, timestamp);
      return true;
    });
  }

  markSemanticUnavailable(plane: SemanticPlane, error: string): void {
    this.db
      .prepare(
        `UPDATE workspace_semantic_state SET status = 'unavailable', last_error = ?, updated_at = ?
         WHERE workspace_id = ? AND plane = ?`,
      )
      .run(error, this.nowIso(), this.workspace.id, plane);
  }

  markSemanticNeedsBackfill(plane: SemanticPlane, error: string): void {
    this.db
      .prepare(
        `UPDATE workspace_semantic_state SET
           status = CASE WHEN valid_embedding_count > 0 THEN 'partial' ELSE 'needs_backfill' END,
           last_error = ?, updated_at = ?
         WHERE workspace_id = ? AND plane = ?`,
      )
      .run(error, this.nowIso(), this.workspace.id, plane);
  }

  getStatus(): Record<string, unknown> {
    const workspace = this.getWorkspace();
    const counts = this.db
      .prepare(
        `SELECT
          (SELECT count(*) FROM source_files WHERE workspace_id = ?) AS files,
          (SELECT count(*) FROM code_nodes WHERE workspace_id = ?) AS nodes,
          (SELECT count(*) FROM code_edges WHERE workspace_id = ?) AS edges,
          (SELECT count(*) FROM unresolved_refs WHERE workspace_id = ?) AS unresolved,
          (SELECT count(*) FROM memory_fragments WHERE workspace_id = ? AND state = 'active') AS memories`,
      )
      .get(this.workspace.id, this.workspace.id, this.workspace.id, this.workspace.id, this.workspace.id);
    const lastRun = this.db
      .prepare("SELECT * FROM index_runs WHERE workspace_id = ? ORDER BY generation DESC LIMIT 1")
      .get(this.workspace.id);
    return {
      workspace,
      indexed: workspace.currentGeneration > 0,
      counts: {
        files: numberValue(counts?.files),
        nodes: numberValue(counts?.nodes),
        edges: numberValue(counts?.edges),
        unresolved: numberValue(counts?.unresolved),
        memories: numberValue(counts?.memories),
      },
      lastRun: lastRun
        ? {
            id: stringValue(lastRun.id),
            generation: numberValue(lastRun.generation),
            mode: stringValue(lastRun.mode),
            status: stringValue(lastRun.status),
            diagnostics: parseJson<string[]>(lastRun.diagnostics_json, []),
            adapterStats: parseJson(lastRun.adapter_stats_json, []),
            startedAt: stringValue(lastRun.started_at),
            completedAt: nullableString(lastRun.completed_at),
          }
        : null,
      operational: this.getOperationalStatus(),
      precision: {
        revision: this.getPrecisionRevision(),
        providers: this.getPrecisionProviderStates(),
      },
    };
  }

  searchCode(query: string, kinds: CodeNodeKind[] | undefined, limit: number, offset = 0): CodeSearchResult[] {
    if (this.getWorkspace().currentGeneration === 0) {
      throw new ContextMeshError("NOT_INDEXED", "Workspace has not been indexed yet");
    }
    const ftsQuery = buildFtsQuery(query);
    const kindClause = kinds?.length ? ` AND n.kind IN (${placeholders(kinds.length)})` : "";
    const kindParams = kinds ?? [];
    if (ftsQuery) {
      const rows = this.db
        .prepare(
          `SELECT n.*, f.relative_path, f.content_hash AS file_content_hash, bm25(code_nodes_fts) AS rank,
             CASE WHEN lower(n.name) = lower(?) THEN 1.0
                  WHEN lower(n.qualified_name) = lower(?) THEN 0.95
                  ELSE 1.0 / (1.0 + abs(bm25(code_nodes_fts))) END AS score
           FROM code_nodes_fts
           JOIN code_nodes n ON n.id = code_nodes_fts.node_id
           LEFT JOIN source_files f ON f.id = n.file_id
           WHERE code_nodes_fts MATCH ? AND n.workspace_id = ?${kindClause}
           ORDER BY CASE WHEN lower(n.name) = lower(?) THEN 0 ELSE 1 END,
                    bm25(code_nodes_fts), n.qualified_name, n.id
           LIMIT ? OFFSET ?`,
        )
        .all(query, query, ftsQuery, this.workspace.id, ...kindParams, query, limit, offset);
      return this.applyPrecisionNodeOverlays(rows.map(mapCodeNode));
    }
    const rows = this.db
      .prepare(
        `SELECT n.*, f.relative_path, f.content_hash AS file_content_hash, 0.5 AS score
         FROM code_nodes n LEFT JOIN source_files f ON f.id = n.file_id
         WHERE n.workspace_id = ? AND (n.name LIKE ? OR n.qualified_name LIKE ?)${kindClause}
         ORDER BY n.qualified_name, n.id LIMIT ? OFFSET ?`,
      )
      .all(this.workspace.id, `%${query}%`, `%${query}%`, ...kindParams, limit, offset);
    return this.applyPrecisionNodeOverlays(rows.map(mapCodeNode));
  }

  getCodeNode(id: string): CodeSearchResult | null {
    let row = this.db
      .prepare(
        `SELECT n.*, f.relative_path, f.content_hash AS file_content_hash, 1.0 AS score
         FROM code_nodes n LEFT JOIN source_files f ON f.id = n.file_id
         WHERE n.workspace_id = ? AND n.id = ?`,
      )
      .get(this.workspace.id, id);
    if (!row) {
      const aliases = this.db.prepare(
        `SELECT n.*, f.relative_path, f.content_hash AS file_content_hash, 1.0 AS score
         FROM code_nodes n LEFT JOIN source_files f ON f.id=n.file_id
         WHERE n.workspace_id=? AND n.kind='external_module' ORDER BY n.id`,
      ).all(this.workspace.id);
      row = aliases.find((candidate) => {
        const metadata = parseJson<Record<string, unknown>>(candidate.metadata_json, {});
        return typeof metadata.legacyAlias === "string" && sha256(`${this.workspace.id}\0${metadata.legacyAlias}`) === id;
      });
    }
    return row ? (this.applyPrecisionNodeOverlays([mapCodeNode(row)])[0] ?? null) : null;
  }

  traceCode(
    symbolId: string,
    direction: "in" | "out" | "both",
    edgeKinds: CodeEdgeKind[] | undefined,
    maxDepth: number,
    limit: number,
  ): TraceResult {
    const start = this.getCodeNode(symbolId);
    if (!start) throw new ContextMeshError("NOT_FOUND", `Code symbol not found: ${symbolId}`);

    const nodes = new Map<string, CodeSearchResult>([[start.id, start]]);
    const edges: TraceEdgeResult[] = [];
    const visited = new Set<string>([start.id]);
    const queue: Array<{ id: string; depth: number }> = [{ id: start.id, depth: 0 }];
    const allowedKinds = edgeKinds ? new Set(edgeKinds) : null;
    const partitions = [this.getStoredGraphPartition("non-python"), this.getStoredGraphPartition("python")];
    const effectiveEdges = partitions.flatMap((partition) => partition.edges);

    while (queue.length > 0 && edges.length < limit) {
      const current = queue.shift();
      if (!current || current.depth >= maxDepth) continue;
      const rows = effectiveEdges.filter((edge) => (direction === "out" ? edge.sourceId === current.id
        : direction === "in" ? edge.targetId === current.id : edge.sourceId === current.id || edge.targetId === current.id) &&
        (!allowedKinds || allowedKinds.has(edge.kind)))
        .sort((left, right) => `${left.kind}\0${left.sourceId}\0${left.targetId}`.localeCompare(`${right.kind}\0${right.sourceId}\0${right.targetId}`));
      for (const row of rows) {
        if (edges.length >= limit) break;
        const sourceId = row.sourceId;
        const targetId = row.targetId;
        const nextId = sourceId === current.id ? targetId : sourceId;
        edges.push({
          sourceId,
          targetId,
          kind: row.kind,
          confidence: row.confidence,
          resolutionKind: row.resolutionKind,
          depth: current.depth + 1,
          status: row.status ?? "resolved",
          evidence: row.evidence,
        });
        if (!visited.has(nextId)) {
          const node = this.getCodeNode(nextId);
          if (node) nodes.set(nextId, node);
          if (row.status !== "rejected") {
            visited.add(nextId);
            queue.push({ id: nextId, depth: current.depth + 1 });
          }
        }
      }
    }

    const unresolvedRows = partitions.flatMap((partition) => partition.unresolvedReferences)
      .filter((item) => item.sourceNodeId !== null && visited.has(item.sourceNodeId))
      .sort((left, right) => left.line - right.line || left.column - right.column).slice(0, 100);
    return {
      start,
      nodes: [...nodes.values()],
      edges,
      unresolved: unresolvedRows.map((row) => ({
        sourceNodeId: row.sourceNodeId,
        kind: row.kind,
        rawName: row.rawName,
        line: row.line,
        column: row.column,
        confidence: row.confidence ?? 0.5,
        evidence: row.evidence,
      })),
      truncated: edges.length >= limit,
    };
  }

  private ensureSession(sessionId: string, clientName: string | null, timestamp: string): void {
    this.db
      .prepare(
        `INSERT INTO sessions(id, workspace_id, client_name, started_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET client_name = COALESCE(excluded.client_name, sessions.client_name)`,
      )
      .run(sessionId, this.workspace.id, clientName, timestamp);
  }

  private existingActiveMemory(contentHash: string): MemoryFragmentRecord | null {
    const row = this.db
      .prepare("SELECT * FROM memory_fragments WHERE workspace_id = ? AND content_hash = ? AND state = 'active'")
      .get(this.workspace.id, contentHash);
    return row ? mapMemory(row) : null;
  }

  private insertMemory(
    input: RememberInput,
    timestamp: string,
    warnings: string[],
  ): { fragment: MemoryFragmentRecord; duplicate: boolean; semanticSourceHash: string } {
    const contentHash = memoryHash(input);
    const duplicate = this.existingActiveMemory(contentHash);
    if (duplicate) {
      return {
        fragment: duplicate,
        duplicate: true,
        semanticSourceHash: buildMemorySemanticDocument(duplicate).sourceHash,
      };
    }

    if (input.sessionId) this.ensureSession(input.sessionId, null, timestamp);
    if (input.supersedesId) {
      const previous = this.db
        .prepare("SELECT id FROM memory_fragments WHERE workspace_id = ? AND id = ? AND state = 'active'")
        .get(this.workspace.id, input.supersedesId);
      if (!previous) {
        throw new ContextMeshError("NOT_FOUND", `Active memory to supersede was not found: ${input.supersedesId}`);
      }
      this.db
        .prepare("UPDATE memory_fragments SET state = 'superseded', updated_at = ? WHERE id = ?")
        .run(timestamp, input.supersedesId);
      this.db.prepare("DELETE FROM memory_fragments_fts WHERE fragment_id = ?").run(input.supersedesId);
      this.db
        .prepare("DELETE FROM semantic_embeddings WHERE workspace_key = ? AND plane = 'memory' AND entity_key = ?")
        .run(this.semanticWorkspaceKey(), this.semanticEntityKey("memory", input.supersedesId));
      this.db
        .prepare(
          `INSERT INTO memory_events(workspace_id, fragment_id, session_id, event_type, payload_json, created_at)
           VALUES (?, ?, ?, 'superseded', ?, ?)`,
        )
        .run(this.workspace.id, input.supersedesId, input.sessionId ?? null, "{}", timestamp);
    }

    const id = `mem_${randomUUID()}`;
    const expiresAt = input.ttlDays
      ? new Date(Date.parse(timestamp) + input.ttlDays * 86_400_000).toISOString()
      : null;
    const normalizedKeywords = unique(input.keywords.map((keyword) => keyword.normalize("NFC")));
    const semanticSourceHash = buildMemorySemanticDocument({
      id,
      workspaceId: this.workspace.id,
      type: input.type,
      topic: input.topic,
      content: input.content,
      keywords: normalizedKeywords,
      importance: input.importance,
      isAnchor: input.anchor,
      assertionStatus: input.assertionStatus,
      state: "active",
      sessionId: input.sessionId ?? null,
      supersedesId: input.supersedesId ?? null,
      accessCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastAccessedAt: null,
      expiresAt,
    }).sourceHash;
    this.db
      .prepare(
        `INSERT INTO memory_fragments(
          id, workspace_id, type, topic, content, keywords_json, importance, is_anchor,
          assertion_status, content_hash, session_id, supersedes_id, created_at, updated_at, expires_at,
          semantic_source_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.workspace.id,
        input.type,
        input.topic,
        input.content,
        JSON.stringify(normalizedKeywords),
        input.importance,
        input.anchor ? 1 : 0,
        input.assertionStatus,
        contentHash,
        input.sessionId ?? null,
        input.supersedesId ?? null,
        timestamp,
        timestamp,
        expiresAt,
        semanticSourceHash,
      );
    this.db
      .prepare("INSERT INTO memory_fragments_fts(fragment_id, topic, content, keywords) VALUES (?, ?, ?, ?)")
      .run(id, input.topic, input.content, input.keywords.join(" "));

    const nodeQuery = this.db.prepare(
      `SELECT n.*, f.relative_path FROM code_nodes n LEFT JOIN source_files f ON f.id = n.file_id
       WHERE n.workspace_id = ? AND n.id = ?`,
    );
    const link = this.db.prepare(
      `INSERT OR IGNORE INTO memory_code_links(
        workspace_id, memory_id, code_node_id, node_local_key, relation_type,
        confidence, locator_snapshot_json, created_at
      ) VALUES (?, ?, ?, ?, ?, 1.0, ?, ?)`,
    );
    const linkEvent = this.db.prepare(
      `INSERT INTO memory_events(workspace_id, fragment_id, session_id, event_type, payload_json, created_at)
       VALUES (?, ?, ?, 'linked', ?, ?)`,
    );
    const relationType =
      input.type === "decision"
        ? "decision_for"
        : input.type === "error"
          ? "error_in"
          : input.type === "procedure"
            ? "procedure_for"
            : "about";
    for (const symbolId of unique(input.sourceSymbolIds)) {
      const node = nodeQuery.get(this.workspace.id, symbolId);
      if (!node) {
        warnings.push(`Source symbol was not found and was not linked: ${symbolId}`);
        continue;
      }
      const linked = link.run(
        this.workspace.id,
        id,
        symbolId,
        stringValue(node.local_key),
        relationType,
        JSON.stringify({
          relativePath: nullableString(node.relative_path),
          qualifiedName: stringValue(node.qualified_name),
          kind: stringValue(node.kind),
          name: stringValue(node.name),
          contentHash: stringValue(node.content_hash),
          startLine: numberValue(node.start_line),
          endLine: numberValue(node.end_line),
        }),
        timestamp,
      );
      if (Number(linked.changes) > 0) {
        linkEvent.run(
          this.workspace.id,
          id,
          input.sessionId ?? null,
          JSON.stringify({ codeNodeId: symbolId, relationType }),
          timestamp,
        );
      }
    }
    this.db
      .prepare(
        `INSERT INTO memory_events(workspace_id, fragment_id, session_id, event_type, payload_json, created_at)
         VALUES (?, ?, ?, 'remembered', ?, ?)`,
      )
      .run(
        this.workspace.id,
        id,
        input.sessionId ?? null,
        JSON.stringify({ linkedSymbols: input.sourceSymbolIds.length }),
        timestamp,
      );
    const inserted = this.db.prepare("SELECT * FROM memory_fragments WHERE id = ?").get(id);
    if (!inserted) throw new ContextMeshError("INTERNAL_ERROR", "Memory insert did not return a row");
    return { fragment: mapMemory(inserted), duplicate: false, semanticSourceHash };
  }

  private currentMemorySemanticCommit(
    entries: SemanticCommitEntry[] = [],
    lastError: string | null = null,
  ): SemanticPlaneCommit | null {
    const state = this.getSemanticState("memory");
    if (!state?.modelKey) return null;
    const model = this.db
      .prepare("SELECT dimensions, vector_codec FROM semantic_models WHERE model_key = ?")
      .get(state.modelKey);
    if (!model) return null;
    return {
      modelKey: state.modelKey,
      dimensions: numberValue(model.dimensions),
      codec: stringValue(model.vector_codec),
      entries,
      lastError,
    };
  }

  remember(input: RememberInput): RememberResult {
    this.expireMemories();
    const warnings: string[] = [];
    return this.transaction(() => {
      const result = this.insertMemory(input, this.nowIso(), warnings);
      if (result.duplicate) return { fragment: result.fragment, duplicate: true, warnings };
      const commit = this.currentMemorySemanticCommit();
      if (!commit) return { fragment: result.fragment, duplicate: false, warnings };
      this.refreshMemorySemanticState(commit, this.nowIso());
      const state = this.getSemanticState("memory");
      return {
        fragment: result.fragment,
        duplicate: false,
        warnings,
        ...(state?.modelKey
          ? {
              semanticCapture: {
                entityId: result.fragment.id,
                sourceHash: result.semanticSourceHash,
                modelKey: state.modelKey,
                semanticRevision: state.semanticRevision,
              },
            }
          : {}),
      };
    });
  }

  private expireMemories(): number {
    const timestamp = this.nowIso();
    const rows = this.db
      .prepare(
        `SELECT id, session_id FROM memory_fragments
         WHERE workspace_id = ? AND state = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .all(this.workspace.id, timestamp);
    if (rows.length === 0) return 0;
    return this.transaction(() => {
      const update = this.db.prepare(
        "UPDATE memory_fragments SET state = 'expired', updated_at = ? WHERE id = ? AND state = 'active'",
      );
      const removeFts = this.db.prepare("DELETE FROM memory_fragments_fts WHERE fragment_id = ?");
      const event = this.db.prepare(
        `INSERT INTO memory_events(workspace_id, fragment_id, session_id, event_type, payload_json, created_at)
         VALUES (?, ?, ?, 'expired', '{}', ?)`,
      );
      for (const row of rows) {
        const id = stringValue(row.id);
        update.run(timestamp, id);
        removeFts.run(id);
        this.db
          .prepare("DELETE FROM semantic_embeddings WHERE workspace_key = ? AND plane = 'memory' AND entity_key = ?")
          .run(this.semanticWorkspaceKey(), this.semanticEntityKey("memory", id));
        event.run(this.workspace.id, id, nullableString(row.session_id), timestamp);
      }
      const semanticCommit = this.currentMemorySemanticCommit();
      if (semanticCommit) this.refreshMemorySemanticState(semanticCommit, timestamp);
      return rows.length;
    });
  }

  recall(input: RecallInput): RecallResult {
    this.expireMemories();
    return this.recallSnapshot(input);
  }

  recallSnapshot(input: RecallInput): RecallResult {
    const timestamp = this.nowIso();
    const queryText = [input.query ?? "", ...(input.keywords ?? [])].filter(Boolean).join(" ");
    const ftsQuery = buildFtsQuery(queryText);
    const typeClause = input.types?.length ? ` AND m.type IN (${placeholders(input.types.length)})` : "";
    const topicClause = input.topic ? " AND lower(m.topic) = lower(?)" : "";
    const filters = [...(input.types ?? []), ...(input.topic ? [input.topic] : [])];
    const generalRows: SqlRow[] = [];
    const fetchLimit = input.limit + 1;
    if (ftsQuery) {
      generalRows.push(
        ...this.db
          .prepare(
            `SELECT m.*, 1.0 / (1.0 + abs(bm25(memory_fragments_fts))) AS score
             FROM memory_fragments_fts
             JOIN memory_fragments m ON m.id = memory_fragments_fts.fragment_id
             WHERE memory_fragments_fts MATCH ? AND m.workspace_id = ? AND m.state = 'active'
               AND (m.expires_at IS NULL OR m.expires_at > ?) AND m.is_anchor = 0${typeClause}${topicClause}
             ORDER BY CASE WHEN lower(m.topic) = lower(?) THEN 0 ELSE 1 END,
                      CASE WHEN lower(m.content) = lower(?) THEN 0 ELSE 1 END,
                      m.is_anchor DESC, bm25(memory_fragments_fts), m.importance DESC, m.updated_at DESC, m.id
             LIMIT ? OFFSET ?`,
          )
          .all(
            ftsQuery,
            this.workspace.id,
            timestamp,
            ...filters,
            input.topic ?? "",
            queryText,
            fetchLimit,
            input.offset,
          ),
      );
    } else if (input.topic) {
      generalRows.push(
        ...this.db
          .prepare(
            `SELECT m.*, 0.5 AS score FROM memory_fragments m
             WHERE m.workspace_id = ? AND m.state = 'active' AND lower(m.topic) = lower(?) AND m.is_anchor = 0${typeClause}
               AND (m.expires_at IS NULL OR m.expires_at > ?)
             ORDER BY m.is_anchor DESC, m.importance DESC, m.updated_at DESC, m.id LIMIT ? OFFSET ?`,
          )
          .all(this.workspace.id, input.topic, ...(input.types ?? []), timestamp, fetchLimit, input.offset),
      );
    }

    let anchors: MemoryFragmentRecord[] = [];
    if (input.includeAnchors) {
      anchors = this.db
        .prepare(
          `SELECT m.*, 1.0 AS score FROM memory_fragments m
           WHERE m.workspace_id = ? AND m.state = 'active' AND m.is_anchor = 1
             AND (m.expires_at IS NULL OR m.expires_at > ?)${typeClause}${topicClause}
           ORDER BY m.importance DESC, m.updated_at DESC, m.id`,
        )
        .all(this.workspace.id, timestamp, ...filters)
        .map(mapMemory);
    }

    const hasMore = generalRows.length > input.limit;
    return {
      anchors,
      fragments: generalRows.slice(0, input.limit).map(mapMemory),
      truncated: hasMore,
      nextOffset: hasMore ? input.offset + input.limit : null,
    };
  }

  recordMemoryAccess(memoryIds: string[], query: string | null, timestamp: string): void {
    const ids = unique(memoryIds);
    if (ids.length === 0) return;
    this.transaction(() => {
      const update = this.db.prepare(
        `UPDATE memory_fragments
         SET access_count = access_count + 1, last_accessed_at = ?
         WHERE workspace_id = ? AND id = ? AND state = 'active'`,
      );
      for (const id of ids) {
        const result = update.run(timestamp, this.workspace.id, id);
        if (Number(result.changes) !== 1) {
          throw new ContextMeshError("NOT_FOUND", `Active memory was not found while recording access: ${id}`);
        }
      }
      this.db
        .prepare(
          `INSERT INTO memory_events(workspace_id, event_type, payload_json, created_at)
           VALUES (?, 'recalled', ?, ?)`,
        )
        .run(this.workspace.id, JSON.stringify({ query, fragmentIds: ids }), timestamp);
    });
  }

  getMemoriesLinkedToNodes(nodeIds: string[], limit = 20): MemoryFragmentRecord[] {
    const ids = unique(nodeIds);
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT DISTINCT m.* FROM memory_code_links l
         JOIN memory_fragments m ON m.id = l.memory_id
         WHERE l.workspace_id = ? AND l.code_node_id IN (${placeholders(ids.length)})
           AND m.state = 'active' AND (m.expires_at IS NULL OR m.expires_at > ?)
         ORDER BY m.is_anchor DESC, m.importance DESC, m.updated_at DESC LIMIT ?`,
      )
      .all(this.workspace.id, ...ids, this.nowIso(), limit);
    return rows.map(mapMemory);
  }

  getMemoryCodeProvenance(memoryIds: string[]): Map<string, MemoryCodeProvenance[]> {
    const ids = unique(memoryIds);
    const result = new Map<string, MemoryCodeProvenance[]>();
    if (ids.length === 0) return result;
    const rows = this.db
      .prepare(
        `SELECT memory_id, code_node_id, node_local_key, relation_type, confidence, locator_snapshot_json
         FROM memory_code_links
         WHERE workspace_id = ? AND memory_id IN (${placeholders(ids.length)})
         ORDER BY memory_id, relation_type, node_local_key`,
      )
      .all(this.workspace.id, ...ids);
    for (const row of rows) {
      const memoryId = stringValue(row.memory_id);
      const links = result.get(memoryId) ?? [];
      links.push({
        memoryId,
        codeNodeId: nullableString(row.code_node_id),
        nodeLocalKey: stringValue(row.node_local_key),
        relationType: stringValue(row.relation_type),
        confidence: numberValue(row.confidence),
        locatorSnapshot: parseJson<Record<string, unknown>>(row.locator_snapshot_json, {}),
      });
      result.set(memoryId, links);
    }
    return result;
  }

  getRelatedMemories(memoryIds: string[], limit = 20): MemoryFragmentRecord[] {
    const ids = unique(memoryIds);
    if (ids.length === 0) return [];
    const idList = placeholders(ids.length);
    const rows = this.db
      .prepare(
        `SELECT DISTINCT m.* FROM memory_links l
         JOIN memory_fragments m
           ON m.id = CASE WHEN l.from_id IN (${idList}) THEN l.to_id ELSE l.from_id END
         WHERE l.workspace_id = ?
           AND (l.from_id IN (${idList}) OR l.to_id IN (${idList}))
           AND m.id NOT IN (${idList})
           AND m.state = 'active' AND (m.expires_at IS NULL OR m.expires_at > ?)
         ORDER BY m.is_anchor DESC, m.importance DESC, m.updated_at DESC, m.id LIMIT ?`,
      )
      .all(
        ...ids,
        this.workspace.id,
        ...ids,
        ...ids,
        ...ids,
        this.nowIso(),
        limit,
      );
    return rows.map(mapMemory);
  }

  reflect(input: ReflectInput): ReflectResult {
    const timestamp = this.nowIso();
    return this.transaction(() => {
      this.ensureSession(input.sessionId, input.clientName ?? null, timestamp);
      const episodeInput: RememberInput = {
        content: input.summary,
        topic: `session:${input.sessionId}`,
        type: "episode",
        keywords: ["session", "reflection"],
        importance: 3,
        anchor: false,
        assertionStatus: "observed",
        sourceSymbolIds: [],
        sessionId: input.sessionId,
      };
      const episodeResult = this.insertMemory(episodeInput, timestamp, []);
      const learnings: MemoryFragmentRecord[] = [];
      const semanticInputs: Array<{ entityId: string; sourceHash: string }> = episodeResult.duplicate
        ? []
        : [{ entityId: episodeResult.fragment.id, sourceHash: episodeResult.semanticSourceHash }];
      let duplicates = episodeResult.duplicate ? 1 : 0;
      const link = this.db.prepare(
        `INSERT OR IGNORE INTO memory_links(
          workspace_id, from_id, to_id, relation_type, weight, created_at
        ) VALUES (?, ?, ?, 'part_of', 1.0, ?)`,
      );
      const linkEvent = this.db.prepare(
        `INSERT INTO memory_events(workspace_id, fragment_id, session_id, event_type, payload_json, created_at)
         VALUES (?, ?, ?, 'linked', ?, ?)`,
      );
      for (const learning of input.learnings) {
        const result = this.insertMemory({ ...learning, sessionId: input.sessionId }, timestamp, []);
        learnings.push(result.fragment);
        if (result.duplicate) duplicates += 1;
        else semanticInputs.push({ entityId: result.fragment.id, sourceHash: result.semanticSourceHash });
        if (result.fragment.id !== episodeResult.fragment.id) {
          const linked = link.run(this.workspace.id, result.fragment.id, episodeResult.fragment.id, timestamp);
          if (Number(linked.changes) > 0) {
            linkEvent.run(
              this.workspace.id,
              result.fragment.id,
              input.sessionId,
              JSON.stringify({ memoryId: episodeResult.fragment.id, relationType: "part_of" }),
              timestamp,
            );
          }
        }
      }
      this.db
        .prepare("UPDATE sessions SET ended_at = ?, summary_fragment_id = ? WHERE id = ?")
        .run(timestamp, episodeResult.fragment.id, input.sessionId);
      this.db
        .prepare(
          `INSERT INTO memory_events(workspace_id, fragment_id, session_id, event_type, payload_json, created_at)
           VALUES (?, ?, ?, 'reflected', ?, ?)`,
        )
        .run(
          this.workspace.id,
          episodeResult.fragment.id,
          input.sessionId,
          JSON.stringify({ learningIds: learnings.map((learning) => learning.id) }),
          timestamp,
        );
      const semanticCommit = semanticInputs.length > 0 ? this.currentMemorySemanticCommit() : null;
      if (semanticCommit) this.refreshMemorySemanticState(semanticCommit, timestamp);
      const state = semanticCommit ? this.getSemanticState("memory") : null;
      return {
        episode: episodeResult.fragment,
        learnings,
        duplicates,
        ...(state?.modelKey
          ? {
              semanticCaptures: semanticInputs.map((entry) => ({
                ...entry,
                modelKey: state.modelKey!,
                semanticRevision: state.semanticRevision,
              })),
            }
          : {}),
      };
    });
  }

  forget(input: ForgetInput): MemoryFragmentRecord {
    const timestamp = this.nowIso();
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM memory_fragments WHERE workspace_id = ? AND id = ? AND state = 'active'")
        .get(this.workspace.id, input.fragmentId);
      if (!row) throw new ContextMeshError("NOT_FOUND", `Active memory not found: ${input.fragmentId}`);
      this.db
        .prepare(
          `UPDATE memory_fragments
           SET state = 'forgotten', updated_at = ?, forgotten_at = ? WHERE id = ?`,
        )
        .run(timestamp, timestamp, input.fragmentId);
      this.db.prepare("DELETE FROM memory_fragments_fts WHERE fragment_id = ?").run(input.fragmentId);
      this.db
        .prepare("DELETE FROM semantic_embeddings WHERE workspace_key = ? AND plane = 'memory' AND entity_key = ?")
        .run(this.semanticWorkspaceKey(), this.semanticEntityKey("memory", input.fragmentId));
      this.db
        .prepare(
          `INSERT INTO memory_events(workspace_id, fragment_id, session_id, event_type, payload_json, created_at)
           VALUES (?, ?, ?, 'forgotten', ?, ?)`,
        )
        .run(
          this.workspace.id,
          input.fragmentId,
          nullableString(row.session_id),
          JSON.stringify({ reason: input.reason }),
          timestamp,
        );
      const semanticCommit = this.currentMemorySemanticCommit();
      if (semanticCommit) this.refreshMemorySemanticState(semanticCommit, timestamp);
      return mapMemory({ ...row, state: "forgotten", updated_at: timestamp });
    });
  }

  doctor(): DoctorResult {
    const interruptedRunsRecovered = this.recoverInterruptedRuns();
    const integrityRow = this.db.prepare("PRAGMA integrity_check").get();
    const sqliteRow = this.db.prepare("SELECT sqlite_version() AS version").get();
    const schemaVersions = this.db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => numberValue(row.version));
    const codeCount = this.db.prepare("SELECT count(*) AS count FROM code_nodes_fts").get();
    const memoryCount = this.db.prepare("SELECT count(*) AS count FROM memory_fragments_fts").get();
    const codeNodeCount = this.db
      .prepare("SELECT count(*) AS count FROM code_nodes WHERE workspace_id = ?")
      .get(this.workspace.id);
    const activeMemoryCount = this.db
      .prepare("SELECT count(*) AS count FROM memory_fragments WHERE workspace_id = ? AND state = 'active'")
      .get(this.workspace.id);
    const foreignKeyViolations = this.db.prepare("PRAGMA foreign_key_check").all().length;
    const codeNodeRows = numberValue(codeNodeCount?.count);
    const codeFtsRows = numberValue(codeCount?.count);
    const activeMemoryRows = numberValue(activeMemoryCount?.count);
    const memoryFtsRows = numberValue(memoryCount?.count);
    return {
      integrity: stringValue(integrityRow?.integrity_check),
      sqliteVersion: stringValue(sqliteRow?.version),
      schemaVersions,
      interruptedRunsRecovered,
      foreignKeyViolations,
      codeNodeRows,
      codeFtsRows,
      activeMemoryRows,
      memoryFtsRows,
      ftsConsistent: codeNodeRows === codeFtsRows && activeMemoryRows === memoryFtsRows,
    };
  }
}
