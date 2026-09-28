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
  widget_count integer NOT NULL CHECK (widget_count BETWEEN 0 AND 100),
  config_json text NOT NULL,
  snapshot_json text NOT NULL,
  creation_key text NOT NULL,
  input_hash text NOT NULL,
  created_at text NOT NULL,
  frozen_at text NOT NULL,
  presentation_json text,
  presentation_revision integer NOT NULL DEFAULT 0,
  layout text NOT NULL DEFAULT 'canvas',
  status text NOT NULL DEFAULT 'draft',
  revision integer NOT NULL DEFAULT 1,
  updated_at text,
  published_at text,
  public_token text,
  input_json text,
  author jsonb,
  mdx_json text,
  UNIQUE(project_id, number),
  UNIQUE(project_id, creation_key),
  CONSTRAINT reports_lifecycle_check CHECK (
    status IN ('draft','published') AND revision > 0 AND
    (public_token IS NULL OR status='published')
  )
);
CREATE INDEX reports_project_created_idx ON reports(project_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX reports_public_token_key ON reports(public_token) WHERE public_token IS NOT NULL;

-- Forward capture only. Missing historical prompt provenance stays unknown.
ALTER TABLE eval_target_attributions ADD COLUMN prompt_versions_json jsonb NOT NULL DEFAULT '[]';
