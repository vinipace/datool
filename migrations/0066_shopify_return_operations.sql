-- Reuse the commerce ledger. Return admission is serialized by the original
-- order across conversations; provider calls never hold a database transaction.
ALTER TABLE build_shopify_order_operations
  ADD COLUMN kind text NOT NULL DEFAULT 'order' CHECK (kind IN ('order','return')),
  ADD COLUMN source_order_id text,
  ADD COLUMN return_id text,
  DROP CONSTRAINT build_shopify_order_operations_status_check,
  ADD CONSTRAINT build_shopify_order_operations_status_check CHECK (
    status IN ('pending','draft','checkout_ready','placed','uncertain','needs_review','failed','return_created','processing','return_processed')
  ),
  ADD CONSTRAINT build_shopify_return_source CHECK (kind <> 'return' OR source_order_id IS NOT NULL);
CREATE INDEX build_shopify_return_order ON build_shopify_order_operations(project_id,connection_id,source_order_id) WHERE kind='return';
CREATE UNIQUE INDEX build_shopify_return_external ON build_shopify_order_operations(connection_id,return_id) WHERE return_id IS NOT NULL;
