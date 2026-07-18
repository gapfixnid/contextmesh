ALTER TABLE workspaces ADD COLUMN adapter_state_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(adapter_state_json));
ALTER TABLE index_runs ADD COLUMN adapter_stats_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(adapter_stats_json));

CREATE TABLE source_files_v3 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL, path_key TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('typescript','tsx','javascript','jsx','mjs','cjs','python')),
  ecosystem TEXT NOT NULL CHECK (ecosystem IN ('npm','pypi')),
  source_root TEXT NOT NULL DEFAULT '', adapter_config_hash TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0), mtime_ms REAL NOT NULL,
  parse_status TEXT NOT NULL CHECK (parse_status IN ('ok','partial','error')),
  diagnostic_count INTEGER NOT NULL DEFAULT 0 CHECK (diagnostic_count >= 0),
  last_generation INTEGER NOT NULL CHECK (last_generation > 0), indexed_at TEXT NOT NULL,
  UNIQUE (workspace_id, path_key)
) STRICT;
INSERT INTO source_files_v3(id,workspace_id,relative_path,path_key,language,ecosystem,source_root,adapter_config_hash,
 content_hash,size_bytes,mtime_ms,parse_status,diagnostic_count,last_generation,indexed_at)
SELECT id,workspace_id,relative_path,path_key,language,'npm','','',content_hash,size_bytes,mtime_ms,parse_status,
 diagnostic_count,last_generation,indexed_at FROM source_files;

CREATE TABLE code_nodes_v3 (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id TEXT REFERENCES source_files_v3(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('module','external_module','function','class','method','interface','type_alias','enum','variable')),
  name TEXT NOT NULL, qualified_name TEXT NOT NULL, local_key TEXT NOT NULL, signature TEXT NOT NULL DEFAULT '', doc TEXT NOT NULL DEFAULT '',
  is_exported INTEGER NOT NULL DEFAULT 0 CHECK (is_exported IN (0,1)),
  start_byte INTEGER NOT NULL DEFAULT 0 CHECK (start_byte >= 0), end_byte INTEGER NOT NULL DEFAULT 0 CHECK (end_byte >= start_byte),
  start_line INTEGER NOT NULL DEFAULT 1 CHECK (start_line >= 1), start_column INTEGER NOT NULL DEFAULT 1 CHECK (start_column >= 1),
  end_line INTEGER NOT NULL DEFAULT 1 CHECK (end_line >= 1), end_column INTEGER NOT NULL DEFAULT 1 CHECK (end_column >= 1),
  content_hash TEXT NOT NULL, generation INTEGER NOT NULL CHECK (generation > 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)), semantic_source_hash TEXT,
  language TEXT NOT NULL, ecosystem TEXT NOT NULL CHECK (ecosystem IN ('npm','pypi')),
  native_kind TEXT NOT NULL, analysis_level TEXT NOT NULL CHECK (analysis_level IN ('syntax','resolved','typed')),
  UNIQUE (workspace_id, local_key)
) STRICT;
INSERT INTO code_nodes_v3(id,workspace_id,file_id,kind,name,qualified_name,local_key,signature,doc,is_exported,
 start_byte,end_byte,start_line,start_column,end_line,end_column,content_hash,generation,metadata_json,semantic_source_hash,
 language,ecosystem,native_kind,analysis_level)
SELECT node.id,node.workspace_id,node.file_id,node.kind,node.name,node.qualified_name,node.local_key,node.signature,node.doc,node.is_exported,
 node.start_byte,node.end_byte,node.start_line,node.start_column,node.end_line,node.end_column,node.content_hash,node.generation,node.metadata_json,node.semantic_source_hash,
 coalesce(file.language,'typescript'),'npm',coalesce(json_extract(node.metadata_json,'$.syntaxKind'),node.kind),'typed'
FROM code_nodes node LEFT JOIN source_files file ON file.id=node.file_id;

