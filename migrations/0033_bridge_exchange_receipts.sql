-- Exact replay includes empty polls and acknowledgments, not just pending claims.
CREATE TABLE app_bridge_exchange (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  bridge_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  reply jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id, bridge_id, request_id)
);
CREATE INDEX app_bridge_exchange_retention ON app_bridge_exchange(project_id, created_at);
