import { cache } from "react"
import { billingEnabled } from "@/src/server/billing/config"
import { getBilling, hasSubscriptionAccess } from "@/src/server/billing/store"

/** New organizations choose a plan; existing subscriptions keep payment recovery. */
export const getBillingRedirect = cache(async (organizationId: string) => {
  if (!billingEnabled()) return null
  const billing = await getBilling(organizationId)
  if (hasSubscriptionAccess(billing)) return null
  return billing?.subscription_id ? "/billing" : "/pricing"
})
