import type { Session } from "@shopify/shopify-api"
import { nativeShopify, shopifyOrigin } from "./shopify-provider"

const commerceTopics: [string, string[]][] = [
  ["ORDERS_CREATE", ["read_orders"]],
  ["ORDERS_PAID", ["read_orders"]],
  ["ORDERS_UPDATED", ["read_orders"]],
  ["ORDERS_CANCELLED", ["read_orders"]],
  ["DRAFT_ORDERS_UPDATE", ["read_draft_orders"]],
  ["RETURNS_PROCESS", ["read_returns"]],
  ["RETURNS_UPDATE", ["read_returns"]],
  [
    "FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE",
    [
      "read_merchant_managed_fulfillment_orders",
      "read_third_party_fulfillment_orders",
    ],
  ],
]

/** Legacy OAuth apps register store subscriptions after each authorization.
 * Privacy compliance subscriptions belong to the released app configuration.
 * Keep unrelated subscriptions and reuse existing ones on reconnect/reinstall. */
export async function registerShopifySubscriptions(
  api: ReturnType<typeof nativeShopify>,
  session: Session
) {
  const uri = `${shopifyOrigin()}/api/shopify/webhooks/commerce`
  const pending = new Set([
    "APP_UNINSTALLED",
    ...commerceTopics
      .filter(([, scopes]) =>
        scopes.some((scope) => session.isScopeIncluded(scope))
      )
      .map(([topic]) => topic),
  ])
  const client = new api.clients.Graphql({ session })
  let cursor: string | null = null
  do {
    const response = await client.request<{
      webhookSubscriptions: {
        nodes: { topic: string; uri: string }[]
        pageInfo: { endCursor: string | null; hasNextPage: boolean }
      }
    }>(
      `query DatoolWebhookSubscriptions($cursor: String) {
      webhookSubscriptions(first: 100, after: $cursor) {
        nodes { topic uri }
        pageInfo { endCursor hasNextPage }
      }
    }`,
      { variables: { cursor }, retries: 0 }
    )
    const subscriptions = response.data?.webhookSubscriptions
    if (!subscriptions) throw new Error("Shopify webhook registration failed")
    for (const subscription of subscriptions.nodes)
      if (subscription.uri === uri) pending.delete(subscription.topic)
    const next: { endCursor: string | null; hasNextPage: boolean } =
      subscriptions.pageInfo
    if (next.hasNextPage && (!next.endCursor || next.endCursor === cursor))
      throw new Error("Shopify webhook registration failed")
    cursor = next.hasNextPage ? next.endCursor : null
  } while (cursor)
  for (const topic of pending) {
    const response = await client.request<{
      webhookSubscriptionCreate: {
        webhookSubscription: { id: string } | null
        userErrors: { message: string }[]
      }
    }>(
      `mutation DatoolWebhookCreate($topic: WebhookSubscriptionTopic!, $subscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $subscription) {
        webhookSubscription { id }
        userErrors { message }
      }
    }`,
      {
        variables: { topic, subscription: { uri, format: "JSON" } },
        retries: 0,
      }
    )
    const result = response.data?.webhookSubscriptionCreate
    if (!result?.webhookSubscription?.id || result.userErrors.length)
      throw new Error("Shopify webhook registration failed")
  }
}
