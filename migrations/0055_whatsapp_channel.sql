-- Meta account ownership is verified server-side. A phone can route to only
-- one channel across this installation, including paused connections.
CREATE TABLE build_whatsapp_account (
  connection_id uuid PRIMARY KEY,
  project_id text NOT NULL,
  phone_number_id text NOT NULL UNIQUE,
  waba_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('cloud','coexistence')),
  display_phone_number text NOT NULL,
  verified_name text NOT NULL DEFAULT '',
  token_expires_at timestamptz,
  connected_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  sync_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (project_id, connection_id) REFERENCES build_channel_connection(project_id,id) ON DELETE CASCADE
);
CREATE TABLE build_whatsapp_signup (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  connection_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('cloud','coexistence')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','authorizing','authorized','activating','complete','failed')),
  encrypted_token text,
  waba_id text,
  phones_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_expires_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, connection_id) REFERENCES build_channel_connection(project_id,id) ON DELETE CASCADE
);
CREATE INDEX build_whatsapp_signup_expiry ON build_whatsapp_signup(expires_at);
CREATE TABLE build_whatsapp_recipient (
  project_id text NOT NULL,
  connection_id uuid NOT NULL,
  recipient_id text NOT NULL,
  last_customer_message_at timestamptz,
  template_opt_in boolean NOT NULL DEFAULT false,
  opted_out boolean NOT NULL DEFAULT false,
  consent_note text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,connection_id,recipient_id),
  FOREIGN KEY (project_id, connection_id) REFERENCES build_channel_connection(project_id,id) ON DELETE CASCADE
);
CREATE TABLE build_whatsapp_receipt (
  project_id text NOT NULL,
  connection_id uuid NOT NULL,
  provider_message_id text NOT NULL,
  message_id text,
  status text NOT NULL CHECK(status IN ('sent','delivered','read','failed')),
  status_rank integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  error_code text,
  PRIMARY KEY(connection_id,provider_message_id),
  FOREIGN KEY (project_id, connection_id) REFERENCES build_channel_connection(project_id,id) ON DELETE CASCADE
);
