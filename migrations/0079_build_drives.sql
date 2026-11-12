-- Drive contents live in provider volumes; the catalog never contains host paths.
CREATE TABLE IF NOT EXISTS build_drives (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '',
  provider text NOT NULL CHECK (provider IN ('datool', 'local', 'modal')),
  lease_token uuid,
  lease_until timestamptz,
  provisioned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS build_drives_project_idx ON build_drives(project_id, created_at, id);
