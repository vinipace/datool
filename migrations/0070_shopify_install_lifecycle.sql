-- Reinstalling must not be undone by an older uninstall delivery.
ALTER TABLE build_shopify_connections ADD COLUMN installed_at timestamptz;

-- Privacy requests must survive uninstall, disabled billing and project deletion.
-- Payloads stay encrypted until an operator fulfills the request and clears them.
CREATE TABLE shopify_privacy_requests (
  id text PRIMARY KEY,
  client_id text NOT NULL,
  shop text,
  topic text NOT NULL CHECK (topic IN ('CUSTOMERS_DATA_REQUEST','CUSTOMERS_REDACT','SHOP_REDACT')),
  payload_encrypted text,
  received_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
  completed_at timestamptz,
  completion_reference text,
  CHECK ((completed_at IS NULL AND payload_encrypted IS NOT NULL AND shop IS NOT NULL AND completion_reference IS NULL)
    OR (completed_at IS NOT NULL AND payload_encrypted IS NULL AND shop IS NULL AND completion_reference IS NOT NULL AND length(completion_reference)>0))
);
CREATE INDEX shopify_privacy_pending ON shopify_privacy_requests(due_at) WHERE completed_at IS NULL;
