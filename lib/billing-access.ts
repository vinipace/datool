import { cache } from "react"
import { billingEnabled } from "@/src/server/billing/config"
import { getBilling, hasSubscriptionAccess } from "@/src/server/billing/store"

/** New organizations choose a plan; existing subscriptions keep payment recovery. */
export const getBillingRedirect = cache(async (organizationId: string) => {
  if (!billingEnabled()) return null
  // Keep the recovery page reachable during a payment-provider outage.
  const billing = await getBilling(organizationId).catch(() => undefined)
  if (billing === undefined) return "/billing"
  if (hasSubscriptionAccess(billing)) return null
  return billing?.provider === "shopify" || billing?.subscription_id
    ? "/billing"
    : "/pricing"
})
