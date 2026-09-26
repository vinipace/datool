import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import type Stripe from "stripe"
import { db, analyticsDb } from "../../lib/db"
import { getStripe } from "../../src/server/billing/config"
import {
  getBilling,
  processBillingEvent,
  reconcileBillingOrganization,
} from "../../src/server/billing/store"
import {
  reconcileCloudBilling,
  startBillingReconciliationWorker,
} from "../../src/server/billing/reconciliation"
import { getSystemOrganization } from "../../cms/system-data"

const stripe = getStripe()
const subscriptions = new Map<string, Stripe.Subscription[]>()
const failing = new Set<string>()
const calls = new Map<string, number>()
const gates = new Map<string, Promise<void>>()
const logs: { level: string; message: string }[] = []
const original = {
  info: console.info,
  warn: console.warn,
  error: console.error,
}
for (const level of ["info", "warn", "error"] as const)
  console[level] = (...args: unknown[]) =>
    logs.push({ level, message: args.join(" ") })

// Replace only the external Stripe boundary. Real PostgreSQL queries, advisory
// locks, persistence, CMS reads, and the actual worker timer remain in use.
stripe.subscriptions.list = ((params: Stripe.SubscriptionListParams) => ({
  async *[Symbol.asyncIterator]() {
    const customer = params.customer!
    calls.set(customer, (calls.get(customer) ?? 0) + 1)
    await gates.get(customer)
    if (failing.has(customer))
      throw new Error("fixture-sensitive-provider-payload")
    yield* subscriptions.get(customer) ?? []
  },
})) as unknown as typeof stripe.subscriptions.list
stripe.invoices.list = (() => ({
  async *[Symbol.asyncIterator]() {},
})) as unknown as typeof stripe.invoices.list

function subscription(
  id: string,
  status: Stripe.Subscription.Status = "active",
  plan = "core"
) {
  return {
    id: `sub_${id}`,
    customer: `cus_${id}`,
    status,
    created: Math.floor(Date.now() / 1000),
    cancel_at_period_end: false,
    items: {
      data: [
        {
          price: { id: `price_${plan}` },
          current_period_end: Math.floor(Date.now() / 1000) + 86400,
        },
      ],
    },
  } as Stripe.Subscription
}
async function seed(id: string, customer: string | null = `cus_${id}`) {
  await db.query("INSERT INTO organization(id,name,slug) VALUES ($1,$1,$1)", [
    id,
  ])
  // Due on both hosts even when the database clock is milliseconds ahead.
  await db.query(
    `INSERT INTO organization_billing(organization_id,customer_id,checkout_attempt_id,status,plan,price_id,synced_at,reconcile_after)
    VALUES ($1,$2,$1,'active','core','price_core','2020-01-01',now()-interval '1 minute')`,
    [id, customer]
  )
  subscriptions.set(`cus_${id}`, [subscription(id)])
}
const row = async (id: string) =>
  (
    await db.query(
      "SELECT * FROM organization_billing WHERE organization_id=$1",
      [id]
    )
  ).rows[0]
const due = (id: string) =>
  db.query(
    "UPDATE organization_billing SET reconcile_after=now()-interval '1 second' WHERE organization_id=$1",
    [id]
  )
