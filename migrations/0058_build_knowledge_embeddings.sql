-- Install pgvector on the PostgreSQL host before applying this migration.
-- Keep the extension in public so schema-isolated installations share its type.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

ALTER TABLE build_knowledge_chunks
  ADD COLUMN embedding_model text,
  ADD COLUMN embedding public.vector(1536),
  ADD CONSTRAINT build_knowledge_chunks_embedding_pair
    CHECK ((embedding IS NULL) = (embedding_model IS NULL));

-- Retrieval first restricts by project, agent and active source revision using
-- build_knowledge_chunks_active_idx, then computes exact cosine distances.
-- A global approximate index can lose eligible results after tenant filtering.
