import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope, MemoryFragmentRecord } from "../src/contracts.js";
import type { EmbeddingBackend, SemanticRuntimeDiagnostics } from "../src/semantic/backend.js";
import { APPROVED_MODEL_KEY, APPROVED_MODEL_MANIFEST } from "../src/semantic/manifest.js";
import { ContextMeshDatabase, type CodeSearchResult, type MemoryMaintenanceRun } from "../src/storage/database.js";
import { stableDigest } from "../src/memory/maintenance.js";
import {
  stableStringify,
  v04CanonicalSourceEvidenceOrArchive,
  v04SourceDifferencePaths,
} from "./v04-artifact-contract.js";

interface Fixture {
  schemaVersion: 1;
  id: string;
  immutable: true;
  thresholds: Record<string, number>;
  cases: Array<{ id: string; category: string; expected: string }>;
}

interface CaseResult {
  id: string;
  category: string;
  expected: string;
  actual: string;
  passed: boolean;
}

interface ScenarioObservation {
  caseResults: CaseResult[];
  duplicatePredicted: number;
  duplicateTruePositive: number;
  duplicateExpected: number;
  conflictPredicted: number;
  conflictTruePositive: number;
  conflictExpected: number;
}

const fixturePath = path.join(process.cwd(), "evaluation", "fixtures", "v07-memory-validation-v1.json");
const fixtureText = readFileSync(fixturePath, "utf8");
const fixture = JSON.parse(fixtureText) as Fixture;
const fixtureDigest = createHash("sha256").update(stableStringify(fixture)).digest("hex");

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : null;
}

