import { readFileSync, readdirSync, rmSync, mkdtempSync } from "node:fs";
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
