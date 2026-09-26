import Stripe from "stripe"
import { authBaseUrl } from "@/src/server/auth/config"

export type BillingPlan = "core" | "pro"
export const billingEnabled = () =>
  process.env.DATOOL_BILLING_ENABLED === "true"

export function billingConfig() {
  if (!billingEnabled()) throw new Error("Cloud billing is disabled.")
  const secretKey = process.env.STRIPE_SECRET_KEY
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  const prices = {
    core: process.env.STRIPE_CORE_PRICE_ID,
    pro: process.env.STRIPE_PRO_PRICE_ID,
  }
  if (!secretKey || !webhookSecret || !prices.core || !prices.pro)
    throw new Error(
      "Cloud billing requires a Stripe key, webhook secret, and Core/Pro price IDs."
    )
  if (prices.core === prices.pro)
    throw new Error("Core and Pro require distinct Stripe price IDs.")
  const trialDays = Number(process.env.DATOOL_BILLING_TRIAL_DAYS ?? "0")
  if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 30)
    throw new Error(
      "DATOOL_BILLING_TRIAL_DAYS must be an integer from 0 to 30."
    )
  return {
    secretKey,
    webhookSecret,
    prices: prices as Record<BillingPlan, string>,
    trialDays,
    origin: authBaseUrl(),
  }
}

let client: { key: string; stripe: Stripe } | undefined
export function getStripe() {
  const { secretKey } = billingConfig()
  if (client?.key !== secretKey)
    client = {
      key: secretKey,
      stripe: new Stripe(secretKey, { timeout: 10_000, maxNetworkRetries: 1 }),
    }
  return client.stripe
}

export async function cloudPrice(plan: BillingPlan) {
  const price = await getStripe().prices.retrieve(billingConfig().prices[plan])
  if (
    !price.active ||
    price.currency !== "usd" ||
    price.type !== "recurring" ||
    price.recurring?.interval !== "month" ||
    price.recurring.interval_count !== 1 ||
    price.recurring.usage_type !== "licensed" ||
    price.billing_scheme !== "per_unit" ||
    price.unit_amount === null ||
    price.unit_amount <= 0
  )
    throw new Error("Cloud requires an active, fixed monthly USD price.")
  return {
    amount: price.unit_amount,
    currency: price.currency,
    trialDays: billingConfig().trialDays,
  }
}
