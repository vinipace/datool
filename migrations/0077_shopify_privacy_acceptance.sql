ALTER TABLE build_shopify_connections
  ADD COLUMN privacy_policy_version text,
  ADD COLUMN privacy_accepted_at timestamptz,
  ADD COLUMN privacy_accepted_by text REFERENCES "user"(id) ON DELETE SET NULL;
