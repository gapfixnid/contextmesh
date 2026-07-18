CREATE INDEX idx_semantic_embeddings_hydration
ON semantic_embeddings(workspace_key, plane, model_id, entity_key);
