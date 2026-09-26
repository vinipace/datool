import type Stripe from "stripe"
import { executionCredits, type PaidPeriod } from "./ledger"
import { billingConfig, getStripe } from "@/src/server/billing/config"

/** Invoice lines, not event metadata or a browser-selected plan, establish the grant. */
export function paidInvoicePeriod(
  invoice: Stripe.Invoice,
  organizationId: string,
  subscriptionId: string,
  priceId: string,
  currentEnd: number
): PaidPeriod | null {
  const subscription = invoice.parent?.subscription_details?.subscription
  if (
    invoice.status !== "paid" ||
    invoice.amount_paid <= 0 ||
    (typeof subscription === "string" ? subscription : subscription?.id) !==
      subscriptionId ||
    !["subscription_create", "subscription_cycle"].includes(
      invoice.billing_reason ?? ""
    ) ||
    invoice.lines.has_more
  )
    return null
  const lines = invoice.lines.data.filter(
    (line) =>
      line.pricing?.price_details?.price === priceId &&
      line.parent?.subscription_item_details?.proration === false &&
      line.period.end === currentEnd
  )
  if (lines.length !== 1 || lines[0].amount <= 0) return null
  const prices = billingConfig().prices
  const plan =
    priceId === prices.core ? "core" : priceId === prices.pro ? "pro" : null
  if (!plan) return null
  return {
    organizationId,
    subscriptionId,
    invoiceId: invoice.id,
    start: new Date(lines[0].period.start * 1000),
    end: new Date(lines[0].period.end * 1000),
    plan,
  }
}
export async function syncExecutionGrant(
  organizationId: string,
  customerId: string,
  subscriptionId: string,
  priceId: string,
  currentEnd: number
) {
  const invoices = await getStripe().invoices.list({
    customer: customerId,
    subscription: subscriptionId,
    status: "paid",
    limit: 10,
  })
  for (const invoice of invoices.data) {
    const period = paidInvoicePeriod(
      invoice,
      organizationId,
      subscriptionId,
      priceId,
      currentEnd
    )
    if (period) {
      await executionCredits.grant(period)
      return
    }
  }
}
