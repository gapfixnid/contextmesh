CREATE TABLE precision_nodes (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
  analysis_level TEXT NOT NULL CHECK (analysis_level IN ('resolved','typed')),
  signature TEXT NOT NULL,
  doc TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  base_generation INTEGER NOT NULL CHECK (base_generation > 0),
  precision_revision INTEGER NOT NULL CHECK (precision_revision > 0),
  PRIMARY KEY (workspace_id, provider, node_id)
) STRICT;

CREATE INDEX idx_precision_nodes_effective
  ON precision_nodes(workspace_id, node_id, base_generation, precision_revision);
CREATE INDEX idx_precision_nodes_provider_revision
  ON precision_nodes(workspace_id, provider, precision_revision);
