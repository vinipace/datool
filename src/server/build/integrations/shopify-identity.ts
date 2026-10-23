import { sql } from "drizzle-orm"
import type { BuildContext } from "../context"
import { TracerError } from "@/src/server/tracer/errors"

export type ShopifyShopper = {
  shop: string
  customerId: string | null
  // Background reconciliation uses the original operation after browser expiry.
  browserSessionId: string | null
}

/** Resolve only the identity admitted by the channel adapter, never model metadata. */
export async function shopifyShopper(
  context: BuildContext,
  input: {
    connectionId: string
    conversationId: string
    turnId: string
    shop: string
  }
): Promise<ShopifyShopper> {
  const result = await context.database.execute<{
    shop: string
    customer_id: string | null
    browser_session_id: string
  }>(sql`
    SELECT v.shop, v.customer_id, v.id AS browser_session_id
    FROM build_conversation_turns t
    JOIN build_conversations c ON c.project_id=t.project_id AND c.id=t.conversation_id
    JOIN build_channel_job j ON j.project_id=t.project_id AND t.request_key='channel:' || j.id::text
    JOIN build_channel_message m ON m.project_id=j.project_id AND m.id=j.message_id
      AND m.conversation_id=t.conversation_id AND m.connection_id=j.connection_id AND m.direction='inbound'
    JOIN build_shopify_message_identity i ON i.project_id=m.project_id AND i.message_id=m.id
    JOIN build_shopify_visitor_sessions v ON v.project_id=i.project_id AND v.id=i.browser_session_id
      AND v.identity_version=i.identity_version AND v.connection_id=m.connection_id
    JOIN build_channel_connection ch ON ch.project_id=v.project_id AND ch.id=v.connection_id
    JOIN build_shopify_connections s ON s.project_id=v.project_id AND s.shop=v.shop
    JOIN build_app_connections a ON a.project_id=s.project_id AND a.id=s.connection_id
    WHERE t.project_id=${context.projectId} AND t.id=${input.turnId}
      AND t.conversation_id=${input.conversationId} AND c.channel='web'
      AND c.metadata_json->>'visitorId'=v.visitor_id
      AND c.metadata_json->>'connectionId'=v.connection_id::text
      AND ch.agent_id=c.agent_id AND ch.status='connected'
      AND ch.config_json->>'shopifyShop'=v.shop
      AND s.connection_id=${input.connectionId}::uuid AND s.shop=${input.shop}
      AND s.client_id=${process.env.DATOOL_SHOPIFY_CLIENT_ID ?? ""} AND a.status='active'
      AND v.expires_at>now() AND v.verified_at>now()-interval '5 minutes'
    LIMIT 1
  `)
  const row = result.rows[0]
  if (!row)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Reconnect the storefront chat to verify your Shopify session before using this action."
    )
  return {
    shop: row.shop,
    customerId: row.customer_id,
    browserSessionId: row.browser_session_id,
  }
}

export function requireShopifyCustomer(shopper: ShopifyShopper) {
  if (!shopper.customerId || !/^[1-9][0-9]*$/.test(shopper.customerId))
    throw new TracerError(
      "VALIDATION_ERROR",
      "Sign in to your store account to use this action."
    )
  return `gid://shopify/Customer/${shopper.customerId}`
}
