ALTER TABLE workspaces ADD COLUMN precision_revision INTEGER NOT NULL DEFAULT 0 CHECK (precision_revision >= 0);

CREATE TABLE source_files_v5 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL, path_key TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('typescript','tsx','javascript','jsx','mjs','cjs','python','go','rust','java','csharp')),
  ecosystem TEXT NOT NULL CHECK (ecosystem IN ('npm','pypi','go','cargo','maven','nuget')),
  source_root TEXT NOT NULL DEFAULT '', adapter_config_hash TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0), mtime_ms REAL NOT NULL,
  parse_status TEXT NOT NULL CHECK (parse_status IN ('ok','partial','error')),
  diagnostic_count INTEGER NOT NULL DEFAULT 0 CHECK (diagnostic_count >= 0),
  last_generation INTEGER NOT NULL CHECK (last_generation > 0), indexed_at TEXT NOT NULL,
  UNIQUE (workspace_id, path_key)
) STRICT;
INSERT INTO source_files_v5 SELECT * FROM source_files;

CREATE TABLE code_nodes_v5 (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id TEXT REFERENCES source_files_v5(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('module','external_module','function','class','method','interface','type_alias','enum','variable')),
  name TEXT NOT NULL, qualified_name TEXT NOT NULL, local_key TEXT NOT NULL, signature TEXT NOT NULL DEFAULT '', doc TEXT NOT NULL DEFAULT '',
  is_exported INTEGER NOT NULL DEFAULT 0 CHECK (is_exported IN (0,1)),
  start_byte INTEGER NOT NULL DEFAULT 0 CHECK (start_byte >= 0), end_byte INTEGER NOT NULL DEFAULT 0 CHECK (end_byte >= start_byte),
  start_line INTEGER NOT NULL DEFAULT 1 CHECK (start_line >= 1), start_column INTEGER NOT NULL DEFAULT 1 CHECK (start_column >= 1),
  end_line INTEGER NOT NULL DEFAULT 1 CHECK (end_line >= 1), end_column INTEGER NOT NULL DEFAULT 1 CHECK (end_column >= 1),
  content_hash TEXT NOT NULL, generation INTEGER NOT NULL CHECK (generation > 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)), semantic_source_hash TEXT,
  language TEXT NOT NULL, ecosystem TEXT NOT NULL CHECK (ecosystem IN ('npm','pypi','go','cargo','maven','nuget')),
  native_kind TEXT NOT NULL, analysis_level TEXT NOT NULL CHECK (analysis_level IN ('syntax','resolved','typed')),
  UNIQUE (workspace_id, local_key)
) STRICT;
INSERT INTO code_nodes_v5 SELECT * FROM code_nodes;

CREATE TABLE code_edges_v5 (
  id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES code_nodes_v5(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES code_nodes_v5(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('CONTAINS','IMPORTS','EXPORTS','CALLS','EXTENDS','IMPLEMENTS','REFERENCES')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
  resolution_kind TEXT NOT NULL CHECK (resolution_kind IN ('exact','local','import','heuristic')),
  generation INTEGER NOT NULL CHECK (generation > 0), metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  status TEXT NOT NULL CHECK (status IN ('candidate','rejected','resolved')), evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  UNIQUE (workspace_id,source_id,target_id,kind)
) STRICT;
INSERT INTO code_edges_v5 SELECT * FROM code_edges;

CREATE TABLE unresolved_refs_v5 (
  id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES source_files_v5(id) ON DELETE CASCADE,
  source_node_id TEXT REFERENCES code_nodes_v5(id) ON DELETE CASCADE, kind TEXT NOT NULL, raw_name TEXT NOT NULL, qualifier TEXT,
  line INTEGER NOT NULL CHECK (line >= 1), column INTEGER NOT NULL CHECK (column >= 1),
  candidates_json TEXT NOT NULL CHECK (json_valid(candidates_json)), generation INTEGER NOT NULL CHECK (generation > 0),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0), evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json))
) STRICT;
INSERT INTO unresolved_refs_v5 SELECT * FROM unresolved_refs;

