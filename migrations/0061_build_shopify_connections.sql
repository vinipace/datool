-- Native Shopify OAuth credentials are encrypted and bound to a project and connection.
CREATE TABLE build_shopify_connections (
  connection_id uuid PRIMARY KEY REFERENCES build_app_connections(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  shop text NOT NULL,
  client_id text NOT NULL,
  start_token_hash text UNIQUE,
  oauth_state_hash text UNIQUE,
  authorization_expires_at timestamptz NOT NULL,
  session_encrypted text,
  UNIQUE(shop, client_id),
  FOREIGN KEY (project_id, connection_id) REFERENCES build_app_connections(project_id,id) ON DELETE CASCADE
);
