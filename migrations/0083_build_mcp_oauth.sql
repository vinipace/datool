ALTER TABLE build_app_connections ADD COLUMN IF NOT EXISTS mcp_auth_type text NOT NULL DEFAULT 'none';
UPDATE build_app_connections SET mcp_auth_type='token' WHERE mcp_has_token AND toolkit='custom_mcp';

CREATE TABLE IF NOT EXISTS build_mcp_oauth_requests (
  connection_id uuid PRIMARY KEY REFERENCES build_app_connections(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  state_hash text NOT NULL UNIQUE,
  return_to text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  claimed_at timestamptz
);
