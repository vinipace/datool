import { createHash } from "node:crypto"
import type Stripe from "stripe"
import type { CheckoutReceipt } from "@/lib/site-analytics"

/** A success query string or active trial is never proof of a purchase. */
export function checkoutReceipt(
  session: Stripe.Checkout.Session,
  organizationId: string,
  plan: "core" | "pro" | null
): CheckoutReceipt | null {
  if (
    !plan ||
    session.client_reference_id !== organizationId ||
    !session.livemode ||
    session.mode !== "subscription" ||
    session.status !== "complete" ||
    session.payment_status !== "paid" ||
    !session.amount_total ||
    session.amount_total <= 0 ||
    session.currency !== "usd"
  )
    return null
  return {
    transaction_id: createHash("sha256").update(session.id).digest("hex"),
    value: session.amount_total / 100,
    currency: "USD",
    plan,
  }
}
