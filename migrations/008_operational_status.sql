CREATE TABLE operational_status (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  component TEXT NOT NULL CHECK (component IN ('graph_kernel','watcher')),
  status TEXT NOT NULL CHECK (status IN ('ready','failed')),
  diagnostic TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, component)
) STRICT;
