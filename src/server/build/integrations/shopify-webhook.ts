import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import type { TracerDatabase } from "@/src/server/tracer/db"
import { encryptProviderKey } from "@/src/server/model-providers/secrets"
import { enabledBuildProject } from "../access"
import {
  nativeShopify,
  shopifyConfigured,
  shopifyDomain,
} from "./shopify-provider"

const headers = { "Cache-Control": "no-store" }
const privacyTopics = new Set([
  "CUSTOMERS_DATA_REQUEST",
  "CUSTOMERS_REDACT",
  "SHOP_REDACT",
])
const topics = new Set([
  ...privacyTopics,
  "APP_UNINSTALLED",
  "ORDERS_CREATE",
  "ORDERS_PAID",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "DRAFT_ORDERS_UPDATE",
  "RETURNS_PROCESS",
  "RETURNS_UPDATE",
  "FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE",
])
function gid(value: unknown, type: string) {
  if (
    typeof value === "string" &&
    new RegExp(`^gid://shopify/${type}/[1-9][0-9]*$`).test(value)
  )
    return value
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value))
    return `gid://shopify/${type}/${value}`
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    return `gid://shopify/${type}/${value}`
  return null
}

/** Authenticate exact bytes, persist only a receipt, and wake existing intent.
 * Headers/payload never establish payment, shopper ownership or a new action. */
