import { sql } from "drizzle-orm"
import type { TracerDatabase } from "@/src/server/tracer/db"
import type { BuildContext } from "../context"
import { enabledBuildProject } from "../access"
import {
  enqueueOutboundEnvelope,
  type ClaimedChannelJob,
} from "../channels/service"
import { authorizedShopifySession } from "./shopify"
import {
  nativeShopify,
  SHOPIFY_EXCHANGE_FULFILLMENT_SCOPES,
} from "./shopify-provider"
import { ShopifyOperationStore } from "./shopify-operation-store"
import { checkShopifyCheckout } from "./shopify-order-status"
import { reconcileShopifyReturn } from "./shopify-return-reconcile"
import type { ShopifyGraphqlClient } from "./shopify-catalog"
import type { ShopifyShopper } from "./shopify-identity"

/** Coalesce events into the existing worker. Periodic reads also recover missed webhooks. */
export async function enqueueShopifyReconciliationJobs(
  database: TracerDatabase
) {
  const result = await database.execute(sql`
    WITH due AS (
      SELECT o.id,o.project_id,ch.id AS channel_id
      FROM build_shopify_order_operations o
      JOIN build_shopify_connections s ON s.project_id=o.project_id AND s.connection_id=o.connection_id
      JOIN build_app_connections a ON a.project_id=s.project_id AND a.id=s.connection_id
      JOIN build_conversations c ON c.project_id=o.project_id AND c.id=o.conversation_id
      JOIN build_channel_connection ch ON ch.project_id=c.project_id AND ch.id::text=c.metadata_json->>'connectionId'
        AND ch.agent_id=c.agent_id AND ch.channel=c.channel AND ch.config_json->>'shopifyShop'=s.shop
      WHERE o.reconcile_after<=now() AND o.status<>'failed' AND a.status='active'
        AND ch.status='connected' AND ch.channel='web'
        AND s.client_id=${process.env.DATOOL_SHOPIFY_CLIENT_ID ?? ""}
        AND ${enabledBuildProject(sql`o.project_id`)}
        AND NOT EXISTS (SELECT 1 FROM build_channel_job j WHERE j.project_id=o.project_id
          AND j.kind='shopify_reconcile' AND j.payload_json->>'operationId'=o.id::text
          AND j.status IN ('queued','running'))
      ORDER BY o.reconcile_after,o.id FOR UPDATE OF o SKIP LOCKED LIMIT 50
    ), claimed AS (
      UPDATE build_shopify_order_operations o SET reconcile_after=now()+interval '5 minutes'
      FROM due WHERE o.id=due.id RETURNING o.id,o.project_id,due.channel_id
    )
    INSERT INTO build_channel_job(id,project_id,connection_id,kind,payload_json,idempotency_key)
    SELECT gen_random_uuid(),project_id,channel_id,'shopify_reconcile',jsonb_build_object('operationId',id),
      'shopify-reconcile:' || id::text || ':' || gen_random_uuid()::text FROM claimed
    ON CONFLICT DO NOTHING RETURNING id
  `)
  return result.rowCount ?? 0
}

type Operation = {
  connection_id: string
  conversation_id: string
  customer_id: string | null
  browser_session_id: string | null
  kind: "order" | "return"
  shop: string
  external_conversation_id: string
  contact_id: string | null
  reconcile_after: string | null
}

