import { copyFileSync, readFileSync, readdirSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { ContextMeshDatabase } from "../src/storage/database.js";

const roots: string[] = [];

function legacyDatabase(): { root: string; databasePath: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-migration-"));
  roots.push(root);
  const databasePath = path.join(root, "legacy.sqlite3");
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL) STRICT;");
  const migrations = readdirSync(path.join(process.cwd(), "migrations")).filter((name) => /^00[1-6]_/.test(name)).sort();
  for (const name of migrations) {
    db.exec(readFileSync(path.join(process.cwd(), "migrations", name), "utf8"));
    db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(Number(name.slice(0, 3)), name, "2026-01-01T00:00:00.000Z");
  }
  db.prepare("INSERT INTO workspaces(id,name,root_path,root_path_key,current_generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run("ws_legacy", "legacy", root, root.toLocaleLowerCase(), 7, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.prepare("INSERT INTO index_runs(id,workspace_id,generation,mode,status,started_at,completed_at) VALUES(?,?,?,?,?,?,?)")
    .run("run_7", "ws_legacy", 7, "full", "succeeded", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.prepare(`INSERT INTO source_files(id,workspace_id,relative_path,path_key,language,content_hash,size_bytes,mtime_ms,parse_status,diagnostic_count,last_generation,indexed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run("file_1", "ws_legacy", "src/a.ts", "src/a.ts", "typescript", "filehash", 20, 1, "ok", 0, 7, "2026-01-01T00:00:00.000Z");
  db.prepare(`INSERT INTO code_nodes(id,workspace_id,file_id,kind,name,qualified_name,local_key,content_hash,generation,metadata_json)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run("node_1", "ws_legacy", "file_1", "function", "legacy", "src/a.ts#legacy", "src/a.ts:function:legacy", "nodehash", 7, '{"syntaxKind":"FunctionDeclaration"}');
  db.prepare("INSERT INTO code_nodes_fts(node_id,name,qualified_name,signature,doc,search_tokens) VALUES(?,?,?,?,?,?)")
    .run("node_1", "legacy", "src/a.ts#legacy", "", "", "legacy");
  db.prepare(`INSERT INTO memory_fragments(id,workspace_id,type,topic,content,content_hash,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run("mem_1", "ws_legacy", "decision", "legacy", "keep link", "memhash", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.prepare("INSERT INTO memory_fragments_fts(fragment_id,topic,content,keywords) VALUES(?,?,?,?)").run("mem_1", "legacy", "keep link", "");
  db.prepare(`INSERT INTO memory_code_links(workspace_id,memory_id,code_node_id,node_local_key,relation_type,locator_snapshot_json,created_at)
    VALUES(?,?,?,?,?,?,?)`).run("ws_legacy", "mem_1", "node_1", "src/a.ts:function:legacy", "decision_for", "{}", "2026-01-01T00:00:00.000Z");
  db.prepare("INSERT INTO memory_events(workspace_id,fragment_id,event_type,payload_json,created_at) VALUES(?,?,?,?,?)")
    .run("ws_legacy", "mem_1", "linked", "{}", "2026-01-01T00:00:00.000Z");
  db.close();
  return { root, databasePath };
}

function phase4Database(): { root: string; databasePath: string } {
  const fixture = legacyDatabase();
  const db = new DatabaseSync(fixture.databasePath);
  for (const name of readdirSync(path.join(process.cwd(), "migrations")).filter((item) => /^00[78]_/.test(item)).sort()) {
    db.exec(readFileSync(path.join(process.cwd(), "migrations", name), "utf8"));
    db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(Number(name.slice(0, 3)), name, "2026-01-01T00:00:00.000Z");
  }
  db.close();
  return fixture;
}

function precisionDatabase(): { root: string; databasePath: string } {
  const fixture = phase4Database();
  const db = new DatabaseSync(fixture.databasePath);
  const name = "009_precision_overlay.sql";
  db.exec(readFileSync(path.join(process.cwd(), "migrations", name), "utf8"));
  db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(9, name, "2026-01-01T00:00:00.000Z");
  db.close();
  return fixture;
}

function writerLeaseDatabase(): { root: string; databasePath: string } {
  const fixture = precisionDatabase();
  const db = new DatabaseSync(fixture.databasePath);
  const name = "010_index_writer_lease.sql";
  db.exec(readFileSync(path.join(process.cwd(), "migrations", name), "utf8"));
  db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(10, name, "2026-01-01T00:00:00.000Z");
  db.close();
  return fixture;
}

function precisionNodeDatabase(): { root: string; databasePath: string } {
  const fixture = writerLeaseDatabase();
  const db = new DatabaseSync(fixture.databasePath);
  const name = "011_precision_nodes.sql";
  db.exec(readFileSync(path.join(process.cwd(), "migrations", name), "utf8"));
  db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(11, name, "2026-01-01T00:00:00.000Z");
  db.close();
  return fixture;
}

function transitionEpochDatabase(): { root: string; databasePath: string } {
  const fixture = precisionNodeDatabase();
  const db = new DatabaseSync(fixture.databasePath);
  const name = "012_precision_provider_transition_epoch.sql";
  db.exec(readFileSync(path.join(process.cwd(), "migrations", name), "utf8"));
  db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(12, name, "2026-01-01T00:00:00.000Z");
  db.close();
  return fixture;
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("migration 007", () => {
  it("preserves rows, FK targets, generation, FTS, and code-memory links", () => {
    const fixture = legacyDatabase();
    const database = new ContextMeshDatabase(fixture.root, fixture.databasePath);
    database.close();
    const raw = new DatabaseSync(fixture.databasePath, { readOnly: true });
    expect(raw.prepare("SELECT current_generation AS value FROM workspaces").get()?.value).toBe(7);
    expect(raw.prepare("SELECT count(*) AS value FROM source_files").get()?.value).toBe(1);
    expect(raw.prepare("SELECT count(*) AS value FROM code_nodes_fts").get()?.value).toBe(1);
    expect(raw.prepare("SELECT count(*) AS value FROM memory_fragments_fts").get()?.value).toBe(1);
    expect(raw.prepare("SELECT code_node_id AS value FROM memory_code_links").get()?.value).toBe("node_1");
    expect(raw.prepare("SELECT count(*) AS value FROM memory_events").get()?.value).toBe(1);
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(raw.prepare("SELECT language AS value FROM code_nodes").get()?.value).toBe("typescript");
    raw.close();
  });

  it("rolls the entire migration back when validation fails", () => {
    const fixture = legacyDatabase();
    expect(() => new ContextMeshDatabase(fixture.root, fixture.databasePath, {
      migrationValidationHook: (version) => { if (version === 7) throw new Error("injected migration validation failure"); },
    })).toThrow("injected migration validation failure");
    const raw = new DatabaseSync(fixture.databasePath, { readOnly: true });
    expect(raw.prepare("SELECT count(*) AS value FROM schema_migrations WHERE version=7").get()?.value).toBe(0);
    expect(raw.prepare("SELECT count(*) AS value FROM pragma_table_info('source_files') WHERE name='ecosystem'").get()?.value).toBe(0);
    expect(raw.prepare("SELECT code_node_id AS value FROM memory_code_links").get()?.value).toBe("node_1");
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();
  });
});

describe("migration 009", () => {
  it("preserves the Phase 4 graph and memory links while adding independent precision state", () => {
    const fixture = phase4Database();
    const database = new ContextMeshDatabase(fixture.root, fixture.databasePath);
    expect(database.getPrecisionRevision()).toBe(0);
    database.close();
    const raw = new DatabaseSync(fixture.databasePath, { readOnly: true });
    expect(raw.prepare("SELECT current_generation AS value FROM workspaces").get()?.value).toBe(7);
    expect(raw.prepare("SELECT code_node_id AS value FROM memory_code_links").get()?.value).toBe("node_1");
    expect(raw.prepare("SELECT count(*) AS value FROM pragma_table_info('workspaces') WHERE name='precision_revision'").get()?.value).toBe(1);
    expect(raw.prepare("SELECT count(*) AS value FROM schema_migrations WHERE version=9").get()?.value).toBe(1);
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();
  });

  it("rolls migration 009 back atomically when validation fails", () => {
    const fixture = phase4Database();
    expect(() => new ContextMeshDatabase(fixture.root, fixture.databasePath, {
      migrationValidationHook: (version) => { if (version === 9) throw new Error("injected precision migration failure"); },
    })).toThrow("injected precision migration failure");
    const raw = new DatabaseSync(fixture.databasePath, { readOnly: true });
    expect(raw.prepare("SELECT count(*) AS value FROM schema_migrations WHERE version=9").get()?.value).toBe(0);
    expect(raw.prepare("SELECT count(*) AS value FROM pragma_table_info('workspaces') WHERE name='precision_revision'").get()?.value).toBe(0);
    expect(raw.prepare("SELECT code_node_id AS value FROM memory_code_links").get()?.value).toBe("node_1");
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();
  });
});

describe("migration backup and writer-lease migration", () => {
  it("refuses migration when a complete WAL checkpoint cannot be captured", () => {
    const fixture = precisionDatabase();
    const reader = new DatabaseSync(fixture.databasePath);
    const writer = new DatabaseSync(fixture.databasePath);
    reader.exec("PRAGMA journal_mode=WAL; BEGIN DEFERRED;");
    reader.prepare("SELECT count(*) FROM memory_events").get();
    writer.exec("PRAGMA journal_mode=WAL;");
    writer.prepare(
      "INSERT INTO memory_events(workspace_id,fragment_id,event_type,payload_json,created_at) VALUES(?,?,?,?,?)",
    ).run("ws_legacy", "mem_1", "recalled", '{"sentinel":"wal"}', "2026-01-02T00:00:00.000Z");

    let migrationError: unknown;
    try {
      const database = new ContextMeshDatabase(fixture.root, fixture.databasePath);
      database.close();
    } catch (error) {
      migrationError = error;
    } finally {
      writer.close();
      reader.exec("ROLLBACK");
      reader.close();
    }
    expect(() => {
      if (migrationError) throw migrationError;
    }).toThrow(/migration backup checkpoint incomplete/i);

    const raw = new DatabaseSync(fixture.databasePath, { readOnly: true });
    expect(raw.prepare("SELECT count(*) AS value FROM memory_events WHERE payload_json='{\"sentinel\":\"wal\"}'").get()?.value).toBe(1);
    expect(raw.prepare("SELECT count(*) AS value FROM schema_migrations WHERE version=10").get()?.value).toBe(0);
    raw.close();
    expect(readdirSync(fixture.root).filter((name) => name.includes(".backup-"))).toEqual([]);
  });

  it("rejects a corrupt migration backup before applying pending migrations", () => {
    const fixture = precisionDatabase();
    const options = {
      migrationBackupValidationHook: (backupPath: string) => writeFileSync(backupPath, "corrupt-backup", "utf8"),
    } as unknown as ConstructorParameters<typeof ContextMeshDatabase>[2];
    expect(() => new ContextMeshDatabase(fixture.root, fixture.databasePath, options))
      .toThrow(/migration backup validation failed/i);
    const raw = new DatabaseSync(fixture.databasePath, { readOnly: true });
    expect(raw.prepare("SELECT count(*) AS value FROM schema_migrations WHERE version=10").get()?.value).toBe(0);
    raw.close();
  });

  it("adds the durable index-writer lease table without changing existing state", () => {
    const fixture = precisionDatabase();
    const database = new ContextMeshDatabase(fixture.root, fixture.databasePath);
    database.close();
    const raw = new DatabaseSync(fixture.databasePath, { readOnly: true });
    expect(raw.prepare("SELECT count(*) AS value FROM schema_migrations WHERE version=10").get()?.value).toBe(1);
    expect(raw.prepare("SELECT count(*) AS value FROM sqlite_schema WHERE type='table' AND name='index_writer_leases'").get()?.value).toBe(1);
    expect(raw.prepare("SELECT current_generation AS value FROM workspaces").get()?.value).toBe(7);
    expect(raw.prepare("SELECT code_node_id AS value FROM memory_code_links").get()?.value).toBe("node_1");
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();
  });

  it("rolls migration 010 back atomically when validation fails", () => {
    const fixture = precisionDatabase();
    expect(() => new ContextMeshDatabase(fixture.root, fixture.databasePath, {
      migrationValidationHook: (version) => { if (version === 10) throw new Error("injected writer-lease migration failure"); },
    })).toThrow("injected writer-lease migration failure");
    const raw = new DatabaseSync(fixture.databasePath, { readOnly: true });
    expect(raw.prepare("SELECT count(*) AS value FROM schema_migrations WHERE version=10").get()?.value).toBe(0);
    expect(raw.prepare("SELECT count(*) AS value FROM sqlite_schema WHERE type='table' AND name='index_writer_leases'").get()?.value).toBe(0);
    expect(raw.prepare("SELECT current_generation AS value FROM workspaces").get()?.value).toBe(7);
    expect(raw.prepare("SELECT code_node_id AS value FROM memory_code_links").get()?.value).toBe("node_1");
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();
  });

  it("restores a generated backup and resumes the pending migration with data intact", () => {
    const fixture = precisionDatabase();
    expect(() => new ContextMeshDatabase(fixture.root, fixture.databasePath, {
      migrationValidationHook: (version) => { if (version === 10) throw new Error("restore-probe"); },
    })).toThrow("restore-probe");
    const backups = readdirSync(fixture.root)
      .filter((name) => name.startsWith(`${path.basename(fixture.databasePath)}.backup-`));
    expect(backups).toHaveLength(1);
    const backupPath = path.join(fixture.root, backups[0]!);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    expect(backup.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
    expect(backup.prepare("SELECT max(version) AS value FROM schema_migrations").get()?.value).toBe(9);
    expect(backup.prepare("SELECT code_node_id AS value FROM memory_code_links").get()?.value).toBe("node_1");
    backup.close();

    copyFileSync(backupPath, fixture.databasePath);
    const restored = new ContextMeshDatabase(fixture.root, fixture.databasePath);
    restored.close();
    const verified = new DatabaseSync(fixture.databasePath, { readOnly: true });
    expect(verified.prepare("SELECT max(version) AS value FROM schema_migrations").get()?.value).toBe(14);
    expect(verified.prepare("SELECT code_node_id AS value FROM memory_code_links").get()?.value).toBe("node_1");
    expect(verified.prepare("SELECT current_generation AS value FROM workspaces").get()?.value).toBe(7);
    expect(verified.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    verified.close();
  });
});

describe("migration 011", () => {
  it("adds independently fenced precision-node overlays without changing existing graph state", () => {
    const fixture = writerLeaseDatabase();
    const database = new ContextMeshDatabase(fixture.root, fixture.databasePath);
    database.close();
    const raw = new DatabaseSync(fixture.databasePath, { readOnly: true });
    expect(raw.prepare("SELECT max(version) AS value FROM schema_migrations").get()?.value).toBe(14);
    expect(raw.prepare("SELECT count(*) AS value FROM sqlite_schema WHERE type='table' AND name='precision_nodes'").get()?.value).toBe(1);
    expect(raw.prepare("SELECT current_generation AS value FROM workspaces").get()?.value).toBe(7);
    expect(raw.prepare("SELECT code_node_id AS value FROM memory_code_links").get()?.value).toBe("node_1");
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();
  });

  it("rolls migration 011 back atomically when validation fails", () => {
    const fixture = writerLeaseDatabase();
    expect(() => new ContextMeshDatabase(fixture.root, fixture.databasePath, {
      migrationValidationHook: (version) => { if (version === 11) throw new Error("injected precision-node migration failure"); },
    })).toThrow("injected precision-node migration failure");
    const raw = new DatabaseSync(fixture.databasePath, { readOnly: true });
    expect(raw.prepare("SELECT count(*) AS value FROM schema_migrations WHERE version=11").get()?.value).toBe(0);
    expect(raw.prepare("SELECT count(*) AS value FROM sqlite_schema WHERE type='table' AND name='precision_nodes'").get()?.value).toBe(0);
    expect(raw.prepare("SELECT current_generation AS value FROM workspaces").get()?.value).toBe(7);
    expect(raw.prepare("SELECT code_node_id AS value FROM memory_code_links").get()?.value).toBe("node_1");
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();
  });
});

describe("migration 012", () => {
  it("adds a monotonic precision-provider transition epoch", () => {
    const fixture = precisionNodeDatabase();
    const database = new ContextMeshDatabase(fixture.root, fixture.databasePath);
    database.close();
    const raw = new DatabaseSync(fixture.databasePath, { readOnly: true });
    expect(raw.prepare("SELECT max(version) AS value FROM schema_migrations").get()?.value).toBe(14);
    expect(raw.prepare("SELECT count(*) AS value FROM pragma_table_info('precision_provider_state') WHERE name='transition_epoch'").get()?.value).toBe(1);
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();
  });

  it("rolls migration 012 back atomically when validation fails", () => {
    const fixture = precisionNodeDatabase();
    expect(() => new ContextMeshDatabase(fixture.root, fixture.databasePath, {
      migrationValidationHook: (version) => { if (version === 12) throw new Error("injected transition-epoch migration failure"); },
    })).toThrow("injected transition-epoch migration failure");
    const raw = new DatabaseSync(fixture.databasePath, { readOnly: true });
    expect(raw.prepare("SELECT count(*) AS value FROM schema_migrations WHERE version=12").get()?.value).toBe(0);
    expect(raw.prepare("SELECT count(*) AS value FROM pragma_table_info('precision_provider_state') WHERE name='transition_epoch'").get()?.value).toBe(0);
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();
  });
});

describe("migration 013", () => {
  it("adds resource nodes and boundary edge kinds without losing graph state", () => {
    const fixture = transitionEpochDatabase();
    const database = new ContextMeshDatabase(fixture.root, fixture.databasePath);
    database.close();
    const raw = new DatabaseSync(fixture.databasePath);
    expect(raw.prepare("SELECT max(version) AS value FROM schema_migrations").get()?.value).toBe(14);
    raw.prepare(`INSERT INTO code_nodes(
      id,workspace_id,file_id,kind,name,qualified_name,local_key,content_hash,generation,
      metadata_json,language,ecosystem,native_kind,analysis_level
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "resource_1", "ws_legacy", null, "resource", "GET /users", "resource:http:GET:/users",
      "resource:http:GET:/users", "resourcehash", 7, "{}", null, null, "boundary_resource", "resolved",
    );
    raw.prepare(`INSERT INTO code_edges(
      workspace_id,source_id,target_id,kind,confidence,resolution_kind,generation,metadata_json,status,evidence_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      "ws_legacy", "node_1", "resource_1", "REQUESTS", 1, "exact", 7, "{}", "resolved", "[]",
    );
    expect(raw.prepare("SELECT kind AS value FROM code_nodes WHERE id='resource_1'").get()?.value).toBe("resource");
    expect(raw.prepare("SELECT kind AS value FROM code_edges WHERE target_id='resource_1'").get()?.value).toBe("REQUESTS");
    expect(raw.prepare("SELECT code_node_id AS value FROM memory_code_links").get()?.value).toBe("node_1");
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();
  });

  it("rolls migration 013 back atomically when validation fails", () => {
    const fixture = transitionEpochDatabase();
    expect(() => new ContextMeshDatabase(fixture.root, fixture.databasePath, {
      migrationValidationHook: (version) => {
        if (version === 13) throw new Error("injected boundary-resource migration failure");
      },
    })).toThrow("injected boundary-resource migration failure");
    const raw = new DatabaseSync(fixture.databasePath, { readOnly: true });
    expect(raw.prepare("SELECT count(*) AS value FROM schema_migrations WHERE version=13").get()?.value).toBe(0);
    const nodeSql = String(
      raw.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='code_nodes'").get()?.sql,
    );
    expect(nodeSql).not.toContain("'resource'");
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();
  }, 60_000);
});

describe("migration 014", () => {
  it("backfills temporal metadata and link validation without changing durable graph identity", () => {
    const fixture = transitionEpochDatabase();
    const before = new DatabaseSync(fixture.databasePath, { readOnly: true });
    const memoryId = before.prepare("SELECT id FROM memory_fragments LIMIT 1").get()?.id;
    const linkId = before.prepare("SELECT id FROM memory_code_links LIMIT 1").get()?.id;
    const generation = before.prepare("SELECT current_generation FROM workspaces").get()?.current_generation;
    const precision = before.prepare("SELECT precision_revision FROM workspaces").get()?.precision_revision;
    before.close();
    const database = new ContextMeshDatabase(fixture.root, fixture.databasePath);
    database.close();
    const raw = new DatabaseSync(fixture.databasePath, { readOnly: true });
    expect(raw.prepare("SELECT max(version) AS value FROM schema_migrations").get()?.value).toBe(14);
    expect(raw.prepare("SELECT memory_id FROM memory_fragment_metadata").get()?.memory_id).toBe(memoryId);
    expect(raw.prepare("SELECT link_id FROM memory_code_link_validations").get()?.link_id).toBe(linkId);
    expect(raw.prepare("SELECT state FROM memory_code_link_validations").get()?.state).toBe("needs_review");
    expect(raw.prepare("SELECT current_generation FROM workspaces").get()?.current_generation).toBe(generation);
    expect(raw.prepare("SELECT precision_revision FROM workspaces").get()?.precision_revision).toBe(precision);
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();
  });

  it("backfills a locator hash mismatch as stale and excludes it before any reindex", () => {
    const fixture = transitionEpochDatabase();
    const before = new DatabaseSync(fixture.databasePath);
    before.prepare(
      "UPDATE memory_code_links SET locator_snapshot_json=? WHERE memory_id='mem_1'",
    ).run(JSON.stringify({
      kind: "function",
      name: "legacy",
      qualifiedName: "src/a.ts#legacy",
      localKey: "src/a.ts:function:legacy",
      contentHash: "old-nodehash",
    }));
    const extraMemories: Array<[string, string]> = [
      ["mem_valid", "legacy valid evidence"],
      ["mem_missing_hash", "legacy missing hash evidence"],
      ["mem_orphan", "legacy orphan evidence"],
    ];
    for (const [id, content] of extraMemories) {
      before.prepare(`INSERT INTO memory_fragments(
        id,workspace_id,type,topic,content,content_hash,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?)`).run(
        id, "ws_legacy", "fact", "migration", content, `${id}-hash`,
        "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
      );
      before.prepare(
        "INSERT INTO memory_fragments_fts(fragment_id,topic,content,keywords) VALUES(?,?,?,?)",
      ).run(id, "migration", content, "");
    }
    before.prepare(`INSERT INTO memory_code_links(
      workspace_id,memory_id,code_node_id,node_local_key,relation_type,confidence,locator_snapshot_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      "ws_legacy", "mem_valid", "node_1", "src/a.ts:function:legacy", "evidence", 1,
      JSON.stringify({ kind: "function", name: "legacy", contentHash: "nodehash" }),
      "2026-01-01T00:00:00.000Z",
    );
    before.prepare(`INSERT INTO memory_code_links(
      workspace_id,memory_id,code_node_id,node_local_key,relation_type,confidence,locator_snapshot_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      "ws_legacy", "mem_missing_hash", "node_1", "src/a.ts:function:legacy", "evidence", 1,
      JSON.stringify({ kind: "function", name: "legacy" }),
      "2026-01-01T00:00:00.000Z",
    );
    before.prepare(`INSERT INTO memory_code_links(
      workspace_id,memory_id,code_node_id,node_local_key,relation_type,confidence,locator_snapshot_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      "ws_legacy", "mem_orphan", null, "src/a.ts:function:removed", "evidence", 1,
      JSON.stringify({ kind: "function", name: "removed", contentHash: "removed-hash" }),
      "2026-01-01T00:00:00.000Z",
    );
    before.close();

    const database = new ContextMeshDatabase(fixture.root, fixture.databasePath, {
      clock: () => new Date("2026-01-02T00:00:00.000Z"),
    });
    const recalled = database.recall({
      query: "keep link",
      tokenBudget: 1000,
      includeAnchors: false,
      limit: 20,
      offset: 0,
    });
    expect(recalled.fragments).toHaveLength(0);
    database.close();

    const raw = new DatabaseSync(fixture.databasePath, { readOnly: true });
    expect(raw.prepare(
      "SELECT state FROM memory_code_link_validations WHERE memory_id='mem_1'",
    ).get()?.state).toBe("stale");
    expect(raw.prepare(
      "SELECT reason_code FROM memory_code_link_validations WHERE memory_id='mem_1'",
    ).get()?.reason_code).toBe("CONTENT_HASH_CHANGED");
    expect(Object.fromEntries(raw.prepare(
      "SELECT memory_id,state FROM memory_code_link_validations ORDER BY memory_id",
    ).all().map((row) => [String(row.memory_id), String(row.state)]))).toMatchObject({
      mem_1: "stale",
      mem_valid: "valid",
      mem_missing_hash: "needs_review",
      mem_orphan: "orphaned",
    });
    raw.close();
  });

  it("rolls migration 014 back atomically when its validation hook fails", () => {
    const fixture = transitionEpochDatabase();
    expect(() => new ContextMeshDatabase(fixture.root, fixture.databasePath, {
      migrationValidationHook: (version) => {
        if (version === 14) throw new Error("injected memory validation migration failure");
      },
    })).toThrow("injected memory validation migration failure");
    const raw = new DatabaseSync(fixture.databasePath, { readOnly: true });
    expect(raw.prepare("SELECT count(*) AS value FROM schema_migrations WHERE version=14").get()?.value).toBe(0);
    expect(raw.prepare(
      "SELECT count(*) AS value FROM sqlite_schema WHERE type='table' AND name='memory_fragment_metadata'",
    ).get()?.value).toBe(0);
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();
  });
});
