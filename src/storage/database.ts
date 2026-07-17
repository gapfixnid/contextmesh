import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AssertionStatus,
  CodeEdgeKind,
  CodeEdgeRecord,
  CodeNodeKind,
  CodeNodeRecord,
  ExtractedGraph,
  ForgetInput,
  IndexMode,
  MemoryFragmentRecord,
  MemoryType,
  RecallInput,
  ReflectInput,
  RememberInput,
  UnresolvedReferenceRecord,
  WorkspaceRecord,
} from "../contracts.js";
import { AsyncMutex } from "../concurrency.js";
import { ContextMeshError } from "../errors.js";
import {
  buildFtsQuery,
  detectPathCaseSensitivity,
  normalizePathKey,
  nowIso,
  sha256,
  tokenizeIdentifier,
  unique,
} from "../utils.js";

type SqlRow = Record<string, SQLOutputValue>;

export interface IndexRunHandle {
  id: string;
  generation: number;
  mode: IndexMode;
}

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
}

export interface FreshnessState {
  currentGeneration: number;
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
}

export interface TraceResult {
  start: CodeSearchResult;
  nodes: CodeSearchResult[];
  edges: TraceEdgeResult[];
  unresolved: Array<{ sourceNodeId: string | null; kind: string; rawName: string; line: number; column: number }>;
  truncated: boolean;
}

export interface RememberResult {
  fragment: MemoryFragmentRecord;
  duplicate: boolean;
  warnings: string[];
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

export interface MemoryCodeProvenance {
  memoryId: string;
  codeNodeId: string | null;
  nodeLocalKey: string;
  relationType: string;
  confidence: number;
  locatorSnapshot: Record<string, unknown>;
}

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../../migrations", import.meta.url));

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
  getFileHashes(): Map<string, string>;
  getIndexedFileBaseline(): IndexedFileBaseline[];
  getIndexConfigHash(): string | null;
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
  startIndexRun(mode: IndexMode): IndexRunHandle;
  failIndexRun(handle: IndexRunHandle, diagnostics: string[]): void;
  completeNoOpRun(
    handle: IndexRunHandle,
    stats: IndexCommitStats,
    diagnostics: string[],
    indexConfigHash: string,
  ): void;
  commitGraph(
    handle: IndexRunHandle,
    graph: ExtractedGraph,
    stats: IndexCommitStats,
    indexConfigHash: string,
  ): void;
  getStatus(): Record<string, unknown>;
  searchCode(query: string, kinds: CodeNodeKind[] | undefined, limit: number, offset?: number): CodeSearchResult[];
  getCodeNode(id: string): CodeSearchResult | null;
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
  reflect(input: ReflectInput): { episode: MemoryFragmentRecord; learnings: MemoryFragmentRecord[]; duplicates: number };
  forget(input: ForgetInput): MemoryFragmentRecord;
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

  constructor(rootPath: string, databasePath?: string) {
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
    if (this.dbPath !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.applyMigrations();
    this.recoverInterruptedRuns();
    this.workspace = this.ensureWorkspace();
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
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
      this.db.exec("PRAGMA wal_checkpoint(FULL)");
      const timestamp = nowIso().replace(/[:.]/g, "-");
      copyFileSync(this.dbPath, `${this.dbPath}.backup-${timestamp}`);
    }
    for (const name of pendingMigrations) {
      const version = Number.parseInt(name.split("_", 1)[0] ?? "", 10);
      const sql = readFileSync(path.join(MIGRATIONS_DIRECTORY, name), "utf8");
      this.transaction(() => {
        this.db.exec(sql);
        this.db
          .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(version, name, nowIso());
      });
    }
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
          .run(path.basename(this.rootPath), this.rootPath, rootPathKey, nowIso(), stringValue(existing.id));
        row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(stringValue(existing.id));
      } else {
        const id = `ws_${randomUUID()}`;
        const timestamp = nowIso();
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
    const result = this.db
      .prepare(
        `UPDATE index_runs
         SET status = 'failed', completed_at = ?, diagnostics_json = ?
         WHERE status = 'running'`,
      )
      .run(nowIso(), JSON.stringify(["Indexing process exited before the run completed"]));
    return Number(result.changes);
  }

