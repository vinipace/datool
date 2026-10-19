-- Channel connections and provider delivery ledger for Build. Customer
-- contacts, conversations and messages remain authoritative in 0044/0046;
-- this migration stores only provider-specific identity and delivery state.

CREATE TABLE build_channel_connection (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  organization_id text REFERENCES organization(id) ON DELETE SET NULL,
  agent_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('web','telegram','whatsapp','messenger','instagram','email','slack','api','helpdesk')),
  label text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','connected','paused','error','disconnected')),
  external_id text,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  encrypted_credentials text,
  credentials_version text,
  encrypted_webhook_secret text,
  webhook_mode text CHECK (webhook_mode IN ('webhook','polling')),
  polling_offset bigint,
  last_error text,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  UNIQUE (project_id, channel, external_id),
  FOREIGN KEY (project_id, agent_id)
    REFERENCES build_agents(project_id, id) ON DELETE CASCADE
);
CREATE INDEX build_channel_connection_project_idx
  ON build_channel_connection(project_id, channel, status, updated_at DESC);

-- One row per provider message gives us idempotency even if a provider retries
-- an event after the HTTP response was lost. The channel message points at the
-- shared conversation and contact ledgers; it never replaces them.
CREATE TABLE build_channel_message (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  conversation_id text NOT NULL,
  contact_id text,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  provider_message_id text,
  idempotency_key text NOT NULL,
  content_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','queued','sending','sent','delivered','failed','uncertain','ignored')),
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  UNIQUE (project_id, connection_id, idempotency_key),
  UNIQUE (project_id, connection_id, provider_message_id),
  FOREIGN KEY (project_id, connection_id)
    REFERENCES build_channel_connection(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, conversation_id)
    REFERENCES build_conversations(project_id, id) ON DELETE CASCADE
  -- build_contacts is created in the later operations migration; the channel
  -- ledger keeps this optional integration key without a migration-order FK.
);
CREATE INDEX build_channel_message_conversation_idx
  ON build_channel_message(project_id, conversation_id, created_at);

CREATE TABLE build_channel_job (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('process_inbound','deliver_outbound','telegram_poll')),
  message_id text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','uncertain')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lock_token uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, idempotency_key),
  FOREIGN KEY (project_id, connection_id)
    REFERENCES build_channel_connection(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, message_id)
    REFERENCES build_channel_message(project_id, id) ON DELETE SET NULL
);
CREATE INDEX build_channel_job_claim_idx
  ON build_channel_job(status, run_after, created_at);

-- Anonymous hosted-chat admission is keyed by a server-derived client
-- fingerprint, never by the visitor token. This keeps a caller from evading
-- the edge guard by minting a fresh visitor for every request. The fingerprint
-- is HMACed before it is written and old buckets are pruned opportunistically
-- by the public channel service.
CREATE TABLE build_public_admission_bucket (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('session','message','feedback')),
  client_key text NOT NULL,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (project_id, connection_id, scope, client_key, window_started_at),
  FOREIGN KEY (project_id, connection_id)
    REFERENCES build_channel_connection(project_id, id) ON DELETE CASCADE
);
CREATE INDEX build_public_admission_bucket_prune_idx
  ON build_public_admission_bucket(project_id, connection_id, window_started_at);

CREATE OR REPLACE FUNCTION datool_build_channel_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS build_channel_connection_touch ON build_channel_connection;
CREATE TRIGGER build_channel_connection_touch BEFORE UPDATE ON build_channel_connection
FOR EACH ROW EXECUTE FUNCTION datool_build_channel_touch_updated_at();
DROP TRIGGER IF EXISTS build_channel_message_touch ON build_channel_message;
CREATE TRIGGER build_channel_message_touch BEFORE UPDATE ON build_channel_message
FOR EACH ROW EXECUTE FUNCTION datool_build_channel_touch_updated_at();
DROP TRIGGER IF EXISTS build_channel_job_touch ON build_channel_job;
CREATE TRIGGER build_channel_job_touch BEFORE UPDATE ON build_channel_job
FOR EACH ROW EXECUTE FUNCTION datool_build_channel_touch_updated_at();
