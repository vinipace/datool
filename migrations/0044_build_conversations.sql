-- Build's conversation ledger is authoritative for customer-facing turns.
-- Traces remain the analytical projection; they must never be used to rebuild
-- message ordering or decide whether an inbound channel event was delivered.

CREATE TABLE build_conversations (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('web','telegram','whatsapp','messenger','instagram','email','slack','api','helpdesk')),
  external_conversation_id text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','handed_off','closed','blocked')),
  owner_type text NOT NULL DEFAULT 'ai' CHECK (owner_type IN ('ai','human')),
  owner_id text,
  owner_fence bigint NOT NULL DEFAULT 0 CHECK (owner_fence >= 0),
  turn_sequence bigint NOT NULL DEFAULT 0 CHECK (turn_sequence >= 0),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  variables_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  CONSTRAINT build_conversations_project_agent_fk
    FOREIGN KEY (project_id, agent_id)
    REFERENCES build_agents(project_id, id) ON DELETE CASCADE,
  CHECK (owner_type = 'ai' OR owner_id IS NOT NULL),
  CHECK (jsonb_typeof(metadata_json) = 'object'),
  CHECK (jsonb_typeof(variables_json) = 'object')
);

CREATE UNIQUE INDEX build_conversations_external_key
  ON build_conversations(project_id, agent_id, channel, external_conversation_id)
  WHERE external_conversation_id IS NOT NULL;
CREATE INDEX build_conversations_project_agent_updated
  ON build_conversations(project_id, agent_id, updated_at DESC, id DESC);
CREATE INDEX build_conversations_project_channel_updated
  ON build_conversations(project_id, channel, updated_at DESC, id DESC);

CREATE TABLE build_conversation_turns (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  request_key text NOT NULL,
  source_event_id text,
  status text NOT NULL CHECK (status IN ('started','running','completed','failed','cancelled','uncertain','awaiting_client')),
  input_message_id text,
  output_message_id text,
  trace_id text,
  session_id text,
  snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_json jsonb,
  owner_fence bigint NOT NULL CHECK (owner_fence >= 0),
  lock_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (project_id, id),
  UNIQUE (project_id, conversation_id, request_key),
  FOREIGN KEY (project_id, conversation_id)
    REFERENCES build_conversations(project_id, id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(snapshot_json) = 'object'),
  CHECK (jsonb_typeof(usage_json) = 'object'),
  CHECK (error_json IS NULL OR jsonb_typeof(error_json) = 'object')
);
CREATE INDEX build_conversation_turns_project_conversation_created
  ON build_conversation_turns(project_id, conversation_id, created_at DESC, id DESC);
CREATE INDEX build_conversation_turns_active_lock
  ON build_conversation_turns(project_id, conversation_id, status, lock_expires_at)
  WHERE status IN ('started','running','awaiting_client');

CREATE TABLE build_conversation_messages (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  turn_id text,
  ordinal bigint GENERATED ALWAYS AS IDENTITY,
  role text NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content_json jsonb NOT NULL,
  tool_call_id text,
  action_id text,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('pending','completed','failed','cancelled')),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (project_id, id),
  UNIQUE (project_id, conversation_id, ordinal),
  FOREIGN KEY (project_id, conversation_id)
    REFERENCES build_conversations(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, turn_id)
    REFERENCES build_conversation_turns(project_id, id) ON DELETE SET NULL,
  CHECK (jsonb_typeof(content_json) IN ('object','array','string','number','boolean','null')),
  CHECK (jsonb_typeof(metadata_json) = 'object')
);
CREATE INDEX build_conversation_messages_project_conversation_ordinal
  ON build_conversation_messages(project_id, conversation_id, ordinal);
CREATE INDEX build_conversation_messages_project_turn
  ON build_conversation_messages(project_id, turn_id, ordinal);

CREATE TABLE build_conversation_tool_calls (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  turn_id text NOT NULL,
  tool_call_id text NOT NULL,
  action_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('planned','executing','completed','failed','awaiting_client','uncertain')),
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_json jsonb,
  error_json jsonb,
  continuation_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (project_id, id),
  UNIQUE (project_id, turn_id, tool_call_id),
  FOREIGN KEY (project_id, conversation_id)
    REFERENCES build_conversations(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, turn_id)
    REFERENCES build_conversation_turns(project_id, id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(input_json) = 'object'),
  CHECK (output_json IS NULL OR jsonb_typeof(output_json) IN ('object','array','string','number','boolean','null')),
  CHECK (error_json IS NULL OR jsonb_typeof(error_json) = 'object'),
  CHECK (continuation_json IS NULL OR jsonb_typeof(continuation_json) = 'object')
);
CREATE INDEX build_conversation_tool_calls_project_conversation
  ON build_conversation_tool_calls(project_id, conversation_id, created_at DESC, id DESC);
CREATE INDEX build_conversation_tool_calls_project_turn
  ON build_conversation_tool_calls(project_id, turn_id, created_at, id);

CREATE TABLE build_conversation_ownership_events (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  from_owner_type text CHECK (from_owner_type IS NULL OR from_owner_type IN ('ai','human')),
  from_owner_id text,
  to_owner_type text NOT NULL CHECK (to_owner_type IN ('ai','human')),
  to_owner_id text,
  fence bigint NOT NULL CHECK (fence >= 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, conversation_id)
    REFERENCES build_conversations(project_id, id) ON DELETE CASCADE,
  CHECK (to_owner_type = 'ai' OR to_owner_id IS NOT NULL)
);
CREATE INDEX build_conversation_ownership_events_project_conversation
  ON build_conversation_ownership_events(project_id, conversation_id, created_at DESC, id DESC);

-- Reservations are part of the admission ledger.  A provider response may not
-- contain a billable cost, so an unresolved reservation remains conservative
-- until an operator reconciles it instead of silently releasing the budget.
CREATE TABLE build_conversation_budget_reservations (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  conversation_id text NOT NULL,
  turn_id text NOT NULL,
  owner_fence bigint NOT NULL CHECK (owner_fence >= 0),
  estimated_usd numeric(20, 8) NOT NULL CHECK (estimated_usd >= 0),
  actual_usd numeric(20, 8),
  status text NOT NULL CHECK (status IN ('reserved','settled','released','uncertain')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (project_id, id),
  UNIQUE (project_id, turn_id),
  FOREIGN KEY (project_id, agent_id)
    REFERENCES build_agents(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, conversation_id)
    REFERENCES build_conversations(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, turn_id)
    REFERENCES build_conversation_turns(project_id, id) ON DELETE CASCADE,
  CHECK (actual_usd IS NULL OR actual_usd >= 0)
);
CREATE INDEX build_conversation_budget_reservations_project_agent_created
  ON build_conversation_budget_reservations(project_id, agent_id, created_at DESC, id DESC);
CREATE INDEX build_conversation_budget_reservations_active
  ON build_conversation_budget_reservations(project_id, agent_id, status, created_at)
  WHERE status IN ('reserved','uncertain');
