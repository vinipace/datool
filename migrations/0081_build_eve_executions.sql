-- Datool owns published definitions and customer records; Eve owns execution checkpoints.
CREATE TABLE build_eve_executions (
  turn_id text PRIMARY KEY REFERENCES build_conversation_turns(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES build_conversations(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  owner_fence bigint NOT NULL,
  session_id text,
  plan_json jsonb NOT NULL,
  state_json jsonb NOT NULL DEFAULT '{}',
  outcome_json jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX build_eve_executions_pending ON build_eve_executions(status, updated_at)
  WHERE status IN ('pending','running');

-- Claim dispatch before an external side effect. Interrupted calls remain uncertain.
CREATE TABLE build_eve_tool_dispatches (
  turn_id text NOT NULL REFERENCES build_eve_executions(turn_id) ON DELETE CASCADE,
  call_id text NOT NULL,
  status text NOT NULL CHECK(status IN ('running','completed','uncertain')),
  output_json jsonb,
  PRIMARY KEY(turn_id,call_id)
);
