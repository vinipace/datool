-- Customer-operations storage for Build. These tables intentionally do not
-- duplicate tracer conversations/messages: conversation_id is an integration
-- key owned by the Build runtime, while this schema owns contact, inbox,
-- routing, campaign, and operational analytics state.

CREATE TABLE build_contacts (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  external_id text,
  display_name text NOT NULL DEFAULT '',
  email text,
  phone text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','archived')),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  UNIQUE (project_id, id)
);
CREATE UNIQUE INDEX build_contacts_project_external_idx
  ON build_contacts(project_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX build_contacts_project_updated_idx ON build_contacts(project_id, updated_at DESC, id);
CREATE INDEX build_contacts_project_email_idx ON build_contacts(project_id, lower(email)) WHERE email IS NOT NULL;

CREATE TABLE build_contact_identities (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  contact_id text NOT NULL,
  channel text NOT NULL,
  identity_key text NOT NULL,
  display_name text,
  verified boolean NOT NULL DEFAULT false,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  UNIQUE (project_id, channel, identity_key),
  FOREIGN KEY (project_id, contact_id) REFERENCES build_contacts(project_id, id) ON DELETE CASCADE
);
CREATE INDEX build_contact_identities_contact_idx ON build_contact_identities(project_id, contact_id, channel);

CREATE TABLE build_contact_attributes (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  contact_id text NOT NULL,
  attribute_key text NOT NULL,
  value_json jsonb NOT NULL DEFAULT 'null'::jsonb,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','conversation','campaign')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, contact_id, attribute_key),
  FOREIGN KEY (project_id, contact_id) REFERENCES build_contacts(project_id, id) ON DELETE CASCADE
);

CREATE TABLE build_contact_imports (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('mcp','csv','api')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  imported_count integer NOT NULL DEFAULT 0 CHECK (imported_count >= 0),
  skipped_count integer NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  error_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX build_contact_imports_project_idx ON build_contact_imports(project_id, created_at DESC, id);

CREATE TABLE build_contact_exports (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  format text NOT NULL CHECK (format IN ('json','csv')),
  filter_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','running','completed','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error text
);
CREATE INDEX build_contact_exports_project_idx ON build_contact_exports(project_id, created_at DESC, id);

CREATE TABLE build_collected_data (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  contact_id text,
  conversation_id text,
  field_key text NOT NULL,
  value_json jsonb NOT NULL DEFAULT 'null'::jsonb,
  source text NOT NULL DEFAULT 'conversation' CHECK (source IN ('conversation','form','action','manual','import')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, contact_id) REFERENCES build_contacts(project_id, id) ON DELETE SET NULL,
  FOREIGN KEY (project_id, conversation_id) REFERENCES build_conversations(project_id, id) ON DELETE SET NULL
);
CREATE INDEX build_collected_data_project_contact_idx ON build_collected_data(project_id, contact_id, created_at DESC, id);
CREATE INDEX build_collected_data_project_conversation_idx ON build_collected_data(project_id, conversation_id, created_at DESC, id);

CREATE TABLE build_leads (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  contact_id text,
  conversation_id text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','qualified','disqualified','converted')),
  score integer CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  source text,
  data_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, contact_id) REFERENCES build_contacts(project_id, id) ON DELETE SET NULL,
  FOREIGN KEY (project_id, conversation_id) REFERENCES build_conversations(project_id, id) ON DELETE SET NULL
);
CREATE INDEX build_leads_project_status_idx ON build_leads(project_id, status, updated_at DESC, id);
CREATE INDEX build_leads_project_contact_idx ON build_leads(project_id, contact_id, updated_at DESC, id);

CREATE TABLE build_teams (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  UNIQUE (project_id, name)
);

CREATE TABLE build_team_members (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  team_id text NOT NULL,
  user_id text NOT NULL,
  role text NOT NULL DEFAULT 'agent' CHECK (role IN ('agent','lead','manager')),
  availability text NOT NULL DEFAULT 'offline' CHECK (availability IN ('online','away','offline')),
  max_concurrent integer NOT NULL DEFAULT 10 CHECK (max_concurrent > 0 AND max_concurrent <= 1000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, team_id, user_id),
  FOREIGN KEY (project_id, team_id) REFERENCES build_teams(project_id, id) ON DELETE CASCADE
);
CREATE INDEX build_team_members_available_idx ON build_team_members(project_id, team_id, availability, updated_at);

CREATE TABLE build_routing_rules (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL,
  priority integer NOT NULL DEFAULT 100 CHECK (priority >= 0 AND priority <= 1000),
  enabled boolean NOT NULL DEFAULT true,
  conditions_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  team_id text,
  assignee_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, team_id) REFERENCES build_teams(project_id, id) ON DELETE SET NULL
);
CREATE INDEX build_routing_rules_project_idx ON build_routing_rules(project_id, enabled, priority, id);

CREATE TABLE build_macros (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL,
  body text NOT NULL,
  actions_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  UNIQUE (project_id, name)
);

CREATE TABLE build_inbox_tickets (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  contact_id text,
  channel text NOT NULL,
  subject text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','snoozed','solved','closed')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  tags_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  assignee_user_id text,
  team_id text,
  snooze_until timestamptz,
  first_response_at timestamptz,
  last_message_at timestamptz,
  resolved_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  UNIQUE (project_id, conversation_id),
  FOREIGN KEY (project_id, contact_id) REFERENCES build_contacts(project_id, id) ON DELETE SET NULL,
  FOREIGN KEY (project_id, team_id) REFERENCES build_teams(project_id, id) ON DELETE SET NULL
);
CREATE INDEX build_inbox_tickets_project_queue_idx ON build_inbox_tickets(project_id, status, priority, updated_at DESC, id);
CREATE INDEX build_inbox_tickets_project_assignee_idx ON build_inbox_tickets(project_id, assignee_user_id, status, updated_at DESC);
CREATE INDEX build_inbox_tickets_project_team_idx ON build_inbox_tickets(project_id, team_id, status, updated_at DESC);

