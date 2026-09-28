CREATE TABLE report_counters (
  project_id text PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  last_number integer NOT NULL CHECK (last_number > 0)
);

CREATE TABLE reports (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number > 0),
  name text NOT NULL,
  description text NOT NULL,
  template_id text NOT NULL,
  widget_count integer NOT NULL CHECK (widget_count BETWEEN 1 AND 20),
  config_json text NOT NULL,
  snapshot_json text NOT NULL,
  creation_key text NOT NULL,
  input_hash text NOT NULL,
  created_at text NOT NULL,
  frozen_at text NOT NULL,
  UNIQUE(project_id, number),
  UNIQUE(project_id, creation_key)
);
CREATE INDEX reports_project_created_idx ON reports(project_id, created_at DESC, id DESC);

-- Forward capture only. Missing historical prompt provenance stays unknown.
ALTER TABLE eval_target_attributions ADD COLUMN prompt_versions_json jsonb NOT NULL DEFAULT '[]';
