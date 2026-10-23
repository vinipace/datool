import { sql } from "drizzle-orm"
import type { BuildContext } from "../context"
import { TracerError } from "@/src/server/tracer/errors"

export type ShopifyShopper = {
  shop: string
  customerId: string | null
  // Background reconciliation uses the original operation after browser expiry.
  browserSessionId: string | null
}

type ShopifyIdentityInput = {
  connectionId: string
  conversationId: string
  turnId: string
  shop?: string
}

function unverifiedSession() {
  return new TracerError(
    "VALIDATION_ERROR",
    "Reconnect this chat to verify your session before using this action."
  )
}

/** Resolve only the identity admitted by the channel adapter, never model metadata. */
async function admittedShopifyShopper(
  context: BuildContext,
  input: ShopifyIdentityInput
) {
  const result = await context.database.execute<{
    shop: string
    customer_id: string | null
    browser_session_id: string
    fresh: boolean
  }>(sql`
    SELECT v.shop, v.customer_id, v.id AS browser_session_id,
      (v.expires_at>now() AND v.verified_at>now()-interval '5 minutes') AS fresh
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
      AND s.connection_id=${input.connectionId}::uuid
      AND (${input.shop ?? null}::text IS NULL OR s.shop=${input.shop ?? null})
      AND s.client_id=${process.env.DATOOL_SHOPIFY_CLIENT_ID ?? ""} AND a.status='active'
    LIMIT 1
  `)
  const row = result.rows[0]
  if (row) return row
  // Messaging adapters authenticate the sender when admitting the inbound job.
  // That proves control of this conversation, never ownership of a Shopify account.
  // Web conversations must continue through the signed storefront path above.
  const messaging = await context.database.execute<{
    shop: string
    customer_id: null
    browser_session_id: null
    fresh: boolean
  }>(sql`
    SELECT s.shop, NULL AS customer_id, NULL AS browser_session_id, TRUE AS fresh
    FROM build_conversation_turns t
    JOIN build_conversations c ON c.project_id=t.project_id AND c.id=t.conversation_id
    JOIN build_channel_job j ON j.project_id=t.project_id AND t.request_key='channel:' || j.id::text
      AND j.kind='process_inbound'
    JOIN build_channel_message m ON m.project_id=j.project_id AND m.id=j.message_id
      AND m.conversation_id=c.id AND m.connection_id=j.connection_id AND m.direction='inbound'
    JOIN build_channel_connection ch ON ch.project_id=m.project_id AND ch.id=m.connection_id
      AND ch.channel=c.channel AND ch.agent_id=c.agent_id AND ch.status='connected'
    JOIN build_app_connections a ON a.project_id=c.project_id AND a.id=${input.connectionId}::uuid
      AND a.status='active' AND a.toolkit='shopify_native'
    JOIN build_shopify_connections s ON s.project_id=a.project_id AND s.connection_id=a.id
    WHERE t.project_id=${context.projectId} AND t.id=${input.turnId}
      AND c.id=${input.conversationId} AND c.channel<>'web'
      AND c.metadata_json->>'connectionId'=ch.id::text
      AND (${input.shop ?? null}::text IS NULL OR s.shop=${input.shop ?? null})
      AND s.client_id=${process.env.DATOOL_SHOPIFY_CLIENT_ID ?? ""}
    LIMIT 1
  `)
  if (!messaging.rows[0]) throw unverifiedSession()
  return messaging.rows[0]
}

export async function shopifyShopper(
  context: BuildContext,
  input: ShopifyIdentityInput & { shop: string }
): Promise<ShopifyShopper> {
  const row = await admittedShopifyShopper(context, input)
  if (!row.fresh) throw unverifiedSession()
  return {
    shop: row.shop,
    customerId: row.customer_id,
    browserSessionId: row.browser_session_id,
  }
}

/** Approval may wait for freshness, but cannot outlive its original identity binding. */
export async function shopifyApprovalNeedsVerification(
  context: BuildContext,
  input: ShopifyIdentityInput & { verificationTurnId?: string }
) {
  const source = await admittedShopifyShopper(context, input)
  if (input.verificationTurnId) {
    const current = await admittedShopifyShopper(context, {
      ...input,
      turnId: input.verificationTurnId,
    })
    if (
      current.browser_session_id !== source.browser_session_id ||
      current.customer_id !== source.customer_id ||
      current.shop !== source.shop
    )
      throw unverifiedSession()
    if (!current.fresh) return true
  }
  return !source.fresh
}

export function requireShopifyCustomer(shopper: ShopifyShopper) {
  if (!shopper.customerId || !/^[1-9][0-9]*$/.test(shopper.customerId))
    throw new TracerError(
      "VALIDATION_ERROR",
      "Sign in to your store account to use this action."
    )
  return `gid://shopify/Customer/${shopper.customerId}`
}