export async function handleShopifyCommerceWebhook(
  request: Request,
  database: TracerDatabase
) {
  if (!shopifyConfigured())
    return new Response("Shopify is unavailable", { status: 503, headers })
  const reader = request.body?.getReader()
  if (!reader) return new Response("Missing body", { status: 400, headers })
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4 * 1024 * 1024) {
        await reader.cancel()
        return new Response("Body too large", { status: 413, headers })
      }
      chunks.push(value)
    }
    const rawBody = Buffer.concat(chunks).toString("utf8")
    const api = nativeShopify()
    const delivery = await api.webhooks.validate({
      rawBody,
      rawRequest: request,
    })
    if (!delivery.valid)
      return new Response("Invalid webhook", { status: 401, headers })
    if (!topics.has(delivery.topic))
      return new Response(null, { status: 204, headers })
    let payload: Record<string, unknown>, shop: string
    try {
      shop = shopifyDomain(delivery.domain)
      payload = JSON.parse(rawBody)
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw new Error()
    } catch {
      return new Response("Invalid webhook", { status: 400, headers })
    }
    const receipt = createHash("sha256")
      .update(`${delivery.topic}:${delivery.webhookId}`)
      .digest("hex")
    if (privacyTopics.has(delivery.topic)) {
      // Receipt is not fulfillment. Keep requests independent of paid access,
      // installation state and the lifetime of the connected project.
      if (payload.shop_domain !== shop || !gid(payload.shop_id, "Shop"))
        return new Response("Invalid privacy event", { status: 400, headers })
      const id = createHash("sha256")
        .update(`${api.config.apiKey}:${shop}:${receipt}`)
        .digest("hex")
      const encrypted = encryptProviderKey(
        JSON.stringify(payload),
        id,
        `shopify-privacy:${api.config.apiKey}`
      )
      await database.execute(sql`
        INSERT INTO shopify_privacy_requests(id,client_id,shop,topic,payload_encrypted)
        VALUES(${id},${api.config.apiKey},${shop},${delivery.topic},${encrypted}) ON CONFLICT DO NOTHING
      `)
      return new Response(null, { status: 204, headers })
    }
    if (delivery.topic === "APP_UNINSTALLED") {
      const triggeredAt = new Date(
        request.headers.get("x-shopify-triggered-at") ?? ""
      )
      if (
        !Number.isFinite(triggeredAt.getTime()) ||
        payload.myshopify_domain !== shop
      )
        return new Response("Invalid uninstall event", { status: 400, headers })
      await database.transaction(async (tx) => {
        // Lifecycle cleanup also runs for disabled projects and disconnected stores.
        const found = await tx.execute<{
          connection_id: string
          project_id: string
        }>(sql`
          SELECT s.connection_id,s.project_id FROM build_shopify_connections s
          JOIN build_app_connections a ON a.id=s.connection_id AND a.project_id=s.project_id
          WHERE s.shop=${shop} AND s.client_id=${api.config.apiKey}
            AND (s.installed_at IS NULL OR s.installed_at<=${triggeredAt})
          FOR UPDATE OF s,a
        `)
        const target = found.rows[0]
        if (target) {
          const inserted = await tx.execute(sql`
            INSERT INTO build_shopify_webhook_receipts(connection_id,delivery_id)
            VALUES(${target.connection_id}::uuid,${receipt}) ON CONFLICT DO NOTHING RETURNING delivery_id
          `)
          if (!inserted.rowCount) return
          await tx.execute(sql`
            UPDATE build_app_connections SET status='disconnected',updated_at=now()
            WHERE id=${target.connection_id}::uuid AND project_id=${target.project_id}
          `)
          await tx.execute(sql`
            UPDATE build_shopify_connections SET session_encrypted=NULL,start_token_hash=NULL,oauth_state_hash=NULL
            WHERE connection_id=${target.connection_id}::uuid AND project_id=${target.project_id}
          `)
          await tx.execute(sql`
            DELETE FROM build_shopify_visitor_sessions WHERE project_id=${target.project_id} AND shop=${shop}
          `)
        }
        // An unclaimed install can also hold a token. Preserve newer install attempts.
        await tx.execute(sql`
          DELETE FROM shopify_install_intent WHERE shop=${shop} AND client_id=${api.config.apiKey} AND created_at<=${triggeredAt}
        `)
        await tx.execute(sql`
          UPDATE organization_billing SET access_until=NULL,reconcile_after=now()
          WHERE provider='shopify' AND shopify_shop=${shop} AND shopify_client_id=${api.config.apiKey}
            AND NOT EXISTS (
              SELECT 1 FROM build_shopify_connections s WHERE s.shop=${shop}
                AND s.client_id=${api.config.apiKey} AND s.installed_at>${triggeredAt}
            )
        `)
      })
      return new Response(null, { status: 204, headers })
    }
    const draft = delivery.topic === "DRAFT_ORDERS_UPDATE"
    const returned = delivery.topic.startsWith("RETURNS_")
    const routing =
      delivery.topic === "FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE"
    const fulfillment = payload.fulfillment_order as
      { id?: unknown } | undefined
    const externalId = routing
      ? gid(fulfillment?.id, "FulfillmentOrder")
      : gid(
          payload.admin_graphql_api_id ?? payload.id,
          returned ? "Return" : draft ? "DraftOrder" : "Order"
        )
    if (!externalId)
      return new Response("Missing resource ID", { status: 400, headers })
    const tags =
      typeof payload.tags === "string"
        ? payload.tags
            .split(",")
            .slice(0, 250)
            .map((s) => s.trim())
        : []
    const operationIds = tags.flatMap((tag) => {
      const match =
        /^datool-operation-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(
          tag
        )
      return match ? [match[1]] : []
    })
    const taggedOperation = operationIds.length
      ? sql`id::text IN (${sql.join(
          operationIds.map((id) => sql`${id}`),
          sql`,`
        )})`
      : sql`false`
    let matches = sql`order_id=${externalId} OR source_order_id=${externalId} OR (kind='order' AND ${taggedOperation})`
    if (draft)
      matches = sql`kind='order' AND (draft_order_id=${externalId} OR ${taggedOperation})`
    if (returned) matches = sql`kind='return' AND return_id=${externalId}`
    if (routing)
      matches = sql`kind='return' AND quote_json->'settlement'->>'direction'='collect'
      AND (return_hold_plan IS NULL OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(return_hold_plan->'orders') AS held WHERE held->>'id'=${externalId}
      ))`
    await database.transaction(async (tx) => {
      const connection = await tx.execute<{
        connection_id: string
        project_id: string
      }>(sql`
        SELECT s.connection_id,s.project_id FROM build_shopify_connections s
        JOIN build_app_connections a ON a.id=s.connection_id AND a.project_id=s.project_id
        WHERE s.shop=${shop} AND s.client_id=${api.config.apiKey} AND a.status='active'
          AND ${enabledBuildProject(sql`s.project_id`)}
      `)
      const target = connection.rows[0]
      if (!target) return
      const inserted = await tx.execute(sql`
        INSERT INTO build_shopify_webhook_receipts(connection_id,delivery_id)
        VALUES(${target.connection_id}::uuid,${receipt}) ON CONFLICT DO NOTHING RETURNING delivery_id
      `)
      if (!inserted.rowCount) return
      await tx.execute(sql`
        UPDATE build_shopify_order_operations SET reconcile_after=now()
        WHERE project_id=${target.project_id} AND connection_id=${target.connection_id}::uuid AND status <> 'failed'
          AND (${matches})
      `)
      await tx.execute(
        sql`DELETE FROM build_shopify_webhook_receipts WHERE connection_id=${target.connection_id}::uuid AND received_at<now()-interval '7 days'`
      )
    })
    return new Response(null, { status: 204, headers })
  } catch (error) {
    // Admission failure must be retried by Shopify; never log payloads or credentials.
    const failure = error as { code?: string; cause?: { code?: string } }
    const code = String(failure?.cause?.code ?? failure?.code ?? "UNKNOWN")
      .replace(/[^A-Za-z0-9_]/g, "")
      .slice(0, 50)
    console.error(`[shopify-webhook] admission failed (${code})`)
    return new Response("Webhook admission temporarily unavailable", {
      status: 503,
      headers,
    })
  } finally {
    reader.releaseLock()
  }
}
