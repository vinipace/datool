-- Order intent must survive a failed tool response. Metering rows deliberately
-- contain neither action arguments nor customer addresses; this is commerce state.
CREATE TABLE build_shopify_order_operations (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  conversation_id text NOT NULL,
  customer_id text,
  browser_session_id uuid REFERENCES build_shopify_visitor_sessions(id) ON DELETE SET NULL,
  quote_json jsonb NOT NULL CHECK (jsonb_typeof(quote_json)='object'),
  settings_json jsonb NOT NULL CHECK (jsonb_typeof(settings_json)='object'),
  status text NOT NULL CHECK (status IN ('pending','draft','checkout_ready','placed','uncertain','needs_review','failed')),
  draft_order_id text,
  order_id text,
  result_json jsonb,
  revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, connection_id) REFERENCES build_app_connections(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, conversation_id) REFERENCES build_conversations(project_id,id) ON DELETE CASCADE
);
CREATE INDEX build_shopify_orders_conversation ON build_shopify_order_operations(project_id,connection_id,conversation_id,created_at DESC);
CREATE UNIQUE INDEX build_shopify_orders_draft ON build_shopify_order_operations(connection_id,draft_order_id) WHERE draft_order_id IS NOT NULL;
CREATE INDEX build_shopify_orders_customer ON build_shopify_order_operations(connection_id,customer_id) WHERE customer_id IS NOT NULL;
