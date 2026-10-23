-- The existing channel worker consumes commerce reconciliation. The operation
-- is the durable source of pending work; webhook bodies are never retained.
ALTER TABLE build_shopify_order_operations ADD COLUMN reconcile_after timestamptz;
UPDATE build_shopify_order_operations SET reconcile_after=now()
WHERE status IN ('pending','draft','checkout_ready','uncertain','return_created','processing')
   OR result_json->>'paymentStatus' IN ('payment_required','payment_pending','refund_pending')
   OR (status='placed' AND result_json->>'financialStatus' IN ('PENDING','PARTIALLY_PAID','AUTHORIZED'));
ALTER TABLE build_shopify_order_operations ALTER COLUMN reconcile_after SET DEFAULT now();
CREATE INDEX build_shopify_reconciliation_due ON build_shopify_order_operations(reconcile_after)
  WHERE reconcile_after IS NOT NULL;

ALTER TABLE build_channel_job DROP CONSTRAINT build_channel_job_kind_check;
ALTER TABLE build_channel_job ADD CONSTRAINT build_channel_job_kind_check
  CHECK (kind IN ('process_inbound','deliver_outbound','telegram_poll','resume_wait','shopify_reconcile'));
CREATE UNIQUE INDEX build_shopify_reconciliation_active ON build_channel_job(project_id,(payload_json->>'operationId'))
  WHERE kind='shopify_reconcile' AND status IN ('queued','running');

CREATE TABLE build_shopify_webhook_receipts (
  connection_id uuid NOT NULL REFERENCES build_shopify_connections(connection_id) ON DELETE CASCADE,
  delivery_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(connection_id,delivery_id)
);
