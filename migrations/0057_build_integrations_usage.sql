-- Connections are owned by a project, never by a visitor-supplied identity.
CREATE TABLE build_app_connections (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  request_key text NOT NULL,
  toolkit text NOT NULL,
  label text NOT NULL,
  provider_user_id text NOT NULL,
  auth_config_id text NOT NULL,
  connected_account_id text UNIQUE,
  status text NOT NULL CHECK (status IN ('pending','active','disconnected','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,request_key),
  UNIQUE(project_id,id)
);
CREATE INDEX build_app_connections_project ON build_app_connections(project_id,created_at DESC);

ALTER TABLE execution_credit_operation DROP CONSTRAINT execution_credit_operation_runtime_check;
ALTER TABLE execution_credit_operation ADD CONSTRAINT execution_credit_operation_runtime_check
  CHECK(runtime IN ('model','sandbox','integration'));

-- Durable metering survives turn errors and customer ownership changes.
-- No prompts, OAuth credentials, action arguments or results belong here.
CREATE TABLE build_usage_event (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  agent_id text NOT NULL,
  conversation_id text NOT NULL,
  turn_id text NOT NULL,
  event_key text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('model','integration')),
  provider text NOT NULL,
  model text,
  toolkit text,
  tool_slug text,
  connection_id uuid,
  status text NOT NULL CHECK(status IN ('pending','completed','failed','uncertain','blocked')),
  input_tokens bigint CHECK(input_tokens >= 0),
  output_tokens bigint CHECK(output_tokens >= 0),
  cached_input_tokens bigint CHECK(cached_input_tokens >= 0),
  reasoning_tokens bigint CHECK(reasoning_tokens >= 0),
  cost_nano_usd bigint CHECK(cost_nano_usd >= 0),
  cost_source text NOT NULL CHECK(cost_source IN ('provider','configured','unknown')),
  credit_operation_id uuid REFERENCES execution_credit_operation(id),
  provider_log_id text,
  provider_session_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,event_key)
);
CREATE INDEX build_usage_organization_period ON build_usage_event(organization_id,created_at DESC);
CREATE INDEX build_usage_agent_period ON build_usage_event(project_id,agent_id,created_at DESC);
CREATE INDEX build_usage_conversation ON build_usage_event(project_id,conversation_id,created_at DESC);
