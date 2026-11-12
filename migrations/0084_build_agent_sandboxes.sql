-- One resumable environment per Eve execution. Drives outlive these sessions.
CREATE TABLE build_agent_sandboxes (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  turn_id text NOT NULL UNIQUE REFERENCES build_eve_executions(turn_id) ON DELETE CASCADE,
  session_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('local','modal','datool')),
  native_name text NOT NULL,
  native_id text,
  operation_id text,
  status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','running','closing','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz
);
CREATE INDEX build_agent_sandboxes_cleanup ON build_agent_sandboxes(expires_at) WHERE status <> 'closed';
