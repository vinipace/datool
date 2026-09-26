CREATE TABLE playground_state (
  project_id text PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_bridge_job (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  bridge_id uuid NOT NULL,
  app_id text NOT NULL,
  call_id text NOT NULL,
  job jsonb NOT NULL,
  claim_id uuid,
  result jsonb,
  deadline timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, call_id)
);
CREATE INDEX app_bridge_job_pending ON app_bridge_job (project_id, bridge_id, created_at)
  WHERE result IS NULL;

CREATE TABLE eval_run_lease (
  run_id text PRIMARY KEY REFERENCES eval_runs(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