CREATE TABLE memory_code_links_v5 (
  id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memory_fragments(id) ON DELETE CASCADE,
  code_node_id TEXT REFERENCES code_nodes_v5(id) ON DELETE SET NULL, node_local_key TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('about','decision_for','error_in','procedure_for','evidence')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
  locator_snapshot_json TEXT NOT NULL CHECK (json_valid(locator_snapshot_json)), created_at TEXT NOT NULL, language TEXT,
  UNIQUE (workspace_id,memory_id,node_local_key,relation_type)
) STRICT;
INSERT INTO memory_code_links_v5 SELECT * FROM memory_code_links;

DROP TABLE memory_code_links;
DROP TABLE unresolved_refs;
DROP TABLE code_edges;
DROP TABLE code_nodes;
DROP TABLE source_files;
ALTER TABLE source_files_v5 RENAME TO source_files;
ALTER TABLE code_nodes_v5 RENAME TO code_nodes;
ALTER TABLE code_edges_v5 RENAME TO code_edges;
ALTER TABLE unresolved_refs_v5 RENAME TO unresolved_refs;
ALTER TABLE memory_code_links_v5 RENAME TO memory_code_links;

CREATE INDEX idx_files_workspace_hash ON source_files(workspace_id,content_hash);
CREATE INDEX idx_files_workspace_language ON source_files(workspace_id,language,path_key);
CREATE INDEX idx_nodes_workspace_kind_name ON code_nodes(workspace_id,kind,name);
CREATE INDEX idx_nodes_workspace_language ON code_nodes(workspace_id,language,kind,name);
CREATE INDEX idx_nodes_file ON code_nodes(file_id);
CREATE INDEX idx_edges_source_kind ON code_edges(workspace_id,source_id,kind);
CREATE INDEX idx_edges_target_kind ON code_edges(workspace_id,target_id,kind);
CREATE INDEX idx_unresolved_source ON unresolved_refs(workspace_id,source_node_id);
CREATE INDEX idx_memory_code_node ON memory_code_links(workspace_id,code_node_id);

CREATE TABLE precision_provider_state (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  language TEXT NOT NULL, provider TEXT NOT NULL, provider_version TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN ('resolved','typed')),
  status TEXT NOT NULL CHECK (status IN ('not_configured','running','ready','stale','failed','partial')),
  base_generation INTEGER NOT NULL DEFAULT 0 CHECK (base_generation >= 0),
  precision_revision INTEGER NOT NULL DEFAULT 0 CHECK (precision_revision >= 0),
  eligible_edges INTEGER NOT NULL DEFAULT 0 CHECK (eligible_edges >= 0),
  resolved_edges INTEGER NOT NULL DEFAULT 0 CHECK (resolved_edges >= 0),
  rejected_edges INTEGER NOT NULL DEFAULT 0 CHECK (rejected_edges >= 0),
  last_error TEXT, lease_owner TEXT, lease_token TEXT, lease_expires_epoch INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, provider)
) STRICT;

CREATE TABLE precision_edges (
  id INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('CONTAINS','IMPORTS','EXPORTS','CALLS','EXTENDS','IMPLEMENTS','REFERENCES')),
  status TEXT NOT NULL CHECK (status IN ('candidate','rejected','resolved')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
  resolution_kind TEXT NOT NULL CHECK (resolution_kind IN ('exact','local','import','heuristic')),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  base_generation INTEGER NOT NULL CHECK (base_generation > 0),
  precision_revision INTEGER NOT NULL CHECK (precision_revision > 0),
  UNIQUE (workspace_id,provider,source_id,target_id,kind)
) STRICT;
CREATE INDEX idx_precision_edges_source ON precision_edges(workspace_id,source_id,kind,status);
CREATE INDEX idx_precision_edges_target ON precision_edges(workspace_id,target_id,kind,status);
CREATE INDEX idx_precision_provider_revision ON precision_edges(workspace_id,provider,precision_revision);
