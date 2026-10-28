import { expect, test } from "bun:test"
import type Stripe from "stripe"
import { checkoutReceipt } from "../src/server/billing/analytics"

const paid = {
  id: "cs_live_private",
  client_reference_id: "own-org",
  livemode: true,
  mode: "subscription",
  status: "complete",
  payment_status: "paid",
  amount_total: 2900,
  currency: "usd",
  customer_details: { email: "private@example.com" },
} as Stripe.Checkout.Session

test("only a paid, completed live checkout owned by this organization is a purchase", () => {
  const receipt = checkoutReceipt(paid, "own-org", "core")!
  expect(/^[a-f0-9]{64}$/.test(receipt.transaction_id)).toBe(true)
  expect({ ...receipt, transaction_id: "redacted" }).toEqual({
    transaction_id: "redacted",
    value: 29,
    currency: "USD",
    plan: "core",
  })
  expect(checkoutReceipt(paid, "another-org", "core")).toBeNull()
  expect(checkoutReceipt(paid, "own-org", null)).toBeNull()
  for (const changes of [
    { status: "open" },
    { payment_status: "unpaid" },
    { payment_status: "no_payment_required", amount_total: 0 },
    { livemode: false },
    { mode: "setup" },
    { currency: "brl" },
  ]) {
    expect(
      checkoutReceipt(
        { ...paid, ...changes } as Stripe.Checkout.Session,
        "own-org",
        "core"
      )
    ).toBeNull()
  }
})
