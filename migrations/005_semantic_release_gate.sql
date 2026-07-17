ALTER TABLE workspace_semantic_state ADD COLUMN failure_class TEXT
  CHECK (failure_class IS NULL OR failure_class IN ('material_sticky', 'scale_limit', 'runtime_retryable', 'data_repairable'));
ALTER TABLE workspace_semantic_state ADD COLUMN normalized_error_code TEXT;
ALTER TABLE workspace_semantic_state ADD COLUMN failure_fingerprint TEXT;
ALTER TABLE workspace_semantic_state ADD COLUMN material_fingerprint TEXT;
ALTER TABLE workspace_semantic_state ADD COLUMN diagnostics_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workspace_semantic_state ADD COLUMN retry_generation INTEGER NOT NULL DEFAULT 0 CHECK (retry_generation >= 0);
ALTER TABLE workspace_semantic_state ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0);
ALTER TABLE workspace_semantic_state ADD COLUMN next_retry_epoch INTEGER CHECK (next_retry_epoch IS NULL OR next_retry_epoch >= 0);

CREATE TABLE semantic_reconciliation_claims (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plane TEXT NOT NULL CHECK (plane IN ('code', 'memory')),
  active_attempt_token TEXT,
  target_model_key TEXT,
  target_graph_generation INTEGER,
  target_semantic_revision INTEGER,
  owner_uuid TEXT,
  owner_pid INTEGER,
  owner_hostname TEXT,
  heartbeat_epoch INTEGER,
  lease_expiry_epoch INTEGER,
  last_completed_attempt_token TEXT,
  completed_outcome TEXT CHECK (
    completed_outcome IS NULL OR completed_outcome IN ('succeeded', 'failed', 'superseded', 'lost')
  ),
  completed_epoch INTEGER,
  claim_count INTEGER NOT NULL DEFAULT 0 CHECK (claim_count >= 0),
  takeover_count INTEGER NOT NULL DEFAULT 0 CHECK (takeover_count >= 0),
  supersede_count INTEGER NOT NULL DEFAULT 0 CHECK (supersede_count >= 0),
  PRIMARY KEY (workspace_id, plane),
  CHECK (
    (active_attempt_token IS NULL AND owner_uuid IS NULL AND owner_pid IS NULL AND owner_hostname IS NULL
      AND heartbeat_epoch IS NULL AND lease_expiry_epoch IS NULL)
    OR
    (active_attempt_token IS NOT NULL AND owner_uuid IS NOT NULL AND owner_pid IS NOT NULL
      AND owner_hostname IS NOT NULL AND heartbeat_epoch IS NOT NULL AND lease_expiry_epoch IS NOT NULL)
  ),
  CHECK (
    active_attempt_token IS NULL
    OR (plane = 'code' AND target_graph_generation IS NOT NULL AND target_semantic_revision IS NOT NULL)
    OR (plane = 'memory' AND target_graph_generation IS NULL AND target_semantic_revision IS NOT NULL)
  )
) STRICT;

INSERT INTO semantic_reconciliation_claims(workspace_id, plane)
SELECT workspace_id, plane FROM workspace_semantic_state;
