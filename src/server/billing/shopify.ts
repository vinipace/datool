import type { PoolClient } from "pg"
import { z } from "zod"
import { planEntitlements, type CloudPlan } from "@/src/lib/billing"
import { shopifyDomain } from "@/src/server/build/integrations/shopify-provider"
import type { BillingRow } from "./store"
import {
  executionCredits,
  type SubscriptionCreditPeriod,
} from "@/src/server/execution-credits/ledger"

export function shopifyBillingConfig() {
  const organization = process.env.DATOOL_SHOPIFY_PARTNER_ORGANIZATION_ID ?? ""
  const token = process.env.DATOOL_SHOPIFY_PARTNER_ACCESS_TOKEN ?? ""
  const appId = process.env.DATOOL_SHOPIFY_APP_ID ?? ""
  const handle = process.env.DATOOL_SHOPIFY_APP_HANDLE ?? ""
  const clientId = process.env.DATOOL_SHOPIFY_CLIENT_ID ?? ""
  if (
    !/^\d+$/.test(organization) ||
    !/^\d+$/.test(appId) ||
    !/^[a-z0-9][a-z0-9-]*$/.test(handle) ||
    !token ||
    !clientId
  )
    throw new Error("Shopify billing is not configured.")
  const handles = {
    core: process.env.DATOOL_SHOPIFY_CORE_PLAN_HANDLE ?? "core",
    pro: process.env.DATOOL_SHOPIFY_PRO_PLAN_HANDLE ?? "pro",
  }
  if (!handles.core || !handles.pro || handles.core === handles.pro)
    throw new Error("Shopify plans require distinct handles.")
  return {
    organization,
    token,
    appId: `gid://shopify/App/${appId}`,
    handle,
    clientId,
    handles,
  }
}

export function shopifyPricingUrl(shop: string) {
  const { handle } = shopifyBillingConfig()
  return `https://admin.shopify.com/store/${shopifyDomain(shop).replace(/\.myshopify\.com$/, "")}/charges/${handle}/pricing_plans`
}

const subscriptionQuery = `query DatoolSubscription($appId: ID!, $shopId: ID!) {
  activeSubscription(appId: $appId, shopId: $shopId) {
    billingPeriod cancelAtEndOfCycle trialEndsAt
    currentBillingCycle { startTime endTime }
    items { handle price { __typename active currency ... on FlatRatePrice { amount } } }
  }
}`
const subscriptionSchema = z
  .object({
    billingPeriod: z.string(),
    cancelAtEndOfCycle: z.boolean(),
    trialEndsAt: z.iso.datetime({ offset: true }).nullable(),
    currentBillingCycle: z
      .object({
        startTime: z.iso.datetime({ offset: true }),
        endTime: z.iso.datetime({ offset: true }),
      })
      .nullable(),
    items: z.array(
      z.object({
        handle: z.string().nullable(),
        price: z.object({
          __typename: z.string(),
          active: z.boolean(),
          currency: z.string(),
          amount: z.string().optional(),
        }),
      })
    ),
  })
  .nullable()

async function activeSubscription(
  client: PoolClient,
  config: ReturnType<typeof shopifyBillingConfig>,
  shopId: string
) {
  // The Partner API allows four requests per second per client. Share this
  // limiter across web/worker processes and fail transiently instead of queuing
  // an unbounded number of database connections during provider outages.
  const lock = await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock(hashtext('datool-shopify-partner'), hashtext($1)) AS acquired",
    [config.organization]
  )
  if (!lock.rows[0].acquired)
    throw new Error("Shopify verification is busy. Try again shortly.")
  try {
    const response = await fetch(
      `https://partners.shopify.com/${config.organization}/api/2026-10/graphql.json`,
      {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": config.token,
        },
        body: JSON.stringify({
          query: subscriptionQuery,
          variables: { appId: config.appId, shopId: shopId },
        }),
      }
    )
    if (!response.ok)
      throw new Error("Shopify subscription verification failed.")
    const payload = await response.json()
    if (
      payload.errors?.length ||
      !payload.data ||
      !("activeSubscription" in payload.data)
    )
      throw new Error("Shopify subscription verification failed.")
    return subscriptionSchema.parse(payload.data.activeSubscription)
  } finally {
    try {
      await client.query("SELECT pg_sleep(0.26)")
    } finally {
      await client.query(
        "SELECT pg_advisory_unlock(hashtext('datool-shopify-partner'), hashtext($1))",
        [config.organization]
      )
    }
  }
}