CREATE TABLE code_edges_v3 (
  id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES code_nodes_v3(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES code_nodes_v3(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('CONTAINS','IMPORTS','EXPORTS','CALLS','EXTENDS','IMPLEMENTS','REFERENCES')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
  resolution_kind TEXT NOT NULL CHECK (resolution_kind IN ('exact','local','import','heuristic')),
  generation INTEGER NOT NULL CHECK (generation > 0), metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  status TEXT NOT NULL CHECK (status IN ('candidate','resolved')), evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  UNIQUE (workspace_id,source_id,target_id,kind)
) STRICT;
INSERT INTO code_edges_v3(id,workspace_id,source_id,target_id,kind,confidence,resolution_kind,generation,metadata_json,status,evidence_json)
SELECT id,workspace_id,source_id,target_id,kind,confidence,resolution_kind,generation,metadata_json,'resolved',
 json_array(json_object('provider','typescript_type_checker','providerVersion','legacy','source','type_checker','confidence',confidence))
FROM code_edges;

CREATE TABLE unresolved_refs_v3 (
  id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES source_files_v3(id) ON DELETE CASCADE,
  source_node_id TEXT REFERENCES code_nodes_v3(id) ON DELETE CASCADE, kind TEXT NOT NULL, raw_name TEXT NOT NULL, qualifier TEXT,
  line INTEGER NOT NULL CHECK (line >= 1), column INTEGER NOT NULL CHECK (column >= 1),
  candidates_json TEXT NOT NULL CHECK (json_valid(candidates_json)), generation INTEGER NOT NULL CHECK (generation > 0),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0), evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json))
) STRICT;
INSERT INTO unresolved_refs_v3(id,workspace_id,file_id,source_node_id,kind,raw_name,qualifier,line,column,candidates_json,generation,confidence,evidence_json)
SELECT id,workspace_id,file_id,source_node_id,kind,raw_name,qualifier,line,column,candidates_json,generation,0.5,
 json_array(json_object('provider','typescript_type_checker','providerVersion','legacy','source','type_checker','confidence',0.5))
FROM unresolved_refs;

CREATE TABLE memory_code_links_v3 (
  id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memory_fragments(id) ON DELETE CASCADE,
  code_node_id TEXT REFERENCES code_nodes_v3(id) ON DELETE SET NULL, node_local_key TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('about','decision_for','error_in','procedure_for','evidence')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
  locator_snapshot_json TEXT NOT NULL CHECK (json_valid(locator_snapshot_json)), created_at TEXT NOT NULL, language TEXT,
  UNIQUE (workspace_id,memory_id,node_local_key,relation_type)
) STRICT;
INSERT INTO memory_code_links_v3(id,workspace_id,memory_id,code_node_id,node_local_key,relation_type,confidence,locator_snapshot_json,created_at,language)
SELECT link.id,link.workspace_id,link.memory_id,link.code_node_id,link.node_local_key,link.relation_type,link.confidence,
 link.locator_snapshot_json,link.created_at,coalesce(file.language,'typescript')
FROM memory_code_links link
LEFT JOIN code_nodes node ON node.id=link.code_node_id
LEFT JOIN source_files file ON file.id=node.file_id;

DROP TABLE memory_code_links;
DROP TABLE unresolved_refs;
DROP TABLE code_edges;
DROP TABLE code_nodes;
DROP TABLE source_files;
ALTER TABLE source_files_v3 RENAME TO source_files;
ALTER TABLE code_nodes_v3 RENAME TO code_nodes;
ALTER TABLE code_edges_v3 RENAME TO code_edges;
ALTER TABLE unresolved_refs_v3 RENAME TO unresolved_refs;
ALTER TABLE memory_code_links_v3 RENAME TO memory_code_links;

CREATE INDEX idx_files_workspace_hash ON source_files(workspace_id,content_hash);
CREATE INDEX idx_files_workspace_language ON source_files(workspace_id,language,path_key);
CREATE INDEX idx_nodes_workspace_kind_name ON code_nodes(workspace_id,kind,name);
CREATE INDEX idx_nodes_workspace_language ON code_nodes(workspace_id,language,kind,name);
CREATE INDEX idx_nodes_file ON code_nodes(file_id);
CREATE INDEX idx_edges_source_kind ON code_edges(workspace_id,source_id,kind);
CREATE INDEX idx_edges_target_kind ON code_edges(workspace_id,target_id,kind);
CREATE INDEX idx_unresolved_source ON unresolved_refs(workspace_id,source_node_id);
CREATE INDEX idx_memory_code_node ON memory_code_links(workspace_id,code_node_id);
