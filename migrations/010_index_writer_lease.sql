CREATE TABLE index_writer_leases (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL UNIQUE REFERENCES index_runs(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  lease_token TEXT NOT NULL UNIQUE,
  heartbeat_epoch INTEGER NOT NULL CHECK (heartbeat_epoch > 0),
  lease_expiry_epoch INTEGER NOT NULL CHECK (lease_expiry_epoch > heartbeat_epoch),
  acquired_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_index_writer_leases_expiry
  ON index_writer_leases(lease_expiry_epoch);
