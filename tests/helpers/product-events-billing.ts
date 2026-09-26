import assert from "node:assert/strict"
import type Stripe from "stripe"
import { db, analyticsDb } from "../../lib/db"
import { getStripe } from "../../src/server/billing/config"
import { getBilling } from "../../src/server/billing/store"
import { POST } from "../../app/api/billing/webhook/route"

const stripe = getStripe()
const subscriptions = new Map<string, Stripe.Subscription>()
const invoices = new Map<string, Stripe.Invoice[]>()
let invoiceApiFailed = false,
  slackFailed = false
const delivered: { channel: string; text: string }[] = []
const errors: string[] = []
console.error = (...args: unknown[]) => {
  errors.push(args.join(" "))
}
stripe.subscriptions.list = ((params: Stripe.SubscriptionListParams) => ({
  async *[Symbol.asyncIterator]() {
    const subscription = subscriptions.get(params.customer!)
    if (subscription) yield subscription
  },
})) as unknown as typeof stripe.subscriptions.list
stripe.invoices.list = ((params: Stripe.InvoiceListParams) => ({
  async *[Symbol.asyncIterator]() {
    if (invoiceApiFailed) throw new Error("fixture-sensitive-stripe-payload")
    yield* (invoices.get(params.subscription!) ?? []).filter(
      (invoice) => invoice.status === params.status
    )
  },
})) as unknown as typeof stripe.invoices.list
globalThis.fetch = (async (url, options) => {
  assert.equal(
    url,
    "https://slack.com/api/chat.postMessage",
    "No real provider calls in billing fixtures"
  )
  if (slackFailed) return new Response("fixture-secret", { status: 429 })
  delivered.push(JSON.parse(options?.body as string))
  return Response.json({ ok: true, ts: "1.01", channel: "CFIXTURE" })
}) as typeof fetch

async function seed(id: string) {
  await db.query("INSERT INTO organization(id,name,slug) VALUES ($1,$1,$1)", [
    id,
  ])
  await db.query(
    "INSERT INTO organization_billing(organization_id,customer_id,checkout_attempt_id) VALUES ($1,$2,$1)",
    [id, `cus_${id}`]
  )
  const subscription = {
    id: `sub_${id}`,
    customer: `cus_${id}`,
    status: "active",
    created: 100,
    items: {
      data: [
        {
          price: { id: "price_core" },
          current_period_end: Math.floor(Date.now() / 1000) + 86400,
        },
      ],
    },
  } as Stripe.Subscription
  subscriptions.set(`cus_${id}`, subscription)
  return subscription
}
function invoice(id: string, amount = 2900, paidAt = 100): Stripe.Invoice {
  return {
    id,
    status: "paid",
    amount_paid: amount,
    currency: "usd",
    created: paidAt,
    status_transitions: { paid_at: paidAt },
    livemode: false,
  } as Stripe.Invoice
}
async function send(
  id: string,
  organization: string,
  invoice: Stripe.Invoice,
  type = "invoice.paid",
  valid = true
) {
  const body = JSON.stringify({
    id,
    type,
    data: { object: { ...invoice, customer: `cus_${organization}` } },
  })
  const signature = await stripe.webhooks.generateTestHeaderStringAsync({
    payload: body,
    secret: "whsec_fixture",
  })
  return POST(
    new Request("http://localhost:3000/api/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": valid ? signature : "invalid" },
      body,
    })
  )
}

try {
  const paid = await seed("paid")
  const first = invoice("in_first")
  invoices.set(paid.id, [first])
  assert.equal(
    (await send("evt_bad", "paid", first, "invoice.paid", false)).status,
    400
  )
  assert.equal(delivered.length, 0)
  // Concurrent retries and separate Stripe Event objects represent one activation.
  const results = await Promise.all([
    send("evt_paid", "paid", first),
    send("evt_paid", "paid", first),
    send("evt_paid_duplicate", "paid", first),
  ])
  assert(results.every((result) => result.status === 200))
  assert.equal(delivered.length, 1)
  assert(delivered[0].text.includes("Workspace: paid"))
  const renewal = invoice("in_renewal", 2900, 200)
  invoices.set(paid.id, [renewal, first])
  assert.equal((await send("evt_renewal", "paid", renewal)).status, 200)
  assert.equal(
    (await send("evt_updated", "paid", first, "customer.subscription.updated"))
      .status,
    200
  )
  assert.equal(delivered.length, 1)

  const trial = await seed("trial")
  trial.status = "trialing"
  const free = invoice("in_free", 0, 50)
  invoices.set(trial.id, [free])
  assert.equal((await send("evt_trial", "trial", free)).status, 200)
  assert.equal(delivered.length, 1)
  trial.status = "active"
  const conversion = invoice("in_conversion")
  invoices.set(trial.id, [conversion, free])
  assert.equal((await send("evt_conversion", "trial", conversion)).status, 200)
  assert.equal(delivered.length, 2)

  const outage = await seed("outage")
  const outageInvoice = invoice("in_outage")
  invoices.set(outage.id, [outageInvoice])
  invoiceApiFailed = true
  assert.equal((await send("evt_outage", "outage", outageInvoice)).status, 500)
  assert.equal(
    (
      await db.query(
        "SELECT 1 FROM billing_webhook_receipt WHERE event_id='evt_outage'"
      )
    ).rowCount,
    0
  )
  invoiceApiFailed = false
  assert.equal((await send("evt_outage", "outage", outageInvoice)).status, 200)
  assert.equal(delivered.length, 3)

  const failure = await seed("slack_failure")
  const failedInvoice = invoice("in_failed")
  invoices.set(failure.id, [failedInvoice])
  slackFailed = true
  assert.equal(
    (await send("evt_failed", "slack_failure", failedInvoice)).status,
    200
  )
  assert.equal((await getBilling("slack_failure"))?.status, "active")
  slackFailed = false
  assert.equal(
    (await send("evt_failed", "slack_failure", failedInvoice)).status,
    200
  )
  assert.equal(
    delivered.length,
    3,
    "Notifications are best effort; webhook retries must not duplicate them"
  )
  assert(errors.some((error) => error.includes("product_notification_failed")))
  assert(!errors.join("\n").includes("fixture-secret"))
  assert(!errors.join("\n").includes("fixture-sensitive-stripe-payload"))
  console.log(
    "PASS paid activations, trial conversion, renewals, duplicate events, signatures and failure isolation"
  )
} finally {
  await db.end()
  await analyticsDb.end()
}