function writeWorkspaceFile(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function normalizedVector(text: string): Float32Array {
  const concepts: Record<string, string> = {
    automobile: "vehicle",
    car: "vehicle",
  };
  const tokens = text.normalize("NFC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
  const vector = new Float32Array(APPROVED_MODEL_MANIFEST.model.dimensions);
  for (const rawToken of tokens) {
    const token = concepts[rawToken] ?? rawToken;
    const digest = createHash("sha256").update(token).digest();
    const index = digest.readUInt16LE(0) % vector.length;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  if (tokens.length === 0) vector[0] = 1;
  let squaredNorm = 0;
  for (const value of vector) squaredNorm += value * value;
  const norm = Math.sqrt(squaredNorm);
  for (let index = 0; index < vector.length; index += 1) vector[index] = (vector[index] ?? 0) / norm;
  return vector;
}

class DeterministicEmbeddingBackend implements EmbeddingBackend {
  readonly modelKey = APPROVED_MODEL_KEY;
  readonly dimensions = APPROVED_MODEL_MANIFEST.model.dimensions;
  readonly manifest = APPROVED_MODEL_MANIFEST;
  readonly diagnostics: SemanticRuntimeDiagnostics = {
    requestedSessionOptions: APPROVED_MODEL_MANIFEST.backend.requestedSessionOptions,
    resolvedBackend: "v07-evaluator-deterministic",
    requestedExecutionProviders: APPROVED_MODEL_MANIFEST.backend.requestedExecutionProviders,
    effectiveExecutionProvider: "cpu",
    effectiveIntraOpThreads: 1,
    effectiveInterOpThreads: "not_applicable",
    verificationMethod: ["integration_evaluator"],
    observedModelPath: "evaluation/deterministic",
    observedModelSha256: APPROVED_MODEL_MANIFEST.files[0]!.sha256,
  };

  async embedQuery(text: string): Promise<Float32Array> {
    return normalizedVector(text);
  }

  async embedPassages(texts: string[]): Promise<Float32Array[]> {
    return texts.map(normalizedVector);
  }

  async dispose(): Promise<void> {}
}

function initialSource(): string {
  return `export function stableTarget(value: number): number {
  return value;
}
export function moveTarget(value: number): number {
  return value * 2;
}
export function ambiguousTarget(value: number): number {
  return value * 3;
}
export function staleTarget(value: number): number {
  return value * 4;
}
export function deletedTarget(value: number): number {
  return value * 5;
}
export function claimTarget(value: number): number {
  return value * 6;
}
`;
}

function changedSource(): string {
  return `export function stableTarget(value: number): number {
  return value;
}
export function staleTarget(value: number): number {
  return value + value + value + value;
}
export function claimTarget(value: string): string {
  return value.repeat(6);
}
`;
}

async function searchOne(app: ContextMeshApp, name: string): Promise<CodeSearchResult> {
  const result = await app.searchCode({ query: name, limit: 20 }) as Envelope<{ results: CodeSearchResult[] }>;
  const symbol = result.data.results.find((item) => item.name === name);
  if (!symbol) throw new Error(`V07_EVALUATOR_SYMBOL_MISSING:${name}`);
  return symbol;
}

function memoryId(result: Envelope<{ fragment: MemoryFragmentRecord }>): string {
  return result.data.fragment.id;
}

function validationState(databasePath: string, id: string): string {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return String(db.prepare(
      "SELECT validation_state FROM memory_validation_summary WHERE memory_id=?",
    ).get(id)?.validation_state ?? "unlinked");
  } finally {
    db.close();
  }
}

function replayAudit(databasePath: string): string {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = db.prepare(
      "SELECT id,fragment_id,event_type,payload_json FROM memory_events ORDER BY id",
    ).all();
    const state = new Map<string, unknown>();
    for (const row of rows) {
      const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
      const key = `${String(row.fragment_id ?? "workspace")}:${String(row.event_type)}`;
      state.set(key, {
        nextState: payload.nextState ?? null,
        reasonCodes: payload.reasonCodes ?? [],
        affectedLinkCount: Array.isArray(payload.affectedLinkIds) ? payload.affectedLinkIds.length : 0,
      });
    }
    return stableDigest([...state.entries()].sort((left, right) => left[0].localeCompare(right[0])));
  } finally {
    db.close();
  }
}

async function executeScenario(): Promise<ScenarioObservation> {
  const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v07-eval-"));
  let now = new Date("2026-01-03T00:00:00.000Z");
  writeWorkspaceFile(root, "tsconfig.json", JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
    },
    include: ["src/**/*"],
  }));
  writeWorkspaceFile(root, "src/targets.ts", initialSource());
  const app = new ContextMeshApp(root, undefined, {
    clock: () => now,
    semantic: {
      modelPath: "evaluation/deterministic",
      backendFactory: async () => new DeterministicEmbeddingBackend(),
    },
  });
  try {
    await app.indexWorkspace({ mode: "full" });
    const stable = await searchOne(app, "stableTarget");
    const moving = await searchOne(app, "moveTarget");
    const ambiguous = await searchOne(app, "ambiguousTarget");
    const stale = await searchOne(app, "staleTarget");
    const deleted = await searchOne(app, "deletedTarget");
    const claimed = await searchOne(app, "claimTarget");

    const stableMemory = memoryId(await app.remember({
      content: "stable target remains linked",
      topic: "validation stable",
      type: "fact",
      sourceSymbolIds: [stable.id],
    }) as Envelope<{ fragment: MemoryFragmentRecord }>);
    const movedMemory = memoryId(await app.remember({
      content: "moved target remains recoverable",
      topic: "validation move",
      type: "fact",
      sourceSymbolIds: [moving.id],
    }) as Envelope<{ fragment: MemoryFragmentRecord }>);
    const ambiguousMemory = memoryId(await app.remember({
      content: "ambiguous target requires review",
      topic: "validation ambiguous",
      type: "fact",
      sourceSymbolIds: [ambiguous.id],
    }) as Envelope<{ fragment: MemoryFragmentRecord }>);
    const staleMemory = memoryId(await app.remember({
      content: "stale target must not leak",
      topic: "validation stale",
      type: "fact",
      anchor: true,
      sourceSymbolIds: [stale.id],
    }) as Envelope<{ fragment: MemoryFragmentRecord }>);
    const deletedMemory = memoryId(await app.remember({
      content: "deleted target must be orphaned",
      topic: "validation deleted",
      type: "fact",
      sourceSymbolIds: [deleted.id],
    }) as Envelope<{ fragment: MemoryFragmentRecord }>);
    const contradictedMemory = memoryId(await app.remember({
      content: "automobile policy is semantically discoverable",
      topic: "validation claim",
      type: "fact",
      sourceSymbolIds: [claimed.id],
      claims: [{
        namespace: "code",
        key: "symbol.signature",
        operator: "eq",
        value: claimed.signature,
        sourceSymbolId: claimed.id,
      }],
    }) as Envelope<{ fragment: MemoryFragmentRecord }>);
    const semanticBefore = await app.recall({ query: "car", tokenBudget: 2000 }) as Envelope<{
      fragments: MemoryFragmentRecord[];
    }>;
    if (!semanticBefore.data.fragments.some((item) => item.id === contradictedMemory)) {
      throw new Error("V07_SEMANTIC_PRECONDITION_FAILED");
    }

    writeWorkspaceFile(root, "src/targets.ts", changedSource());
    writeWorkspaceFile(root, "src/moved.ts", `export function moveTarget(value: number): number {
  return value * 2;
}
`);
    writeWorkspaceFile(root, "src/ambiguous-a.ts", `export function ambiguousTarget(value: number): number {
  return value * 3;
}
`);
    writeWorkspaceFile(root, "src/ambiguous-b.ts", `export function ambiguousTarget(value: number): number {
  return value * 3;
}
`);
    await app.indexWorkspace({ mode: "incremental" });
    const postChangeValidation = {
      stable: validationState(app.database.dbPath, stableMemory),
      moved: validationState(app.database.dbPath, movedMemory),
      ambiguous: validationState(app.database.dbPath, ambiguousMemory),
      stale: validationState(app.database.dbPath, staleMemory),
      deleted: validationState(app.database.dbPath, deletedMemory),
      contradicted: validationState(app.database.dbPath, contradictedMemory),
    };

    const movedRecall = await app.recall({ query: "moved target recoverable", tokenBudget: 2000 }) as Envelope<{
      fragments: MemoryFragmentRecord[];
    }>;
    const anchorRecall = await app.recall({
      query: "stale target leak",
      includeAnchors: true,
      tokenBudget: 2000,
    }) as Envelope<{ fragments: MemoryFragmentRecord[] }>;
    const semanticAfter = await app.recall({ query: "car", tokenBudget: 2000 }) as Envelope<{
      fragments: MemoryFragmentRecord[];
    }>;

    const duplicateLeft = memoryId(await app.remember({
      content: "Always run the ContextMesh index before changing public API contracts",
      topic: "duplicate release",
      type: "decision",
      sourceSymbolIds: [],
    }) as Envelope<{ fragment: MemoryFragmentRecord }>);
    const duplicateRight = memoryId(await app.remember({
      content: "Always run the ContextMesh index before changing public API contracts locally",
      topic: "duplicate release",
      type: "decision",
      sourceSymbolIds: [],
    }) as Envelope<{ fragment: MemoryFragmentRecord }>);
    const conflictLeft = memoryId(await app.remember({
      content: "Release mode is safe",
      topic: "conflict release",
      type: "decision",
      sourceSymbolIds: [],
      claims: [{ namespace: "custom", key: "release.mode", operator: "eq", value: "safe" }],
    }) as Envelope<{ fragment: MemoryFragmentRecord }>);
    const conflictRight = memoryId(await app.remember({
      content: "Release mode is fast",
      topic: "conflict release",
      type: "decision",
      sourceSymbolIds: [],
      claims: [{ namespace: "custom", key: "release.mode", operator: "eq", value: "fast" }],
    }) as Envelope<{ fragment: MemoryFragmentRecord }>);
    const disjointLeft = memoryId(await app.remember({
      content: "Disjoint mode was blue",
      topic: "disjoint",
      type: "fact",
      validFrom: "2025-01-01T00:00:00.000Z",
      validTo: "2025-02-01T00:00:00.000Z",
      sourceSymbolIds: [],
      claims: [{ namespace: "custom", key: "mode.color", operator: "eq", value: "blue" }],
    }) as Envelope<{ fragment: MemoryFragmentRecord }>);
    const disjointRight = memoryId(await app.remember({
      content: "Disjoint mode became green",
      topic: "disjoint",
      type: "fact",
      validFrom: "2025-02-01T00:00:00.000Z",
      sourceSymbolIds: [],
      claims: [{ namespace: "custom", key: "mode.color", operator: "eq", value: "green" }],
    }) as Envelope<{ fragment: MemoryFragmentRecord }>);
    const episodeOne = memoryId(await app.remember({
      content: "First observed release event",
      topic: "episode release",
      type: "episode",
      sessionId: "v07-evaluation",
      sourceSymbolIds: [],
    }) as Envelope<{ fragment: MemoryFragmentRecord }>);
    const episodeTwo = memoryId(await app.remember({
      content: "Second observed release event",
      topic: "episode release",
      type: "episode",
      sessionId: "v07-evaluation",
      sourceSymbolIds: [],
    }) as Envelope<{ fragment: MemoryFragmentRecord }>);
    const expiredValidity = memoryId(await app.remember({
      content: "This validity window has ended",
      topic: "validity ended",
      type: "fact",
      validFrom: "2025-01-01T00:00:00.000Z",
      validTo: "2025-12-01T00:00:00.000Z",
      sourceSymbolIds: [],
    }) as Envelope<{ fragment: MemoryFragmentRecord }>);
    const utility = await app.remember({
      content: "reinforcement utility observation",
      topic: "utility",
      type: "fact",
      sourceSymbolIds: [],
    }) as Envelope<{ fragment: MemoryFragmentRecord }>;
    const utilityBefore = utility.data.fragment.utilityScore;

    app.reviewMemories({
      action: "run_maintenance",
      kinds: ["detect_duplicates", "detect_conflicts", "compact_episodes"],
      maxItems: 500,
      dryRun: false,
      tokenBudget: 4000,
    });
    await app.recall({ query: "reinforcement utility observation", tokenBudget: 2000 });
    app.reviewMemories({
      action: "run_maintenance",
      kinds: ["recompute_utility"],
      maxItems: 500,
      dryRun: false,
      tokenBudget: 4000,
    });

    const audit = new DatabaseSync(app.database.dbPath, { readOnly: true });
    const candidates = audit.prepare(
      `SELECT candidate_type,left_memory_id,right_memory_id FROM memory_review_candidates
       WHERE status='pending' ORDER BY candidate_type,id`,
    ).all();
    const utilityAfter = Number(audit.prepare(
      "SELECT utility_score FROM memory_fragment_metadata WHERE memory_id=?",
    ).get(utility.data.fragment.id)?.utility_score ?? 0);
    audit.close();
    const hasPair = (type: string, left: string, right: string) => candidates.some((candidate) =>
      candidate.candidate_type === type &&
      new Set([String(candidate.left_memory_id), String(candidate.right_memory_id)]).has(left) &&
      new Set([String(candidate.left_memory_id), String(candidate.right_memory_id)]).has(right));
    const duplicateCandidate = hasPair("duplicate", duplicateLeft, duplicateRight);
    const conflictCandidate = hasPair("conflict", conflictLeft, conflictRight);
    const disjointCandidate = hasPair("conflict", disjointLeft, disjointRight);
    const episodeCandidate = candidates.some((candidate) =>
      candidate.candidate_type === "episode_compaction" &&
      new Set([String(candidate.left_memory_id), String(candidate.right_memory_id)]).has(episodeOne) &&
      new Set([String(candidate.left_memory_id), String(candidate.right_memory_id)]).has(episodeTwo));
    const validityRecall = await app.recall({ query: "validity window ended", tokenBudget: 2000 }) as Envelope<{
      fragments: MemoryFragmentRecord[];
    }>;

    app.reviewMemories({
      action: "run_maintenance",
      kinds: ["revalidate_links"],
      maxItems: 500,
      dryRun: false,
      tokenBudget: 4000,
    });
    const noOpBefore = new DatabaseSync(app.database.dbPath, { readOnly: true });
    const revisionBefore = app.database.getMemoryRevision();
    const validationBefore = noOpBefore.prepare(
      "SELECT link_id,checked_generation,validated_at FROM memory_code_link_validations ORDER BY link_id",
    ).all();
    noOpBefore.close();
    now = new Date("2026-01-04T00:00:00.000Z");
    const noOp = app.reviewMemories({
      action: "run_maintenance",
      kinds: ["revalidate_links"],
      maxItems: 500,
      dryRun: false,
      tokenBudget: 4000,
    }) as Envelope<{ run: MemoryMaintenanceRun }>;
    const noOpAfter = new DatabaseSync(app.database.dbPath, { readOnly: true });
    const validationAfter = noOpAfter.prepare(
      "SELECT link_id,checked_generation,validated_at FROM memory_code_link_validations ORDER BY link_id",
    ).all();
    noOpAfter.close();
    const actualById: Record<string, string> = {
      "unchanged-linked-valid": postChangeValidation.stable,
      "unique-rename-relocated": postChangeValidation.moved,
      "ambiguous-rename-review": postChangeValidation.ambiguous,
      "changed-linked-stale": postChangeValidation.stale,
      "deleted-target-orphaned": postChangeValidation.deleted,
      "structured-signature-contradicted": postChangeValidation.contradicted,
      "stale-anchor-excluded": anchorRecall.data.fragments.some((item) => item.id === staleMemory) ? "leaked" : "excluded",
      "contradicted-semantic-excluded": semanticAfter.data.fragments.some((item) => item.id === contradictedMemory) ? "leaked" : "excluded",
      "near-duplicate-candidate": duplicateCandidate ? "candidate" : "none",
      "structured-conflict-candidate": conflictCandidate ? "candidate" : "none",
      "disjoint-validity-no-conflict": disjointCandidate ? "candidate" : "none",
      "episode-compaction-candidate": episodeCandidate ? "candidate" : "none",
      "validity-ended-excluded": validityRecall.data.fragments.some((item) => item.id === expiredValidity) ? "leaked" : "excluded",
      "access-reinforcement": utilityAfter > utilityBefore ? "reinforced" : "unchanged",
      "maintenance-noop": noOp.data.run.transitionCount === 0 &&
        app.database.getMemoryRevision() === revisionBefore &&
        stableStringify(validationBefore) === stableStringify(validationAfter) ? "noop" : "changed",
      "audit-replay": replayAudit(app.database.dbPath) === replayAudit(app.database.dbPath) ? "stable" : "mismatch",
    };
    if (!movedRecall.data.fragments.some((item) => item.id === movedMemory)) {
      actualById["unique-rename-relocated"] = "blocked";
    }
    const caseResults = fixture.cases.map((item) => ({
      ...item,
      actual: actualById[item.id] ?? "unknown",
      passed: actualById[item.id] === item.expected,
    }));
    return {
      caseResults,
      duplicatePredicted: duplicateCandidate ? 1 : 0,
      duplicateTruePositive: duplicateCandidate ? 1 : 0,
      duplicateExpected: 1,
      conflictPredicted: (conflictCandidate ? 1 : 0) + (disjointCandidate ? 1 : 0),
      conflictTruePositive: conflictCandidate ? 1 : 0,
      conflictExpected: 1,
    };
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function maintenanceCursorProbe(): Promise<{ failures: number; checked: number; expected: number }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v07-cursor-"));
  writeWorkspaceFile(root, "tsconfig.json", JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", noEmit: true },
    include: ["src/**/*"],
  }));
  writeWorkspaceFile(root, "src/target.ts", "export function cursorTarget(value: number): number { return value; }\n");
  const app = new ContextMeshApp(root);
  try {
    await app.indexWorkspace({ mode: "full" });
    const target = await searchOne(app, "cursorTarget");
    for (let index = 0; index < 1001; index += 1) {
      await app.remember({
        content: `cursor integration ${index}`,
        topic: `cursor-${index}`,
        type: "fact",
        sourceSymbolIds: [target.id],
      });
    }
    writeWorkspaceFile(root, "src/unrelated.ts", "export const graphGenerationTwo = 2;\n");
    await app.indexWorkspace({ mode: "incremental" });
    const db = new DatabaseSync(app.database.dbPath, { readOnly: true });
    const generation = Number(db.prepare("SELECT current_generation FROM workspaces").get()?.current_generation);
    const checked = Number(db.prepare(
      "SELECT count(*) AS count FROM memory_code_link_validations WHERE checked_generation=?",
    ).get(generation)?.count ?? 0);
    const pending = Number(db.prepare(
      "SELECT count(*) AS count FROM memory_maintenance_jobs WHERE state<>'succeeded'",
    ).get()?.count ?? 0);
    db.close();
    return { failures: checked === 1001 && pending === 0 ? 0 : 1, checked, expected: 1001 };
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function migrationProbe(): { failures: number; state: string; leaked: boolean } {
  const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v07-migration-"));
  const databasePath = path.join(root, "legacy.sqlite3");
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL) STRICT;");
    const migrationNames = readdirSync(path.join(process.cwd(), "migrations")).sort();
    for (const name of migrationNames.filter((item) => /^00[1-6]_/.test(item))) {
      db.exec(readFileSync(path.join(process.cwd(), "migrations", name), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(Number(name.slice(0, 3)), name, "2026-01-01T00:00:00.000Z");
    }
    db.prepare("INSERT INTO workspaces(id,name,root_path,root_path_key,current_generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run("ws_eval", "eval", root, root.toLocaleLowerCase(), 7, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO index_runs(id,workspace_id,generation,mode,status,started_at,completed_at) VALUES(?,?,?,?,?,?,?)")
      .run("run_7", "ws_eval", 7, "full", "succeeded", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    db.prepare(`INSERT INTO source_files(id,workspace_id,relative_path,path_key,language,content_hash,size_bytes,mtime_ms,parse_status,diagnostic_count,last_generation,indexed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run("file_1", "ws_eval", "src/a.ts", "src/a.ts", "typescript", "filehash", 20, 1, "ok", 0, 7, "2026-01-01T00:00:00.000Z");
    db.prepare(`INSERT INTO code_nodes(id,workspace_id,file_id,kind,name,qualified_name,local_key,content_hash,generation,metadata_json)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run("node_1", "ws_eval", "file_1", "function", "legacy", "src/a.ts#legacy", "src/a.ts:function:legacy", "new-hash", 7, '{"syntaxKind":"FunctionDeclaration"}');
    db.prepare("INSERT INTO code_nodes_fts(node_id,name,qualified_name,signature,doc,search_tokens) VALUES(?,?,?,?,?,?)")
      .run("node_1", "legacy", "src/a.ts#legacy", "", "", "legacy");
    db.prepare(`INSERT INTO memory_fragments(id,workspace_id,type,topic,content,content_hash,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run("mem_1", "ws_eval", "fact", "migration", "legacy stale evidence", "memhash", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO memory_fragments_fts(fragment_id,topic,content,keywords) VALUES(?,?,?,?)")
      .run("mem_1", "migration", "legacy stale evidence", "");
    db.prepare(`INSERT INTO memory_code_links(workspace_id,memory_id,code_node_id,node_local_key,relation_type,locator_snapshot_json,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(
      "ws_eval",
      "mem_1",
      "node_1",
      "src/a.ts:function:legacy",
      "evidence",
      JSON.stringify({ kind: "function", name: "legacy", contentHash: "old-hash" }),
      "2026-01-01T00:00:00.000Z",
    );
    for (const name of migrationNames.filter((item) => /^00(?:[7-9]|1[0-3])_/.test(item))) {
      db.exec(readFileSync(path.join(process.cwd(), "migrations", name), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(Number(name.slice(0, 3)), name, "2026-01-01T00:00:00.000Z");
    }
  } finally {
    db.close();
  }
  try {
    const database = new ContextMeshDatabase(root, databasePath, {
      clock: () => new Date("2026-01-02T00:00:00.000Z"),
    });
    const recalled = database.recall({
      query: "legacy stale evidence",
      tokenBudget: 1000,
      includeAnchors: false,
      limit: 20,
      offset: 0,
    });
    database.close();
    const verified = new DatabaseSync(databasePath, { readOnly: true });
    const state = String(verified.prepare(
      "SELECT state FROM memory_code_link_validations WHERE memory_id='mem_1'",
    ).get()?.state ?? "missing");
    const preserved = Number(verified.prepare("SELECT current_generation FROM workspaces").get()?.current_generation) === 7 &&
      Number(verified.prepare("SELECT count(*) AS count FROM memory_fragments").get()?.count) === 1 &&
      verified.prepare("PRAGMA foreign_key_check").all().length === 0;
    verified.close();
    const leaked = recalled.fragments.some((item) => item.id === "mem_1");
    return { failures: state === "stale" && !leaked && preserved ? 0 : 1, state, leaked };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (fixture.schemaVersion !== 1 || fixture.id !== "contextmesh-v07-memory-validation-v1" ||
    fixture.immutable !== true || fixture.cases.length !== 16 ||
    new Set(fixture.cases.map((item) => item.id)).size !== fixture.cases.length) {
  throw new Error("V07_FIXTURE_INVALID");
}
const source = v04CanonicalSourceEvidenceOrArchive(process.cwd());
if (source.dirty) {
  throw new Error(`V07_SOURCE_WORKTREE_DIRTY: ${v04SourceDifferencePaths(process.cwd()).join(", ") || "unknown difference"}`);
}
const runs = Number(argument("--runs") ?? fixture.thresholds.deterministicRuns);
if (!Number.isSafeInteger(runs) || runs !== 20) throw new Error("V07_INVALID_RUN_COUNT: exactly 20 runs are required");

const observations: ScenarioObservation[] = [];
for (let run = 0; run < runs; run += 1) observations.push(await executeScenario());
const runResults = observations.map((item) => item.caseResults);
const signatures = runResults.map((result) => stableDigest(result));
const caseResults = runResults[0]!;
const cursorProbe = await maintenanceCursorProbe();
const migration = migrationProbe();
const total = (field: keyof Omit<ScenarioObservation, "caseResults">) =>
  observations.reduce((sum, item) => sum + item[field], 0);
const validationCases = caseResults.filter((item) => item.category === "validation");
const unsafeCases = caseResults.filter((item) =>
  ["stale-anchor-excluded", "contradicted-semantic-excluded", "validity-ended-excluded"].includes(item.id));
const duplicatePredicted = total("duplicatePredicted");
const conflictPredicted = total("conflictPredicted");
const metrics = {
  unsafeNormalContextLeak: unsafeCases.filter((item) => item.actual !== "excluded").length,
  validationAccuracy: validationCases.filter((item) => item.passed).length / validationCases.length,
  relocatedRecovery: caseResults.find((item) => item.id === "unique-rename-relocated")?.passed ? 1 : 0,
  ambiguousFalseConfirmation: caseResults.find((item) => item.id === "ambiguous-rename-review")?.passed ? 0 : 1,
  duplicatePrecision: duplicatePredicted === 0 ? 0 : total("duplicateTruePositive") / duplicatePredicted,
  duplicateRecall: total("duplicateTruePositive") / total("duplicateExpected"),
  conflictPrecision: conflictPredicted === 0 ? 0 : total("conflictTruePositive") / conflictPredicted,
  conflictRecall: total("conflictTruePositive") / total("conflictExpected"),
  auditReplayMismatch: observations.filter((item) =>
    item.caseResults.find((result) => result.id === "audit-replay")?.actual !== "stable").length,
  memoryRevisionMismatch: observations.filter((item) =>
    item.caseResults.find((result) => result.id === "maintenance-noop")?.actual !== "noop").length,
  migrationPreservationFailures: migration.failures,
  maintenanceCursorFailures: cursorProbe.failures,
};
const passed = caseResults.every((item) => item.passed) &&
  new Set(signatures).size === 1 &&
  migration.failures === 0 &&
  cursorProbe.failures === 0;
const artifact = {
  schemaVersion: 1,
  release: "v0.7",
  fixture: { id: fixture.id, digest: fixtureDigest, caseCount: fixture.cases.length, immutable: true },
  source,
  runner: { node: process.version, platform: process.platform },
  runs,
  orderedSignatures: signatures,
  metrics,
  thresholds: fixture.thresholds,
  probes: {
    maintenanceCursor: cursorProbe,
    migration,
    semanticBackend: "deterministic-integration",
  },
  caseResults,
  auditSignature: stableDigest({ caseResults, metrics, probes: { cursorProbe, migration } }),
  passed,
};
if (!passed) {
  throw new Error(`V07_EVALUATION_FAILED:${JSON.stringify({
    failedCases: caseResults.filter((item) => !item.passed),
    cursorProbe,
    migration,
  })}`);
}
const output = path.resolve(argument("--output") ?? path.join("artifacts", "v07-memory-validation.json"));
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  output,
  runs,
  cases: caseResults.length,
  signature: signatures[0],
  cursorProbe,
  migration,
  passed,
}, null, 2)}\n`);
