CREATE TABLE project_model_provider (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('vercel-ai-gateway')),
  encrypted_api_key text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, provider)
);
