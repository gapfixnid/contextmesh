ALTER TABLE workspaces
  ADD COLUMN freshness_stale INTEGER NOT NULL DEFAULT 0
  CHECK (freshness_stale IN (0, 1));

ALTER TABLE workspaces
  ADD COLUMN freshness_stale_at TEXT;

ALTER TABLE workspaces
  ADD COLUMN freshness_reasons_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(freshness_reasons_json));

ALTER TABLE workspaces
  ADD COLUMN last_strict_check_at TEXT;
