-- The full endpoint (which may contain query credentials) and access token are encrypted.
ALTER TABLE build_app_connections
  ADD COLUMN mcp_config_encrypted text,
  ADD COLUMN mcp_url text,
  ADD COLUMN mcp_has_token boolean NOT NULL DEFAULT false;
