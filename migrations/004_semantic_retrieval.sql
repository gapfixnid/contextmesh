ALTER TABLE code_nodes ADD COLUMN semantic_source_hash TEXT;
ALTER TABLE memory_fragments ADD COLUMN semantic_source_hash TEXT;

CREATE TABLE semantic_models (
  model_id INTEGER PRIMARY KEY,
  model_key TEXT NOT NULL UNIQUE,
  manifest_digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  vector_codec TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE semantic_workspaces (
  workspace_key INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE workspace_semantic_state (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plane TEXT NOT NULL CHECK (plane IN ('code', 'memory')),
  model_key TEXT REFERENCES semantic_models(model_key),
  graph_generation INTEGER,
  semantic_revision INTEGER NOT NULL DEFAULT 0 CHECK (semantic_revision >= 0),
  status TEXT NOT NULL DEFAULT 'needs_backfill'
    CHECK (status IN ('ready', 'partial', 'needs_backfill', 'unavailable')),
  eligible_entity_count INTEGER NOT NULL DEFAULT 0 CHECK (eligible_entity_count >= 0),
  valid_embedding_count INTEGER NOT NULL DEFAULT 0 CHECK (valid_embedding_count >= 0),
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, plane),
  CHECK (
    (plane = 'code' AND graph_generation IS NOT NULL) OR
    (plane = 'memory' AND graph_generation IS NULL)
  )
) STRICT;

CREATE TABLE semantic_embeddings (
  embedding_id INTEGER PRIMARY KEY,
  workspace_key INTEGER NOT NULL REFERENCES semantic_workspaces(workspace_key) ON DELETE CASCADE,
  plane TEXT NOT NULL CHECK (plane IN ('code', 'memory')),
  entity_key BLOB NOT NULL,
  source_hash BLOB NOT NULL CHECK (length(source_hash) = 32),
  model_id INTEGER NOT NULL REFERENCES semantic_models(model_id),
  generation INTEGER,
  vector BLOB NOT NULL,
  CHECK (
    (plane = 'code' AND generation IS NOT NULL AND generation > 0) OR
    (plane = 'memory' AND generation IS NULL)
  ),
  CHECK (
    (plane = 'code' AND length(entity_key) = 32) OR
    (plane = 'memory' AND length(entity_key) > 0)
  )
) STRICT;
