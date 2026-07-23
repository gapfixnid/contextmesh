CREATE TABLE code_nodes_v6 (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id TEXT REFERENCES source_files(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('module','external_module','function','class','method','interface','type_alias','enum','variable','resource')),
  name TEXT NOT NULL, qualified_name TEXT NOT NULL, local_key TEXT NOT NULL, signature TEXT NOT NULL DEFAULT '', doc TEXT NOT NULL DEFAULT '',
  is_exported INTEGER NOT NULL DEFAULT 0 CHECK (is_exported IN (0,1)),
  start_byte INTEGER NOT NULL DEFAULT 0 CHECK (start_byte >= 0), end_byte INTEGER NOT NULL DEFAULT 0 CHECK (end_byte >= start_byte),
  start_line INTEGER NOT NULL DEFAULT 1 CHECK (start_line >= 1), start_column INTEGER NOT NULL DEFAULT 1 CHECK (start_column >= 1),
  end_line INTEGER NOT NULL DEFAULT 1 CHECK (end_line >= 1), end_column INTEGER NOT NULL DEFAULT 1 CHECK (end_column >= 1),
  content_hash TEXT NOT NULL, generation INTEGER NOT NULL CHECK (generation > 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)), semantic_source_hash TEXT,
  language TEXT,
  ecosystem TEXT CHECK (ecosystem IS NULL OR ecosystem IN ('npm','pypi','go','cargo','maven','nuget')),
  native_kind TEXT NOT NULL, analysis_level TEXT NOT NULL CHECK (analysis_level IN ('syntax','resolved','typed')),
  UNIQUE (workspace_id, local_key)
) STRICT;
INSERT INTO code_nodes_v6 SELECT * FROM code_nodes;

CREATE TABLE code_edges_v6 (
  id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES code_nodes_v6(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES code_nodes_v6(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'CONTAINS','IMPORTS','EXPORTS','CALLS','EXTENDS','IMPLEMENTS','REFERENCES',
    'REQUESTS','HANDLED_BY','PUBLISHES','CONSUMES','READS_FROM','WRITES_TO'
  )),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
  resolution_kind TEXT NOT NULL CHECK (resolution_kind IN ('exact','local','import','heuristic')),
  generation INTEGER NOT NULL CHECK (generation > 0), metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  status TEXT NOT NULL CHECK (status IN ('candidate','rejected','resolved')), evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  UNIQUE (workspace_id,source_id,target_id,kind)
) STRICT;
INSERT INTO code_edges_v6 SELECT * FROM code_edges;

CREATE TABLE unresolved_refs_v6 (
  id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  source_node_id TEXT REFERENCES code_nodes_v6(id) ON DELETE CASCADE, kind TEXT NOT NULL, raw_name TEXT NOT NULL, qualifier TEXT,
  line INTEGER NOT NULL CHECK (line >= 1), column INTEGER NOT NULL CHECK (column >= 1),
  candidates_json TEXT NOT NULL CHECK (json_valid(candidates_json)), generation INTEGER NOT NULL CHECK (generation > 0),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0), evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json))
) STRICT;
INSERT INTO unresolved_refs_v6 SELECT * FROM unresolved_refs;

CREATE TABLE memory_code_links_v6 (
  id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memory_fragments(id) ON DELETE CASCADE,
  code_node_id TEXT REFERENCES code_nodes_v6(id) ON DELETE SET NULL, node_local_key TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('about','decision_for','error_in','procedure_for','evidence')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
  locator_snapshot_json TEXT NOT NULL CHECK (json_valid(locator_snapshot_json)), created_at TEXT NOT NULL, language TEXT,
  UNIQUE (workspace_id,memory_id,node_local_key,relation_type)
) STRICT;
INSERT INTO memory_code_links_v6 SELECT * FROM memory_code_links;

CREATE TABLE precision_edges_v6 (
  id INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES code_nodes_v6(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES code_nodes_v6(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'CONTAINS','IMPORTS','EXPORTS','CALLS','EXTENDS','IMPLEMENTS','REFERENCES',
    'REQUESTS','HANDLED_BY','PUBLISHES','CONSUMES','READS_FROM','WRITES_TO'
  )),
  status TEXT NOT NULL CHECK (status IN ('candidate','rejected','resolved')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
  resolution_kind TEXT NOT NULL CHECK (resolution_kind IN ('exact','local','import','heuristic')),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  base_generation INTEGER NOT NULL CHECK (base_generation > 0),
  precision_revision INTEGER NOT NULL CHECK (precision_revision > 0),
  UNIQUE (workspace_id,provider,source_id,target_id,kind)
) STRICT;
INSERT INTO precision_edges_v6 SELECT * FROM precision_edges;

CREATE TABLE precision_nodes_v6 (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES code_nodes_v6(id) ON DELETE CASCADE,
  analysis_level TEXT NOT NULL CHECK (analysis_level IN ('resolved','typed')),
  signature TEXT NOT NULL,
  doc TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  base_generation INTEGER NOT NULL CHECK (base_generation > 0),
  precision_revision INTEGER NOT NULL CHECK (precision_revision > 0),
  PRIMARY KEY (workspace_id, provider, node_id)
) STRICT;
INSERT INTO precision_nodes_v6 SELECT * FROM precision_nodes;

DROP TABLE precision_nodes;
DROP TABLE precision_edges;
DROP TABLE memory_code_links;
DROP TABLE unresolved_refs;
DROP TABLE code_edges;
DROP TABLE code_nodes;

ALTER TABLE code_nodes_v6 RENAME TO code_nodes;
ALTER TABLE code_edges_v6 RENAME TO code_edges;
ALTER TABLE unresolved_refs_v6 RENAME TO unresolved_refs;
ALTER TABLE memory_code_links_v6 RENAME TO memory_code_links;
ALTER TABLE precision_edges_v6 RENAME TO precision_edges;
ALTER TABLE precision_nodes_v6 RENAME TO precision_nodes;

CREATE INDEX idx_nodes_workspace_kind_name ON code_nodes(workspace_id,kind,name);
CREATE INDEX idx_nodes_workspace_language ON code_nodes(workspace_id,language,kind,name);
CREATE INDEX idx_nodes_file ON code_nodes(file_id);
CREATE INDEX idx_edges_source_kind ON code_edges(workspace_id,source_id,kind);
CREATE INDEX idx_edges_target_kind ON code_edges(workspace_id,target_id,kind);
CREATE INDEX idx_unresolved_source ON unresolved_refs(workspace_id,source_node_id);
CREATE INDEX idx_memory_code_node ON memory_code_links(workspace_id,code_node_id);
CREATE INDEX idx_precision_edges_source ON precision_edges(workspace_id,source_id,kind,status);
CREATE INDEX idx_precision_edges_target ON precision_edges(workspace_id,target_id,kind,status);
CREATE INDEX idx_precision_provider_revision ON precision_edges(workspace_id,provider,precision_revision);
CREATE INDEX idx_precision_nodes_effective
  ON precision_nodes(workspace_id,node_id,base_generation,precision_revision);
CREATE INDEX idx_precision_nodes_provider_revision
  ON precision_nodes(workspace_id,provider,precision_revision);
