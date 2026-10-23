-- A recorded processing attempt is never replayed. Existing/legacy rows default
-- to unknown (true); only the new admission path can establish never-started.
ALTER TABLE build_shopify_order_operations
  ADD COLUMN return_process_started boolean NOT NULL DEFAULT true;
