-- Channel-neutral knowledge storage for Build agents. The active_revision
-- pointer lets an indexing attempt stage a complete replacement and publish
-- it atomically; a failed crawl never destroys the last known-good index.

CREATE TABLE IF NOT EXISTS build_knowledge_sources (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('text','qa','file','website','sitemap')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  uri text,
  mime_type text,
  file_name text,
  content_text text,
  content_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','indexing','ready','error','deleted')),
  status_message text,
  content_hash text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  active_revision integer NOT NULL DEFAULT 0 CHECK (active_revision >= 0),
  last_indexed_at timestamptz,
  next_resync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id)
);

CREATE INDEX IF NOT EXISTS build_knowledge_sources_project_agent_idx
  ON build_knowledge_sources(project_id, agent_id, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS build_knowledge_sources_resync_idx
  ON build_knowledge_sources(next_resync_at)
  WHERE next_resync_at IS NOT NULL AND status <> 'deleted';

-- The Build foundation owns build_agents. Keep fresh installations and
-- migration-order experiments valid while adding the composite tenant-safe
-- foreign key whenever that table is already present.
DO $$
BEGIN
  IF to_regclass('build_agents') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'build_knowledge_sources_project_agent_fk'
        AND conrelid = 'build_knowledge_sources'::regclass
    ) THEN
    ALTER TABLE build_knowledge_sources
      ADD CONSTRAINT build_knowledge_sources_project_agent_fk
      FOREIGN KEY (project_id, agent_id)
      REFERENCES build_agents(project_id, id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS build_knowledge_chunks (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  agent_id text NOT NULL,
  source_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  content text NOT NULL CHECK (length(content) > 0),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_vector tsvector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  UNIQUE (project_id, source_id, revision, ordinal),
  FOREIGN KEY (project_id, source_id)
    REFERENCES build_knowledge_sources(project_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS build_knowledge_chunks_search_idx
  ON build_knowledge_chunks USING gin(search_vector);
CREATE INDEX IF NOT EXISTS build_knowledge_chunks_active_idx
  ON build_knowledge_chunks(project_id, agent_id, source_id, revision, ordinal);

CREATE TABLE IF NOT EXISTS build_knowledge_jobs (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  source_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('index','resync')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error text,
  -- A fresh lease token fences a worker after expiry/reclaim or source edits.
  lease_token text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  FOREIGN KEY (project_id, source_id)
    REFERENCES build_knowledge_sources(project_id, id)
    ON DELETE CASCADE
);

-- Keep upgrades safe when an earlier 0043 was already applied before worker
-- recovery was introduced.
ALTER TABLE build_knowledge_jobs
  ADD COLUMN IF NOT EXISTS lease_token text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

CREATE INDEX IF NOT EXISTS build_knowledge_jobs_queue_idx
  ON build_knowledge_jobs(project_id, status, queued_at, id);
CREATE INDEX IF NOT EXISTS build_knowledge_jobs_source_idx
  ON build_knowledge_jobs(project_id, source_id, queued_at DESC, id);
CREATE INDEX IF NOT EXISTS build_knowledge_jobs_lease_idx
  ON build_knowledge_jobs(status, lease_expires_at, project_id, queued_at, id)
  WHERE status = 'running';
CREATE UNIQUE INDEX IF NOT EXISTS build_knowledge_jobs_one_active_idx
  ON build_knowledge_jobs(project_id, source_id)
  WHERE status IN ('queued','running');