  getWorkspace(): WorkspaceRecord {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(this.workspace.id);
    if (!row) throw new ContextMeshError("INTERNAL_ERROR", "Workspace record is missing");
    return mapWorkspace(row);
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
        `SELECT path_key, relative_path, content_hash, size_bytes, mtime_ms
         FROM source_files WHERE workspace_id = ? ORDER BY path_key`,
      )
      .all(this.workspace.id)
      .map((row) => ({
        pathKey: stringValue(row.path_key),
        relativePath: stringValue(row.relative_path),
        contentHash: stringValue(row.content_hash),
        sizeBytes: numberValue(row.size_bytes),
        mtimeMs: numberValue(row.mtime_ms),
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
        `SELECT current_generation, freshness_stale, freshness_stale_at,
                freshness_reasons_json, last_strict_check_at
         FROM workspaces WHERE id = ?`,
      )
      .get(this.workspace.id);
    if (!workspace) throw new ContextMeshError("INTERNAL_ERROR", "Workspace record is missing");
    const fences = this.db
      .prepare(
        `SELECT
           coalesce(max(CASE WHEN status IN ('succeeded', 'partial') THEN generation END), 0) AS success_generation,
           coalesce(max(CASE WHEN status IN ('failed', 'running') THEN generation END), 0) AS failure_generation
         FROM index_runs WHERE workspace_id = ?`,
      )
      .get(this.workspace.id);
    const currentGeneration = numberValue(workspace.current_generation);
    const successFenceGeneration = numberValue(fences?.success_generation);
    const failureFenceGeneration = numberValue(fences?.failure_generation);
    const freshnessStale = numberValue(workspace.freshness_stale) === 1;
    return {
      currentGeneration,
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
      const timestamp = nowIso();
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

  startIndexRun(mode: IndexMode): IndexRunHandle {
    const latestRun = this.db
      .prepare("SELECT max(generation) AS generation FROM index_runs WHERE workspace_id = ?")
      .get(this.workspace.id);
    const nextGeneration = numberValue(latestRun?.generation) + 1;
    const handle: IndexRunHandle = {
      id: `idx_${randomUUID()}`,
      generation: nextGeneration,
      mode,
    };
    this.db
      .prepare(
        `INSERT INTO index_runs(id, workspace_id, generation, mode, status, started_at)
         VALUES (?, ?, ?, ?, 'running', ?)`,
      )
      .run(handle.id, this.workspace.id, handle.generation, handle.mode, nowIso());
    return handle;
  }

  failIndexRun(handle: IndexRunHandle, diagnostics: string[]): void {
    this.db
      .prepare(
        `UPDATE index_runs SET status = 'failed', failed_files = 1,
         diagnostics_json = ?, completed_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(diagnostics), nowIso(), handle.id);
  }

  completeNoOpRun(
    handle: IndexRunHandle,
    stats: IndexCommitStats,
    diagnostics: string[],
    indexConfigHash: string,
  ): void {
    const timestamp = nowIso();
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE index_runs SET status = 'succeeded', scanned_files = ?, changed_files = ?,
           deleted_files = ?, failed_files = ?, diagnostics_json = ?, completed_at = ? WHERE id = ?`,
        )
        .run(
          stats.scannedFiles,
          stats.changedFiles,
          stats.deletedFiles,
          stats.failedFiles,
          JSON.stringify(diagnostics),
          timestamp,
          handle.id,
        );
      this.db
        .prepare(
          `UPDATE workspaces SET index_config_hash = ?, freshness_stale = 0,
           freshness_stale_at = NULL, freshness_reasons_json = '[]', updated_at = ? WHERE id = ?`,
        )
        .run(indexConfigHash, timestamp, this.workspace.id);
    });
  }

  private relinkStaleMemoryCodeLinks(timestamp: string): number {
    const staleLinks = this.db
      .prepare(
        `SELECT id, memory_id, locator_snapshot_json
         FROM memory_code_links WHERE workspace_id = ? AND code_node_id IS NULL`,
      )
      .all(this.workspace.id);
    if (staleLinks.length === 0) return 0;

    const nodeRows = this.db
      .prepare(
        `SELECT n.id, n.local_key, n.kind, n.name, n.qualified_name, n.content_hash,
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

      let candidates = contentHash ? (byHash.get(contentHash) ?? []) : [];
      let confidence = 0.95;
      let strategy = "content_hash";
      if (candidates.length !== 1) {
        candidates = suffix ? (bySuffix.get(suffix) ?? []) : [];
        confidence = 0.85;
        strategy = "qualified_name_suffix";
      }
      if (candidates.length !== 1 && kind && name) {
        candidates = byKindAndName.get(`${kind}\0${name}`) ?? [];
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

  commitGraph(
    handle: IndexRunHandle,
    graph: ExtractedGraph,
    stats: IndexCommitStats,
    indexConfigHash: string,
  ): void {
    const timestamp = nowIso();
    this.transaction(() => {
      this.db.prepare("DELETE FROM code_nodes_fts").run();
      this.db.prepare("DELETE FROM unresolved_refs WHERE workspace_id = ?").run(this.workspace.id);
      this.db.prepare("DELETE FROM code_edges WHERE workspace_id = ?").run(this.workspace.id);
      this.db.prepare("DELETE FROM code_nodes WHERE workspace_id = ?").run(this.workspace.id);
      this.db.prepare("DELETE FROM source_files WHERE workspace_id = ?").run(this.workspace.id);

      const insertFile = this.db.prepare(
        `INSERT INTO source_files(
          id, workspace_id, relative_path, path_key, language, content_hash,
          size_bytes, mtime_ms, parse_status, diagnostic_count, last_generation, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const file of graph.files) {
        insertFile.run(
          file.id,
          file.workspaceId,
          file.relativePath,
          file.pathKey,
          file.language,
          file.contentHash,
          file.sizeBytes,
          file.mtimeMs,
          file.parseStatus,
          file.diagnosticCount,
          handle.generation,
          timestamp,
        );
      }

      const insertNode = this.db.prepare(
        `INSERT INTO code_nodes(
          id, workspace_id, file_id, kind, name, qualified_name, local_key, signature, doc,
          is_exported, start_byte, end_byte, start_line, start_column, end_line, end_column,
          content_hash, generation, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertNodeFts = this.db.prepare(
        `INSERT INTO code_nodes_fts(node_id, name, qualified_name, signature, doc, search_tokens)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const node of graph.nodes) {
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
          workspace_id, source_id, target_id, kind, confidence, resolution_kind, generation, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
        );
      }

      const insertUnresolved = this.db.prepare(
        `INSERT INTO unresolved_refs(
          workspace_id, file_id, source_node_id, kind, raw_name, qualifier,
          line, column, candidates_json, generation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        );
      }

      this.db
        .prepare(
          `UPDATE memory_code_links
           SET code_node_id = (
             SELECT id FROM code_nodes
             WHERE code_nodes.workspace_id = memory_code_links.workspace_id
               AND code_nodes.local_key = memory_code_links.node_local_key
             LIMIT 1
           )
           WHERE workspace_id = ?`,
        )
        .run(this.workspace.id);
      this.relinkStaleMemoryCodeLinks(timestamp);

      this.db
        .prepare(
          `UPDATE workspaces SET current_generation = ?, index_config_hash = ?, freshness_stale = 0,
           freshness_stale_at = NULL, freshness_reasons_json = '[]', updated_at = ? WHERE id = ?`,
        )
        .run(handle.generation, indexConfigHash, timestamp, this.workspace.id);
      this.db
        .prepare(
          `UPDATE index_runs SET status = ?, scanned_files = ?, changed_files = ?, deleted_files = ?,
           failed_files = ?, diagnostics_json = ?, completed_at = ? WHERE id = ?`,
        )
        .run(
          stats.failedFiles > 0 ? "partial" : "succeeded",
          stats.scannedFiles,
          stats.changedFiles,
          stats.deletedFiles,
          stats.failedFiles,
          JSON.stringify(graph.diagnostics),
          timestamp,
          handle.id,
        );
    });
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
            startedAt: stringValue(lastRun.started_at),
            completedAt: nullableString(lastRun.completed_at),
          }
        : null,
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
      return rows.map(mapCodeNode);
    }
    const rows = this.db
      .prepare(
        `SELECT n.*, f.relative_path, f.content_hash AS file_content_hash, 0.5 AS score
         FROM code_nodes n LEFT JOIN source_files f ON f.id = n.file_id
         WHERE n.workspace_id = ? AND (n.name LIKE ? OR n.qualified_name LIKE ?)${kindClause}
         ORDER BY n.qualified_name, n.id LIMIT ? OFFSET ?`,
      )
      .all(this.workspace.id, `%${query}%`, `%${query}%`, ...kindParams, limit, offset);
    return rows.map(mapCodeNode);
  }

  getCodeNode(id: string): CodeSearchResult | null {
    const row = this.db
      .prepare(
        `SELECT n.*, f.relative_path, f.content_hash AS file_content_hash, 1.0 AS score
         FROM code_nodes n LEFT JOIN source_files f ON f.id = n.file_id
         WHERE n.workspace_id = ? AND n.id = ?`,
      )
      .get(this.workspace.id, id);
    return row ? mapCodeNode(row) : null;
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
    const kindClause = edgeKinds?.length ? ` AND kind IN (${placeholders(edgeKinds.length)})` : "";

    while (queue.length > 0 && edges.length < limit) {
      const current = queue.shift();
      if (!current || current.depth >= maxDepth) continue;
      let relationClause: string;
      if (direction === "out") relationClause = "source_id = ?";
      else if (direction === "in") relationClause = "target_id = ?";
      else relationClause = "(source_id = ? OR target_id = ?)";
      const directionParams = direction === "both" ? [current.id, current.id] : [current.id];
      const rows = this.db
        .prepare(
          `SELECT source_id, target_id, kind, confidence, resolution_kind
           FROM code_edges WHERE workspace_id = ? AND ${relationClause}${kindClause}
           ORDER BY kind, source_id, target_id`,
        )
        .all(this.workspace.id, ...directionParams, ...(edgeKinds ?? []));
      for (const row of rows) {
        if (edges.length >= limit) break;
        const sourceId = stringValue(row.source_id);
        const targetId = stringValue(row.target_id);
        const nextId = sourceId === current.id ? targetId : sourceId;
        edges.push({
          sourceId,
          targetId,
          kind: stringValue(row.kind) as CodeEdgeKind,
          confidence: numberValue(row.confidence),
          resolutionKind: stringValue(row.resolution_kind),
          depth: current.depth + 1,
        });
        if (!visited.has(nextId)) {
          visited.add(nextId);
          const node = this.getCodeNode(nextId);
          if (node) nodes.set(nextId, node);
          queue.push({ id: nextId, depth: current.depth + 1 });
        }
      }
    }

    const visitedIds = [...visited];
    const unresolvedRows = visitedIds.length
      ? this.db
          .prepare(
            `SELECT source_node_id, kind, raw_name, line, column FROM unresolved_refs
             WHERE workspace_id = ? AND source_node_id IN (${placeholders(visitedIds.length)})
             ORDER BY line, column LIMIT 100`,
          )
          .all(this.workspace.id, ...visitedIds)
      : [];
    return {
      start,
      nodes: [...nodes.values()],
      edges,
      unresolved: unresolvedRows.map((row) => ({
        sourceNodeId: nullableString(row.source_node_id),
        kind: stringValue(row.kind),
        rawName: stringValue(row.raw_name),
        line: numberValue(row.line),
        column: numberValue(row.column),
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
  ): { fragment: MemoryFragmentRecord; duplicate: boolean } {
    const contentHash = memoryHash(input);
    const duplicate = this.existingActiveMemory(contentHash);
    if (duplicate) return { fragment: duplicate, duplicate: true };

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
    this.db
      .prepare(
        `INSERT INTO memory_fragments(
          id, workspace_id, type, topic, content, keywords_json, importance, is_anchor,
          assertion_status, content_hash, session_id, supersedes_id, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.workspace.id,
        input.type,
        input.topic,
        input.content,
        JSON.stringify(unique(input.keywords.map((keyword) => keyword.normalize("NFC")))),
        input.importance,
        input.anchor ? 1 : 0,
        input.assertionStatus,
        contentHash,
        input.sessionId ?? null,
        input.supersedesId ?? null,
        timestamp,
        timestamp,
        expiresAt,
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
    return { fragment: mapMemory(inserted), duplicate: false };
  }

  remember(input: RememberInput): RememberResult {
    this.expireMemories();
    const warnings: string[] = [];
    return this.transaction(() => {
      const result = this.insertMemory(input, nowIso(), warnings);
      return { ...result, warnings };
    });
  }

  private expireMemories(): number {
    const timestamp = nowIso();
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
        event.run(this.workspace.id, id, nullableString(row.session_id), timestamp);
      }
      return rows.length;
    });
  }

  recall(input: RecallInput): RecallResult {
    this.expireMemories();
    return this.recallSnapshot(input);
  }

  recallSnapshot(input: RecallInput): RecallResult {
    const timestamp = nowIso();
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
      .all(this.workspace.id, ...ids, nowIso(), limit);
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
        nowIso(),
        limit,
      );
    return rows.map(mapMemory);
  }

  reflect(input: ReflectInput): { episode: MemoryFragmentRecord; learnings: MemoryFragmentRecord[]; duplicates: number } {
    const timestamp = nowIso();
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
      return { episode: episodeResult.fragment, learnings, duplicates };
    });
  }

  forget(input: ForgetInput): MemoryFragmentRecord {
    const timestamp = nowIso();
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