CREATE TABLE build_ticket_events (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  ticket_id text NOT NULL,
  event_type text NOT NULL,
  actor_id text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, ticket_id) REFERENCES build_inbox_tickets(project_id, id) ON DELETE CASCADE
);
CREATE INDEX build_ticket_events_ticket_idx ON build_ticket_events(project_id, ticket_id, created_at DESC, id);

CREATE TABLE build_ticket_notes (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  ticket_id text NOT NULL,
  body text NOT NULL,
  author_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, ticket_id) REFERENCES build_inbox_tickets(project_id, id) ON DELETE CASCADE
);
CREATE INDEX build_ticket_notes_ticket_idx ON build_ticket_notes(project_id, ticket_id, created_at, id);

CREATE TABLE build_conversation_ownership (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  mode text NOT NULL DEFAULT 'ai' CHECK (mode IN ('ai','human')),
  owner_user_id text,
  team_id text,
  lease_token text,
  lease_expires_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, conversation_id),
  FOREIGN KEY (project_id, team_id) REFERENCES build_teams(project_id, id) ON DELETE SET NULL,
  FOREIGN KEY (project_id, conversation_id) REFERENCES build_conversations(project_id, id) ON DELETE CASCADE
);

CREATE TABLE build_csat_surveys (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  ticket_id text,
  conversation_id text,
  contact_id text,
  channel text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','expired','cancelled')),
  rating integer CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
  comment text NOT NULL DEFAULT '',
  requested_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  expires_at timestamptz,
  FOREIGN KEY (project_id, ticket_id) REFERENCES build_inbox_tickets(project_id, id) ON DELETE SET NULL,
  FOREIGN KEY (project_id, contact_id) REFERENCES build_contacts(project_id, id) ON DELETE SET NULL,
  FOREIGN KEY (project_id, conversation_id) REFERENCES build_conversations(project_id, id) ON DELETE SET NULL
);
CREATE INDEX build_csat_surveys_project_idx ON build_csat_surveys(project_id, status, requested_at DESC, id);

CREATE TABLE build_campaigns (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL,
  channel text NOT NULL,
  connection_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','running','paused','completed','failed')),
  template_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  audience_filter_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  suppression_filter_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, connection_id)
    REFERENCES build_channel_connection(project_id, id) ON DELETE SET NULL
);
CREATE INDEX build_campaigns_project_status_idx ON build_campaigns(project_id, status, updated_at DESC, id);
CREATE INDEX build_campaigns_project_connection_idx ON build_campaigns(project_id, connection_id, status, id);

CREATE TABLE build_campaign_suppressions (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  contact_id text NOT NULL,
  reason text NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, contact_id, reason),
  FOREIGN KEY (project_id, contact_id) REFERENCES build_contacts(project_id, id) ON DELETE CASCADE
);

CREATE TABLE build_campaign_audience (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  campaign_id text NOT NULL,
  contact_id text NOT NULL,
  state text NOT NULL DEFAULT 'eligible' CHECK (state IN ('eligible','suppressed','queued','sent','delivered','read','replied','failed')),
  suppression_reason text,
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  UNIQUE (project_id, campaign_id, contact_id),
  FOREIGN KEY (project_id, campaign_id) REFERENCES build_campaigns(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, contact_id) REFERENCES build_contacts(project_id, id) ON DELETE CASCADE
);
CREATE INDEX build_campaign_audience_state_idx ON build_campaign_audience(project_id, campaign_id, state, id);

CREATE TABLE build_campaign_deliveries (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  campaign_id text NOT NULL,
  audience_id text NOT NULL,
  channel text NOT NULL,
  idempotency_key text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sending','sent','delivered','read','replied','failed','suppressed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  provider_message_id text,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (project_id, id),
  UNIQUE (project_id, idempotency_key),
  FOREIGN KEY (project_id, campaign_id) REFERENCES build_campaigns(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, audience_id) REFERENCES build_campaign_audience(project_id, id) ON DELETE CASCADE
);
CREATE INDEX build_campaign_deliveries_claim_idx ON build_campaign_deliveries(project_id, state, next_attempt_at, id);

CREATE TABLE build_operation_events (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  conversation_id text,
  contact_id text,
  channel text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, conversation_id) REFERENCES build_conversations(project_id, id) ON DELETE SET NULL
);
CREATE INDEX build_operation_events_project_time_idx ON build_operation_events(project_id, occurred_at DESC, id);
CREATE INDEX build_operation_events_project_type_idx ON build_operation_events(project_id, event_type, occurred_at DESC, id);
CREATE INDEX build_operation_events_project_question_idx ON build_operation_events(project_id, (payload_json->>'question')) WHERE payload_json ? 'question';

CREATE TABLE build_knowledge_gap_suggestions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  question text NOT NULL,
  evidence_count integer NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  negative_count integer NOT NULL DEFAULT 0 CHECK (negative_count >= 0),
  sample_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','ignored','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  UNIQUE (project_id, fingerprint)
);
CREATE INDEX build_knowledge_gaps_project_status_idx ON build_knowledge_gap_suggestions(project_id, status, negative_count DESC, updated_at DESC, id);
