CREATE TABLE dataset_snapshots (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  dataset_id text NOT NULL,
  content_hash text NOT NULL,
  label text,
  item_count integer NOT NULL,
  content_json text NOT NULL,
  created_at text NOT NULL,
  FOREIGN KEY (project_id, dataset_id) REFERENCES datasets(project_id, id) ON DELETE CASCADE,
  UNIQUE (project_id, dataset_id, content_hash)
);
CREATE INDEX dataset_snapshots_page_idx ON dataset_snapshots(project_id, dataset_id, created_at, id);

-- A claimed request is never automatically retried: an app or judge may have
-- already incurred cost before a process interruption or an ambiguous response.
CREATE TABLE agent_eval_requests (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  request_key text NOT NULL,
  request_hash text NOT NULL,
  run_id text,
  state text NOT NULL CHECK (state IN ('starting', 'started', 'failed')),
  PRIMARY KEY (project_id, request_key)
);
