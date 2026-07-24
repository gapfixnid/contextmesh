ALTER TABLE workspaces ADD COLUMN memory_revision INTEGER NOT NULL DEFAULT 0 CHECK(memory_revision >= 0);

CREATE TABLE memory_fragment_metadata (
  memory_id TEXT PRIMARY KEY REFERENCES memory_fragments(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  observed_at TEXT,
  utility_score INTEGER NOT NULL DEFAULT 0 CHECK(utility_score BETWEEN 0 AND 1000),
  maintenance_state TEXT NOT NULL DEFAULT 'clean'
    CHECK(maintenance_state IN ('clean','duplicate_candidate','conflict_candidate','review_required')),
  last_maintained_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK(valid_to IS NULL OR valid_to > valid_from)
) STRICT;

INSERT INTO memory_fragment_metadata(memory_id,workspace_id,valid_from,valid_to,observed_at,utility_score,maintenance_state,updated_at)
SELECT id,workspace_id,created_at,NULL,NULL,
  min(1000,max(0,importance*120 +
    CASE assertion_status WHEN 'verified' THEN 180 WHEN 'observed' THEN 100 WHEN 'inferred' THEN 40 ELSE -1000 END +
    CASE WHEN is_anchor=1 THEN 160 ELSE 0 END +
    CASE WHEN type IN ('decision','procedure') THEN 100 WHEN type IN ('fact','preference','relation') THEN 60 WHEN type='error' THEN 30 ELSE 0 END +
    min(100,access_count*5))),
  'clean',updated_at
FROM memory_fragments;

CREATE TABLE memory_claims (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memory_fragments(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  claim_key TEXT NOT NULL,
  operator TEXT NOT NULL CHECK(operator='eq'),
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  value_digest TEXT NOT NULL,
  source_symbol_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(memory_id,namespace,claim_key,operator)
) STRICT;

CREATE TABLE memory_code_link_validations (
  link_id INTEGER PRIMARY KEY REFERENCES memory_code_links(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memory_fragments(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('valid','relocated','stale','orphaned','contradicted','needs_review')),
  checked_generation INTEGER NOT NULL CHECK(checked_generation >= 0),
  resolved_code_node_id TEXT,
  expected_content_hash TEXT,
  observed_content_hash TEXT,
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0.0 AND 1.0),
  reason_code TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  validated_at TEXT NOT NULL
) STRICT;

INSERT INTO memory_code_link_validations(
  link_id,workspace_id,memory_id,state,checked_generation,resolved_code_node_id,
  expected_content_hash,observed_content_hash,confidence,reason_code,evidence_json,validated_at
)
SELECT l.id,l.workspace_id,l.memory_id,
  CASE
    WHEN l.code_node_id IS NULL THEN 'needs_review'
    WHEN json_extract(l.locator_snapshot_json,'$.contentHash') IS NULL THEN 'needs_review'
    ELSE 'valid'
  END,
  w.current_generation,l.code_node_id,json_extract(l.locator_snapshot_json,'$.contentHash'),n.content_hash,
  CASE WHEN l.code_node_id IS NULL OR json_extract(l.locator_snapshot_json,'$.contentHash') IS NULL THEN 0.5 ELSE 1.0 END,
  CASE WHEN l.code_node_id IS NULL THEN 'LEGACY_TARGET_MISSING'
       WHEN json_extract(l.locator_snapshot_json,'$.contentHash') IS NULL THEN 'LEGACY_LOCATOR_INSUFFICIENT'
       ELSE 'EXACT_MATCH' END,
  '{}',l.created_at
FROM memory_code_links l
JOIN workspaces w ON w.id=l.workspace_id
LEFT JOIN code_nodes n ON n.id=l.code_node_id;

CREATE VIEW memory_validation_summary AS
SELECT memory_id,
  count(*) AS validation_link_count,
  CASE max(CASE state
    WHEN 'contradicted' THEN 6 WHEN 'stale' THEN 5 WHEN 'orphaned' THEN 4
    WHEN 'needs_review' THEN 3 WHEN 'relocated' THEN 2 ELSE 1 END)
    WHEN 6 THEN 'contradicted' WHEN 5 THEN 'stale' WHEN 4 THEN 'orphaned'
    WHEN 3 THEN 'needs_review' WHEN 2 THEN 'relocated' ELSE 'valid' END AS validation_state,
  max(checked_generation) AS checked_generation,
  max(validated_at) AS checked_at,
  min(confidence) AS validation_confidence,
  json_group_array(reason_code) AS validation_reason_codes
FROM memory_code_link_validations
GROUP BY memory_id;

CREATE TABLE memory_review_candidates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  candidate_type TEXT NOT NULL CHECK(candidate_type IN ('duplicate','conflict','episode_compaction','code_validation')),
  left_memory_id TEXT REFERENCES memory_fragments(id) ON DELETE CASCADE,
  right_memory_id TEXT REFERENCES memory_fragments(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dismissed','resolved')),
  score_micros INTEGER NOT NULL DEFAULT 0 CHECK(score_micros BETWEEN 0 AND 1000000),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  resolution_json TEXT CHECK(resolution_json IS NULL OR json_valid(resolution_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;

CREATE TABLE memory_maintenance_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL CHECK(job_type IN ('revalidate_links','detect_duplicates','detect_conflicts','compact_episodes','recompute_utility','expire_lifecycle')),
  job_key TEXT NOT NULL,
  target_graph_generation INTEGER,
  input_memory_revision INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','succeeded','failed')),
  cursor_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(cursor_json)),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
  result_digest TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  lease_owner TEXT, lease_token TEXT, lease_expires_epoch INTEGER, last_error TEXT,
  created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL,
  UNIQUE(workspace_id,job_key)
) STRICT;

CREATE TABLE memory_events_v07 (
  id INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fragment_id TEXT REFERENCES memory_fragments(id) ON DELETE SET NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'remembered','recalled','reflected','superseded','forgotten','expired','linked',
    'validation_changed','maintenance_queued','maintenance_started','maintenance_completed',
    'maintenance_failed','review_candidate_created','review_resolved','utility_recomputed',
    'compacted','reinforced'
  )),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL
) STRICT;
INSERT INTO memory_events_v07 SELECT * FROM memory_events;
DROP TABLE memory_events;
ALTER TABLE memory_events_v07 RENAME TO memory_events;

CREATE INDEX idx_memory_metadata_maintenance ON memory_fragment_metadata(workspace_id,maintenance_state);
CREATE INDEX idx_memory_metadata_validity ON memory_fragment_metadata(workspace_id,valid_from,valid_to);
CREATE INDEX idx_memory_validation_state ON memory_code_link_validations(workspace_id,state,memory_id);
CREATE INDEX idx_memory_review_pending ON memory_review_candidates(workspace_id,status,candidate_type,id);
CREATE INDEX idx_memory_jobs_state ON memory_maintenance_jobs(workspace_id,state,job_type,created_at);
CREATE INDEX idx_memory_claim_lookup ON memory_claims(workspace_id,namespace,claim_key,value_digest);
