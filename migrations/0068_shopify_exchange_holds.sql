-- Snapshot only payment holds observed on the original exchange before payment.
-- Never infer that a later hold belongs to this approved operation.
ALTER TABLE build_shopify_order_operations
  ADD COLUMN return_hold_plan jsonb;