async function until(check: () => Promise<boolean>, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(20)
  }
  throw new Error("Reconciliation did not reach the expected persisted state")
}
let stop = async () => {}
try {
  await seed("missed")
  await seed("unlinked", null)
  await seed("fresh")
  await db.query(
    "UPDATE organization_billing SET reconcile_after=now()+interval '1 hour' WHERE organization_id='fresh'"
  )
  subscriptions.set("cus_missed", [subscription("missed", "canceled")])
  assert.equal((await reconcileCloudBilling()).synced, 1)
  const canceled = await row("missed")
  assert.equal(canceled.status, "canceled")
  assert.equal(canceled.access_until, null)
  assert.ok(canceled.reconcile_after.getTime() - Date.now() > 890_000)
  assert.equal(calls.has("cus_unlinked"), false)
  assert.equal(calls.has("cus_fresh"), false)
  assert.equal((await reconcileCloudBilling()).scanned, 0)
  assert.equal(
    (
      await getSystemOrganization(
        { collection: "cms-users", authUserId: "reconciliation-admin" },
        "missed",
        db
      )
    )?.organization.status,
    "canceled"
  )

  subscriptions.set("cus_missed", [subscription("missed", "active", "pro")])
  await due("missed")
  await reconcileCloudBilling()
  assert.equal((await row("missed")).record_limit, 1_000_000)
  subscriptions.set("cus_missed", [])
  await due("missed")
  await reconcileCloudBilling()
  assert.equal((await row("missed")).status, "none")
  assert.equal((await row("missed")).subscription_id, null)

  await seed("failure")
  failing.add("cus_failure")
  const before = await row("failure")
  for (const [index, seconds] of [60, 120, 240, 480, 900, 900].entries()) {
    await due("failure")
    assert.equal((await reconcileCloudBilling()).failed, 1)
    const failed = await row("failure")
    assert.equal(failed.reconcile_failures, index + 1)
    assert.ok(
      Math.abs(failed.reconcile_after.getTime() - Date.now() - seconds * 1000) <
        3000
    )
    assert.equal(failed.synced_at.toISOString(), before.synced_at.toISOString())
    assert.equal(failed.status, before.status)
    assert.equal(failed.price_id, before.price_id)
    assert.equal(
      (await reconcileCloudBilling()).scanned,
      0,
      "Retries respect the persisted due time"
    )
  }
  assert.ok(
    logs.some(
      (entry) =>
        entry.level === "error" &&
        entry.message.includes('"consecutiveFailures":3')
    )
  )
  assert.ok(
    logs
      .filter((entry) => entry.message.includes('"requiresAttention":false'))
      .every((entry) => entry.level === "info")
  )
  assert.equal(
    logs.some((entry) =>
      entry.message.includes("fixture-sensitive-provider-payload")
    ),
    false
  )
  failing.delete("cus_failure")
  // A webhook can recover before the scheduled retry and resets its failure state.
  await processBillingEvent({
    id: "evt_recovery",
    type: "customer.subscription.updated",
    data: { object: { customer: "cus_failure" } },
  } as Stripe.Event)
  assert.equal((await row("failure")).reconcile_failures, 0)
  assert.ok(
    logs.some((entry) =>
      entry.message.includes("billing_reconciliation_recovered")
    )
  )
  assert.equal((await reconcileCloudBilling()).scanned, 0)

  // Failed organizations do not block healthy neighbors or keep the first page
  // due forever. Repeated bounded sweeps drain the backlog without duplicates.
  for (let index = 0; index < 5; index++) await seed(`batch-${index}`)
  failing.add("cus_batch-0")
  const batchResults = []
  for (let index = 0; index < 3; index++)
    batchResults.push(await reconcileCloudBilling({ batchSize: 2 }))
  assert.deepEqual(
    batchResults.map((result) => result.scanned),
    [2, 2, 1]
  )
  assert.equal(
    batchResults.reduce((sum, result) => sum + result.synced, 0),
    4
  )
  assert.equal(
    batchResults.reduce((sum, result) => sum + result.failed, 0),
    1
  )
  await assert.rejects(reconcileCloudBilling({ batchSize: 101 }), /1–100/)
  // Clear the intentional failure so it cannot become due during the timer test.
  failing.delete("cus_batch-0")
  await getBilling("batch-0", true)

  await seed("locked")
  const blocker = await db.connect()
  try {
    await blocker.query(
      "SELECT pg_advisory_lock(hashtext('datool-billing'),hashtext('locked'))"
    )
    assert.equal(await reconcileBillingOrganization("locked"), undefined)
    assert.equal(calls.has("cus_locked"), false)
  } finally {
    await blocker.query(
      "SELECT pg_advisory_unlock(hashtext('datool-billing'),hashtext('locked'))"
    )
    blocker.release()
  }
  let release!: () => void
  gates.set(
    "cus_locked",
    new Promise<void>((resolve) => {
      release = resolve
    })
  )
  const first = reconcileBillingOrganization("locked")
  await until(async () => calls.get("cus_locked") === 1)
  assert.equal(await reconcileBillingOrganization("locked"), undefined)
  release()
  assert.equal((await first)?.status, "synced")
  gates.delete("cus_locked")
  assert.equal(await reconcileBillingOrganization("locked"), undefined)
  assert.equal(calls.get("cus_locked"), 1)
  assert.equal(
    await reconcileBillingOrganization("missing-organization"),
    undefined
  )
  assert.equal(
    (
      await db.query(
        "SELECT 1 FROM organization_billing WHERE organization_id='missing-organization'"
      )
    ).rowCount,
    0
  )

  await due("locked")
  stop = startBillingReconciliationWorker()
  await until(
    async () => (await row("locked")).reconcile_after.getTime() > Date.now()
  )
  await stop()
  assert.equal(calls.get("cus_locked"), 2, "Worker catches up on startup")
  stop = startBillingReconciliationWorker()
  await delay(50)
  assert.equal(
    calls.get("cus_locked"),
    2,
    "Restart preserves the saved schedule"
  )
  subscriptions.set("cus_locked", [subscription("locked", "canceled")])
  await due("locked")
  // Exercise the production one-minute poll, rather than a mocked timer.
  await until(async () => (await row("locked")).status === "canceled", 65_000)
  await stop()
  assert.equal(calls.get("cus_locked"), 3)

  // Shutdown drains the in-flight organization and leaves later work persisted.
  await seed("shutdown-a")
  await seed("shutdown-b")
  gates.set(
    "cus_shutdown-a",
    new Promise<void>((resolve) => {
      release = resolve
    })
  )
  stop = startBillingReconciliationWorker()
  await until(async () => calls.has("cus_shutdown-a"))
  let stopped = false
  const stopping = stop().then(() => {
    stopped = true
  })
  await delay(20)
  assert.equal(stopped, false)
  release()
  await stopping
  assert.equal(calls.has("cus_shutdown-b"), false)
  stop = startBillingReconciliationWorker()
  await until(
    async () => (await row("shutdown-b")).reconcile_after.getTime() > Date.now()
  )
  await stop()

  process.env.DATOOL_BILLING_ENABLED = "false"
  delete process.env.STRIPE_SECRET_KEY
  await due("locked")
  const callCount = calls.get("cus_locked")
  assert.equal((await reconcileCloudBilling()).scanned, 0)
  assert.equal(await reconcileBillingOrganization("locked"), undefined)
  await startBillingReconciliationWorker()()
  assert.equal(calls.get("cus_locked"), callCount)
  console.log(
    "PASS missed events, durable retries, recovery logs, bounded batches, locking, disabled mode, startup, recurring sweep and shutdown"
  )
} finally {
  await stop()
  Object.assign(console, original)
  await analyticsDb.end()
  await db.end()
}
