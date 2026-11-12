-- Credentials never enter deployment bundles or provider sandboxes.
CREATE TABLE IF NOT EXISTS project_postgres (
  project_id text PRIMARY KEY REFERENCES project(id) ON DELETE RESTRICT,
  encrypted_credentials text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
