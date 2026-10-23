import { sql } from "drizzle-orm"
import { z } from "zod"
import type { BuildContext } from "../context"
import { nativeShopify, shopifyDomain, shopifyOrigin } from "./shopify-provider"
import {
  createPublicSession,
  enforcePublicAdmission,
  getChannelConnection,
} from "../channels/service"
import { issueShopifyVisitor } from "../channels/visitor-sessions"

const inputSchema = z.object({
  origin: z.string().url().max(2048).optional(),
  browserToken: z.string().max(2048).optional(),
  conversationId: z.string().uuid().optional(),
  newConversation: z.boolean().optional(),
  challengeToken: z.string().max(2048).optional(),
})

/** Only Shopify's signed proxy can select a customer identity; never Liquid or browser context. */
export async function shopifyStorefrontSession(
  context: BuildContext,
  connectionId: string,
  request: Request,
  body: unknown
) {
  const query = new URL(request.url).searchParams
  const api = nativeShopify()
  if (!(await api.utils.validateHmac(query, { signator: "appProxy" })))
    throw new Error("Invalid Shopify identity.")
  const timestamp = Number(query.get("timestamp"))
  if (
    !Number.isFinite(timestamp) ||
    Math.abs(Date.now() / 1000 - timestamp) > 90
  )
    throw new Error("Expired Shopify identity.")
  const shop = shopifyDomain(query.get("shop") ?? "")
  const customerId = query.get("logged_in_customer_id") ?? ""
  if (customerId && !/^[1-9][0-9]{0,19}$/.test(customerId))
    throw new Error("Invalid Shopify identity.")
  const { connection } = await getChannelConnection(context, connectionId)
  const installed = await context.database.execute(sql`
    SELECT 1 FROM build_shopify_connections s
    JOIN build_app_connections a ON a.id=s.connection_id AND a.project_id=s.project_id
    WHERE s.project_id=${context.projectId} AND s.shop=${shop}
      AND s.client_id=${api.config.apiKey} AND a.status='active'
  `)
  if (
    connection.channel !== "web" ||
    connection.status !== "connected" ||
    connection.config.shopifyShop !== shop ||
    !installed.rows.length
  )
    throw new Error("Shopify chat is unavailable for this store.")
  const input = inputSchema.parse(body)
  const origin = input.origin ?? `https://${shop}`
  const allowedOrigins = Array.isArray(connection.config.originAllowlist)
    ? connection.config.originAllowlist
    : []
  if (
    new URL(origin).origin !== origin ||
    !origin.startsWith("https://") ||
    (origin !== `https://${shop}` && !allowedOrigins.includes(origin))
  )
    throw new Error("Shopify chat is unavailable on this domain.")
  // The signed shop identity does not make forwarded IP headers trustworthy.
  await enforcePublicAdmission(
    context,
    connection,
    input.browserToken ? "feedback" : "session",
    `shopify:${shop}:${input.browserToken ?? "new"}`
  )
  const visitor = await issueShopifyVisitor(context, {
    connectionId,
    shop,
    customerId,
    browserToken: input.browserToken,
    challengeToken: input.challengeToken,
    // The chat iframe calls the API from Datool. Store origin is validated
    // above and by CSP, never inferred from a client-supplied embed header.
    origin: shopifyOrigin(),
  })
  const previous = input.newConversation
    ? null
    : await context.database.execute<{ id: string }>(sql`
    SELECT id FROM build_conversations WHERE project_id=${context.projectId}
      AND metadata_json->>'connectionId'=${connectionId} AND metadata_json->>'visitorId'=${visitor.visitorId}
      AND status='active'
    ORDER BY CASE WHEN id=${input.conversationId ?? ""} THEN 0 ELSE 1 END, updated_at DESC LIMIT 1
  `)
  const session = await createPublicSession(context, connectionId, {
    visitorToken: visitor.visitorToken,
    conversationId: previous?.rows[0]?.id,
    origin: shopifyOrigin(),
    sameOrigin: shopifyOrigin(),
    clientKey: `shopify:${shop}`,
  })
  if (customerId)
    await context.database.execute(sql`
    UPDATE build_contacts SET metadata_json=metadata_json || ${JSON.stringify({ shopify: { shop, customerId, verified: true } })}::jsonb
    WHERE project_id=${context.projectId} AND external_id=${`web:${connectionId}:${visitor.visitorId}`}
  `)
  return { ...session, browserToken: visitor.browserToken }
}
