CREATE TABLE IF NOT EXISTS build_knowledge_crawl_pages (
  project_id text NOT NULL,
  job_id text NOT NULL REFERENCES build_knowledge_jobs(id) ON DELETE CASCADE,
  source_revision integer NOT NULL CHECK (source_revision > 0),
  url text NOT NULL,
  page_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, job_id, url)
);
