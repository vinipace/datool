-- Private Shopify identity is deliberately separate from visitor/model metadata.
ALTER TABLE build_shopify_visitor_sessions
  ADD COLUMN shop text,
  ADD COLUMN customer_id text,
  ADD COLUMN verified_at timestamptz;

CREATE TABLE build_shopify_message_identity (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  message_id text NOT NULL,
  browser_session_id uuid NOT NULL REFERENCES build_shopify_visitor_sessions(id) ON DELETE CASCADE,
  identity_version integer NOT NULL CHECK (identity_version > 0),
  PRIMARY KEY (project_id, message_id),
  FOREIGN KEY (project_id, message_id)
    REFERENCES build_channel_message(project_id, id) ON DELETE CASCADE
);

-- A targeted email cooldown prevents invitation spam without limiting chats.
CREATE TABLE build_shopify_invitation_cooldown (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  recipient_hash text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, connection_id, recipient_hash),
  FOREIGN KEY (project_id, connection_id)
    REFERENCES build_app_connections(project_id, id) ON DELETE CASCADE
);
