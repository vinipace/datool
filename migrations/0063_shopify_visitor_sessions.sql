-- Browser credentials never authorize customer conversations. Short-lived access
-- tokens carry this row's version so logout/account switching revokes old access.
CREATE TABLE build_shopify_visitor_sessions (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  visitor_id text NOT NULL,
  identity_version integer NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, connection_id)
    REFERENCES build_channel_connection(project_id, id) ON DELETE CASCADE
);
CREATE INDEX build_shopify_visitor_sessions_expiry_idx
  ON build_shopify_visitor_sessions(expires_at);
