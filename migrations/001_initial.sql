CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  root_path_key TEXT NOT NULL UNIQUE,
  current_generation INTEGER NOT NULL DEFAULT 0 CHECK (current_generation >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS index_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation > 0),
  mode TEXT NOT NULL CHECK (mode IN ('full', 'incremental')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  scanned_files INTEGER NOT NULL DEFAULT 0,
  changed_files INTEGER NOT NULL DEFAULT 0,
  deleted_files INTEGER NOT NULL DEFAULT 0,
  failed_files INTEGER NOT NULL DEFAULT 0,
  diagnostics_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(diagnostics_json)),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (workspace_id, generation)
) STRICT;

CREATE TABLE IF NOT EXISTS source_files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('typescript', 'tsx', 'javascript', 'jsx', 'mjs', 'cjs')),
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  mtime_ms REAL NOT NULL,
  parse_status TEXT NOT NULL CHECK (parse_status IN ('ok', 'partial', 'error')),
  diagnostic_count INTEGER NOT NULL DEFAULT 0 CHECK (diagnostic_count >= 0),
  last_generation INTEGER NOT NULL CHECK (last_generation > 0),
  indexed_at TEXT NOT NULL,
  UNIQUE (workspace_id, path_key)
) STRICT;

CREATE TABLE IF NOT EXISTS code_nodes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id TEXT REFERENCES source_files(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('module', 'external_module', 'function', 'class', 'method', 'interface', 'type_alias', 'enum', 'variable')),
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  local_key TEXT NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  doc TEXT NOT NULL DEFAULT '',
  is_exported INTEGER NOT NULL DEFAULT 0 CHECK (is_exported IN (0, 1)),
  start_byte INTEGER NOT NULL DEFAULT 0 CHECK (start_byte >= 0),
  end_byte INTEGER NOT NULL DEFAULT 0 CHECK (end_byte >= start_byte),
  start_line INTEGER NOT NULL DEFAULT 1 CHECK (start_line >= 1),
  start_column INTEGER NOT NULL DEFAULT 1 CHECK (start_column >= 1),
  end_line INTEGER NOT NULL DEFAULT 1 CHECK (end_line >= 1),
  end_column INTEGER NOT NULL DEFAULT 1 CHECK (end_column >= 1),
  content_hash TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  UNIQUE (workspace_id, local_key)
) STRICT;

CREATE TABLE IF NOT EXISTS code_edges (
  id INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('CONTAINS', 'IMPORTS', 'EXPORTS', 'CALLS', 'EXTENDS', 'IMPLEMENTS', 'REFERENCES')),
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  resolution_kind TEXT NOT NULL CHECK (resolution_kind IN ('exact', 'local', 'import', 'heuristic')),
  generation INTEGER NOT NULL CHECK (generation > 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  UNIQUE (workspace_id, source_id, target_id, kind)
) STRICT;

CREATE TABLE IF NOT EXISTS unresolved_refs (
  id INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  source_node_id TEXT REFERENCES code_nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  raw_name TEXT NOT NULL,
  qualifier TEXT,
  line INTEGER NOT NULL CHECK (line >= 1),
  column INTEGER NOT NULL CHECK (column >= 1),
  candidates_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidates_json)),
  generation INTEGER NOT NULL CHECK (generation > 0)
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_name TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary_fragment_id TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS memory_fragments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('fact', 'decision', 'error', 'preference', 'procedure', 'relation', 'episode')),
  topic TEXT NOT NULL,
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  keywords_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(keywords_json)),
  importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  is_anchor INTEGER NOT NULL DEFAULT 0 CHECK (is_anchor IN (0, 1)),
  assertion_status TEXT NOT NULL DEFAULT 'observed' CHECK (assertion_status IN ('observed', 'inferred', 'verified', 'rejected')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'superseded', 'forgotten', 'expired')),
  content_hash TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  supersedes_id TEXT REFERENCES memory_fragments(id) ON DELETE SET NULL,
  access_count INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_accessed_at TEXT,
  expires_at TEXT,
  forgotten_at TEXT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_active_hash
  ON memory_fragments(workspace_id, content_hash) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS memory_links (
  id INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_id TEXT NOT NULL REFERENCES memory_fragments(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES memory_fragments(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('related', 'caused_by', 'resolved_by', 'part_of', 'contradicts', 'preceded_by')),
  weight REAL NOT NULL DEFAULT 1.0 CHECK (weight >= 0.0 AND weight <= 1.0),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, from_id, to_id, relation_type)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_code_links (
  id INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memory_fragments(id) ON DELETE CASCADE,
  code_node_id TEXT REFERENCES code_nodes(id) ON DELETE SET NULL,
  node_local_key TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('about', 'decision_for', 'error_in', 'procedure_for', 'evidence')),
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  locator_snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(locator_snapshot_json)),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, memory_id, node_local_key, relation_type)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_events (
  id INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fragment_id TEXT REFERENCES memory_fragments(id) ON DELETE SET NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('remembered', 'recalled', 'reflected', 'superseded', 'forgotten', 'expired', 'linked')),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_files_workspace_hash ON source_files(workspace_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_nodes_workspace_kind_name ON code_nodes(workspace_id, kind, name);
CREATE INDEX IF NOT EXISTS idx_nodes_file ON code_nodes(file_id);
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON code_edges(workspace_id, source_id, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON code_edges(workspace_id, target_id, kind);
CREATE INDEX IF NOT EXISTS idx_unresolved_source ON unresolved_refs(workspace_id, source_node_id);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_fragments(workspace_id, state, type, topic);
CREATE INDEX IF NOT EXISTS idx_memory_anchor ON memory_fragments(workspace_id, is_anchor) WHERE is_anchor = 1;
CREATE INDEX IF NOT EXISTS idx_memory_expiry ON memory_fragments(workspace_id, expires_at) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_memory_links_from ON memory_links(workspace_id, from_id);
CREATE INDEX IF NOT EXISTS idx_memory_links_to ON memory_links(workspace_id, to_id);
CREATE INDEX IF NOT EXISTS idx_memory_code_node ON memory_code_links(workspace_id, code_node_id);
CREATE INDEX IF NOT EXISTS idx_memory_events_created ON memory_events(workspace_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS code_nodes_fts USING fts5(
  node_id UNINDEXED,
  name,
  qualified_name,
  signature,
  doc,
  search_tokens,
  tokenize = 'unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fragments_fts USING fts5(
  fragment_id UNINDEXED,
  topic,
  content,
  keywords,
  tokenize = 'unicode61'
);