/** The Partner API is authoritative. Never trust plan_handle on the return URL,
 * or interpret an HTTP/GraphQL failure as a canceled subscription. */
export async function syncShopifyBilling(client: PoolClient, row: BillingRow) {
  const config = shopifyBillingConfig()
  if (
    row.provider !== "shopify" ||
    row.shopify_client_id !== config.clientId ||
    !/^gid:\/\/shopify\/Shop\/\d+$/.test(row.shopify_shop_id ?? "")
  )
    throw new Error("Shopify billing identity is unavailable.")
  const subscription = await activeSubscription(
    client,
    config,
    row.shopify_shop_id!
  )
  let plan: CloudPlan | null = null
  let end: Date | null = null
  let trial = false
  let credits: SubscriptionCreditPeriod | null = null
  const subscriptionId = `shopify:${config.appId}:${row.shopify_shop_id}`
  if (subscription) {
    // The active contract grants access. price.active only says whether that
    // catalog price is current; grandfathered and no-charge test prices may be
    // inactive while their subscription remains active.
    const matches = subscription.items.filter(
      (item) =>
        item.price.__typename === "FlatRatePrice" &&
        Object.values(config.handles).includes(item.handle ?? "")
    )
    if (matches.length !== 1)
      throw new Error("Shopify subscription plan is not recognized.")
    plan = matches[0].handle === config.handles.core ? "core" : "pro"
    trial =
      !!subscription.trialEndsAt &&
      Date.parse(subscription.trialEndsAt) > Date.now()
    end = trial
      ? new Date(subscription.trialEndsAt!)
      : subscription.currentBillingCycle
        ? new Date(subscription.currentBillingCycle.endTime)
        : null
    if (!end || end.getTime() <= Date.now())
      throw new Error("Shopify billing period is unavailable.")
    const cycle = subscription.currentBillingCycle
    const price = matches[0].price
    // Shopify's active contract grants service before merchant payout. Never fund
    // trials or zero-price developer plans. One monthly cycle earns one allowance;
    // upgrades/reinstalls within that cycle cannot mint another grant.
    if (
      !trial &&
      cycle &&
      price.currency === "USD" &&
      Number(price.amount) > 0
    ) {
      const start = new Date(cycle.startTime)
      if (
        start.getTime() > Date.now() ||
        end.getTime() - start.getTime() > 32 * 86400_000 ||
        start >= end
      )
        throw new Error("Shopify monthly billing cycle is unavailable.")
      credits = {
        organizationId: row.organization_id,
        subscriptionId,
        invoiceId: `${subscriptionId}:${start.toISOString()}`,
        start,
        end,
        plan,
      }
    }
  }
  const entitlement = plan ? planEntitlements(plan) : null
  const { rows } = await client.query<BillingRow>(
    `UPDATE organization_billing SET status=$2, plan=$3, current_period_end=$4, subscription_id=$8,
      cancel_at_period_end=$5, record_limit=$6, retention_days=COALESCE($7,retention_days),
      access_until=CASE WHEN $4::timestamptz IS NULL THEN NULL ELSE LEAST($4::timestamptz,now()+interval '5 minutes') END,
      synced_at=now(), reconcile_after=now()+interval '4 minutes', reconcile_failures=0,
      grace_until=NULL, next_payment_attempt=NULL
     WHERE organization_id=$1 AND provider='shopify' RETURNING *`,
    [
      row.organization_id,
      subscription ? (trial ? "trialing" : "active") : "none",
      plan,
      end,
      subscription?.cancelAtEndOfCycle ?? false,
      entitlement?.monthlyRecords ?? 0,
      entitlement?.retentionDays ?? null,
      subscriptionId,
    ]
  )
  if (credits) await executionCredits.grant(credits)
  return rows[0]
}
