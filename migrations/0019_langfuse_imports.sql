CREATE TABLE langfuse_import_runs (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  host text NOT NULL,
  source_project_id text NOT NULL,
  from_time text NOT NULL,
  to_time text NOT NULL,
  page_size integer NOT NULL CHECK (page_size BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','failed','completed','completed_with_issues')),
  checkpoint jsonb NOT NULL DEFAULT '{"phase":"sessions","token":null,"modes":{},"warnings":[]}',
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id,id)
);
CREATE TABLE langfuse_import_records (
  run_id text NOT NULL,
  project_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('sessions','traces','observations','scores')),
  source_id text NOT NULL,
  raw jsonb NOT NULL,
  synthetic boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','imported','unsupported','unresolved','conflict')),
  reason text,
  destination_id text,
  PRIMARY KEY (run_id,kind,source_id),
  FOREIGN KEY (project_id,run_id) REFERENCES langfuse_import_runs(project_id,id) ON DELETE CASCADE
);
CREATE INDEX langfuse_import_pending_idx ON langfuse_import_records(run_id,kind,status,source_id);
CREATE INDEX langfuse_import_trace_idx ON langfuse_import_records(run_id,(raw->>'traceId')) WHERE kind='observations';
CREATE TABLE langfuse_import_pages (
  run_id text NOT NULL REFERENCES langfuse_import_runs(id) ON DELETE CASCADE,
  kind text NOT NULL,
  token text NOT NULL,
  row_count integer NOT NULL,
  source_total integer,
  PRIMARY KEY (run_id,kind,token)
);
-- A source object maps to one destination object across overlapping import runs.
CREATE TABLE langfuse_import_entities (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind text NOT NULL,
  raw jsonb NOT NULL,
  UNIQUE (project_id,id)
);
