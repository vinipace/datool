CREATE TABLE organization_billing (
  organization_id text PRIMARY KEY REFERENCES organization(id) ON DELETE RESTRICT,
  customer_id text UNIQUE,
  subscription_id text UNIQUE,
  price_id text,
  status text NOT NULL DEFAULT 'none',
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  synced_at timestamptz,
  checkout_session_id text,
  checkout_attempt_id text NOT NULL,
  checkout_price_id text,
  checkout_parameters jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A receipt is written only after subscription state has been synchronized.
CREATE TABLE billing_webhook_receipt (
  event_id text PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);