/** Internal worker entry: payload selects only a saved operation, never a customer or amount. */
export async function processShopifyReconciliation(
  context: BuildContext,
  job: ClaimedChannelJob,
  assertLease: () => Promise<void>
) {
  const operationId = job.payload.operationId
  if (
    job.kind !== "shopify_reconcile" ||
    typeof operationId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(operationId)
  )
    throw new Error("Invalid Shopify reconciliation job.")
  const load = async () => {
    await assertLease()
    const rows = await context.database.execute<Operation>(sql`
      SELECT o.connection_id,o.conversation_id,o.customer_id,o.browser_session_id,o.kind,
        o.reconcile_after::text,s.shop,c.external_conversation_id,c.metadata_json->>'contactId' AS contact_id
      FROM build_shopify_order_operations o
      JOIN build_shopify_connections s ON s.project_id=o.project_id AND s.connection_id=o.connection_id
      JOIN build_app_connections a ON a.project_id=s.project_id AND a.id=s.connection_id
      JOIN build_conversations c ON c.project_id=o.project_id AND c.id=o.conversation_id
      JOIN build_channel_connection ch ON ch.project_id=c.project_id AND ch.id=${job.connectionId}::uuid
        AND ch.id::text=c.metadata_json->>'connectionId' AND ch.agent_id=c.agent_id
        AND ch.channel=c.channel AND ch.config_json->>'shopifyShop'=s.shop
      WHERE o.project_id=${context.projectId} AND o.id=${operationId}::uuid AND o.status<>'failed'
        AND ch.channel='web' AND ch.status='connected' AND a.status='active'
        AND s.client_id=${process.env.DATOOL_SHOPIFY_CLIENT_ID ?? ""}
        AND ${enabledBuildProject(sql`o.project_id`)}
    `)
    return rows.rows[0]
  }
  const row = await load()
  if (!row) return { ignored: true }
  const session = await authorizedShopifySession(context, row.connection_id)
  if (session.shop !== row.shop) throw new Error("Shopify store changed.")
  const client = new (nativeShopify().clients.Graphql)({ session })
  const graphql: ShopifyGraphqlClient = async (query, options) => {
    await assertLease()
    return Response.json(
      await client.request(query, { variables: options?.variables, retries: 0 })
    )
  }
  // Browser expiry does not revoke a previously approved exchange. The provider
  // still verifies the original buyer and items before any hold release. No new
  // refund, order, invoice or customer action can be initiated by this worker.
  const shopper: ShopifyShopper = {
    shop: row.shop,
    customerId: row.customer_id,
    browserSessionId: row.browser_session_id,
  }
  const operations = new ShopifyOperationStore(
    context,
    row.connection_id,
    row.conversation_id,
    shopper
  )
  const beforeWrite = async () => {
    const current = await load()
    if (
      !current ||
      current.connection_id !== row.connection_id ||
      current.customer_id !== row.customer_id
    )
      throw new Error("Shopify operation is no longer authorized.")
    await authorizedShopifySession(context, row.connection_id)
  }
  const result =
    row.kind === "return"
      ? await reconcileShopifyReturn(
          { operationId },
          shopper,
          operations,
          graphql,
          SHOPIFY_EXCHANGE_FULFILLMENT_SCOPES.some((scope) =>
            session.isScopeIncluded([scope])
          ),
          beforeWrite
        )
      : await checkShopifyCheckout({ operationId }, operations, graphql)
  await beforeWrite()
  let payment: string | null = null
  if ("paymentStatus" in result && typeof result.paymentStatus === "string")
    payment = result.paymentStatus
  else if (
    "paid" in result &&
    result.paid === true &&
    result.status === "order_created"
  )
    payment = "paid"
  const fulfillment =
    "fulfillmentStatus" in result ? result.fulfillmentStatus : null
  let milestone: string | null = null
  if (fulfillment === "payment_holds_cleared") milestone = fulfillment
  else if (payment === "refunded") milestone = payment
  else if (
    payment === "paid" &&
    (fulfillment === null || fulfillment === "permission_required")
  )
    milestone = payment
  if (milestone) {
    await enqueueOutboundEnvelope(
      context,
      {
        connectionId: job.connectionId,
        conversationId: row.conversation_id,
        contactId: row.contact_id ?? undefined,
        channel: "web",
        idempotencyKey: `shopify:${operationId}:${milestone}`,
        text: result.message,
        metadata: {
          shopifyOperationId: operationId,
          source: "shopify_reconciliation",
        },
      },
      row.external_conversation_id,
      { recordRuntimeMessage: true }
    )
  }
  await assertLease()
  const pending =
    result.status === "processing" ||
    result.status === "checkout_ready" ||
    ["payment_required", "payment_pending", "refund_pending"].includes(
      payment ?? ""
    ) ||
    fulfillment === "routing_pending" ||
    fulfillment === "payment_pending" ||
    (result.status === "order_created" &&
      "financialStatus" in result &&
      ["PENDING", "PARTIALLY_PAID", "AUTHORIZED"].includes(
        String(result.financialStatus)
      ))
  // A newer webhook remains due even when it arrives during a provider read.
  await context.database.execute(sql`
    UPDATE build_shopify_order_operations SET reconcile_after=${pending ? sql`now()+interval '5 minutes'` : sql`NULL`}
    WHERE project_id=${context.projectId} AND id=${operationId}::uuid
      AND reconcile_after IS NOT DISTINCT FROM ${row.reconcile_after}::timestamptz
  `)
  return { status: result.status, milestone }
}
