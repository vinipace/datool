-- Billing ownership is durable: reconnects and browser parameters cannot switch it.
ALTER TABLE organization_billing
  ADD COLUMN provider text NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe','shopify')),
  ADD COLUMN shopify_shop text,
  ADD COLUMN shopify_shop_id text,
  ADD COLUMN shopify_client_id text,
  ADD CONSTRAINT shopify_billing_identity CHECK (provider <> 'shopify' OR
    (shopify_shop IS NOT NULL AND shopify_shop_id IS NOT NULL AND shopify_client_id IS NOT NULL)),
  ADD CONSTRAINT shopify_billing_store UNIQUE (shopify_shop, shopify_client_id);

-- OAuth starts before Datool login. Short-lived browser receipts never contain credentials.
CREATE TABLE shopify_install_intent (
  id uuid PRIMARY KEY,
  client_id text NOT NULL,
  shop text,
  shop_id text,
  project_id text REFERENCES project(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('datool','shopify')),
  start_hash text UNIQUE,
  browser_hash text NOT NULL,
  oauth_state_hash text UNIQUE,
  session_encrypted text,
  claimed_project_id text REFERENCES project(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shopify_install_expiry ON shopify_install_intent(expires_at);
