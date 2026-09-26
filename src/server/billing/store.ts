import { syncExecutionGrant } from "@/src/server/execution-credits/grants"
import {
  emitProductEvent,
  type ProductEvent,
} from "@/src/server/product-events"
import type Stripe from "stripe"
import type { PoolClient } from "pg"
import { db } from "@/lib/db"
import { TracerError } from "@/src/server/tracer/errors"
import {
  paymentGraceDays,
  billingPath,
  planEntitlements,
  type CloudPlan,
} from "@/src/lib/billing"
import {
  billingConfig,
  billingEnabled,
  cloudPrice,
  getStripe,
  type BillingPlan,
} from "./config"

export type BillingRow = {
  organization_id: string
  customer_id: string | null
  subscription_id: string | null
  price_id: string | null
  status: string
  current_period_end: Date | null
  cancel_at_period_end: boolean
  synced_at: Date | null
  checkout_session_id: string | null
  checkout_attempt_id: string
  checkout_price_id: string | null
  checkout_parameters: Stripe.Checkout.SessionCreateParams | null
  plan: CloudPlan | null
  record_limit: number
  retention_days: number
  access_until: Date | null
  grace_until: Date | null
  next_payment_attempt: Date | null
  reconcile_after: Date
  reconcile_failures: number
}

type BillingAction<T> = (client: PoolClient, row: BillingRow) => Promise<T>

/** Session locks serialize Stripe requests, while each database write is durable
 * before the next network call. Stable attempt IDs survive timeouts and retries. */
async function locked<T>(
  organizationId: string,
  action: BillingAction<T>
): Promise<T>
async function locked<T>(
  organizationId: string,
  action: BillingAction<T>,
  skipLocked: true
): Promise<T | undefined>
async function locked<T>(
  organizationId: string,
  action: BillingAction<T>,
  skipLocked = false
): Promise<T | undefined> {
  const client = await db.connect()
  let acquired = false
  try {
    const lock = await client.query<{ acquired: boolean }>(
      skipLocked
        ? "SELECT pg_try_advisory_lock(hashtext('datool-billing'), hashtext($1)) AS acquired"
        : "SELECT pg_advisory_lock(hashtext('datool-billing'), hashtext($1))",
      [organizationId]
    )
    acquired = !skipLocked || lock.rows[0].acquired
    if (!acquired) return
    if (!skipLocked)
      await client.query(
        "INSERT INTO organization_billing (organization_id, checkout_attempt_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [organizationId, crypto.randomUUID()]
      )
    const result = await client.query<BillingRow>(
      "SELECT * FROM organization_billing WHERE organization_id=$1",
      [organizationId]
    )
    if (skipLocked && !result.rows[0]) return
    return await action(client, result.rows[0])
  } finally {
    let discard = false
    try {
      if (acquired)
        await client.query(
          "SELECT pg_advisory_unlock(hashtext('datool-billing'), hashtext($1))",
          [organizationId]
        )
    } catch {
      // Never return a connection with an uncertain session lock to the pool.
      discard = true
    } finally {
      client.release(discard)
    }
  }
}

export function hasSubscriptionAccess(
  row:
    | (Pick<BillingRow, "status" | "current_period_end" | "price_id"> &
        Partial<Pick<BillingRow, "grace_until">>)
    | null,
  now = Date.now()
) {
  return (
    !!row &&
    Object.values(billingConfig().prices).includes(row.price_id ?? "") &&
    ((["active", "trialing"].includes(row.status) &&
      !!row.current_period_end &&
      row.current_period_end.getTime() > now) ||
      (row.status === "past_due" &&
        !!row.grace_until &&
        row.grace_until.getTime() > now))
  )
}

/** Only failed renewals of previously paid subscriptions get grace. The oldest
 * unpaid renewal anchors it, so retries and later invoices cannot extend it. */
async function paymentRecovery(subscription: Stripe.Subscription | undefined) {
  if (subscription?.status !== "past_due")
    return { grace: null, nextAttempt: null }
  const stripe = getStripe()
  let previouslyPaid = false
  for await (const invoice of stripe.invoices.list({
    subscription: subscription.id,
    status: "paid",
    limit: 100,
  })) {
    if (invoice.amount_paid > 0) {
      previouslyPaid = true
      break
    }
  }
  if (!previouslyPaid) return { grace: null, nextAttempt: null }
  let oldest: Stripe.Invoice | undefined
  for await (const invoice of stripe.invoices.list({
    subscription: subscription.id,
    status: "open",
    limit: 100,
  })) {
    if (
      invoice.billing_reason === "subscription_cycle" &&
      (!oldest || invoice.created < oldest.created)
    )
      oldest = invoice
  }
  const failedAt = oldest?.status_transitions.finalized_at ?? oldest?.created
  return {
    grace: failedAt
      ? new Date(
          Math.min(
            failedAt + paymentGraceDays * 86400,
            subscription.cancel_at ?? Infinity
          ) * 1000
        )
      : null,
    nextAttempt: oldest?.next_payment_attempt
      ? new Date(oldest.next_payment_attempt * 1000)
      : null,
  }
}

async function sync(client: PoolClient, row: BillingRow) {
  if (!row.customer_id) return row
  const subscriptions: Stripe.Subscription[] = []
  for await (const subscription of getStripe().subscriptions.list({
    customer: row.customer_id,
    status: "all",
    limit: 100,
  })) {
    if (
      subscription.items.data.some((item) =>
        Object.values(billingConfig().prices).includes(item.price.id)
      )
    )
      subscriptions.push(subscription)
  }
  // An older active subscription takes priority over a newer failed attempt.
  subscriptions.sort(
    (a, b) =>
      Number(["active", "trialing"].includes(b.status)) -
        Number(["active", "trialing"].includes(a.status)) ||
      b.created - a.created
  )
  const subscription = subscriptions[0]
  const item = subscription?.items.data.find((item) =>
    Object.values(billingConfig().prices).includes(item.price.id)
  )
  const plan = (Object.entries(billingConfig().prices).find(
    ([, id]) => id === item?.price.id
  )?.[0] ?? null) as CloudPlan | null
  const entitlements = plan ? planEntitlements(plan) : null
  const recovery = await paymentRecovery(subscription)
  const periodEnd = item?.current_period_end
    ? new Date(
        Math.min(item.current_period_end, subscription?.cancel_at ?? Infinity) *
          1000
      )
    : null
  const accessUntil =
    subscription?.status === "past_due"
      ? recovery.grace
      : subscription && ["active", "trialing"].includes(subscription.status)
        ? periodEnd
        : null
  const result = await client.query<BillingRow>(
    `UPDATE organization_billing SET subscription_id=$2, price_id=$3, status=$4,
       current_period_end=$5, cancel_at_period_end=$6, synced_at=now(),
       reconcile_after=now()+interval '15 minutes', reconcile_failures=0,
       plan=$7, record_limit=$8, retention_days=COALESCE($9,retention_days),
       access_until=$10, grace_until=$11, next_payment_attempt=$12
     WHERE organization_id=$1 RETURNING *`,
    [
      row.organization_id,
      subscription?.id ?? null,
      item?.price.id ?? null,
      subscription?.status ?? "none",
      periodEnd,
      !!(subscription?.cancel_at_period_end || subscription?.cancel_at),
      plan,
      entitlements?.monthlyRecords ?? 0,
      entitlements?.retentionDays ?? null,
      accessUntil,
      recovery.grace,
      recovery.nextAttempt,
    ]
  )
  if (
    process.env.DATOOL_MANAGED_EXECUTION_ENABLED === "true" &&
    subscription?.status === "active" &&
    item
  )
    await syncExecutionGrant(
      row.organization_id,
      row.customer_id,
      subscription.id,
      item.price.id,
      item.current_period_end
    )
  if (row.reconcile_failures >= 3)
    console.info(
      JSON.stringify({
        event: "billing_reconciliation_recovered",
        organizationId: row.organization_id,
        previousFailures: row.reconcile_failures,
      })
    )
  return result.rows[0]
}

/** Recheck the due time under the same lock used by webhooks and checkout.
 * Busy organizations are skipped, so background work cannot queue behind them. */
export async function reconcileBillingOrganization(organizationId: string) {
  if (!billingEnabled()) return
  return locked(
    organizationId,
    async (client, row) => {
      if (!row.customer_id || row.reconcile_after.getTime() > Date.now()) return
      try {
        await sync(client, row)
        return { status: "synced" as const }
      } catch {
        // Retain the last verified subscription and synced_at on failure. Backoff
        // is durable across worker restarts: 1, 2, 4, 8, then 15 minutes.
        const result = await client.query<{
          reconcile_failures: number
          reconcile_after: Date
        }>(
          `UPDATE organization_billing SET reconcile_failures=reconcile_failures+1,
          reconcile_after=now()+make_interval(secs => LEAST(900,60*power(2,LEAST(reconcile_failures,4)))::integer)
         WHERE organization_id=$1 RETURNING reconcile_failures,reconcile_after`,
          [organizationId]
        )
        return { status: "failed" as const, ...result.rows[0] }
      }
    },
    true
  )
}

export async function getBilling(organizationId: string, refresh = false) {
  const result = await db.query<BillingRow>(
    "SELECT * FROM organization_billing WHERE organization_id=$1",
    [organizationId]
  )
  const row = result.rows[0] ?? null
  const needsSync = (value: BillingRow) =>
    !value.synced_at ||
    Date.now() - value.synced_at.getTime() > 300_000 ||
    (value.status === "past_due" &&
      !!value.grace_until &&
      value.grace_until.getTime() <= Date.now()) ||
    (["active", "trialing"].includes(value.status) &&
      !!value.current_period_end &&
      value.current_period_end.getTime() <= Date.now())
  if (row?.customer_id && (refresh || needsSync(row)))
    return locked(organizationId, (client, current) =>
      refresh || needsSync(current)
        ? sync(client, current)
        : Promise.resolve(current)
    )
  return row
}

export async function organizationHasBillingAccess(organizationId: string) {
  if (!billingEnabled()) return true
  return hasSubscriptionAccess(await getBilling(organizationId))
}

export async function assertBillingAccess(organizationId: string) {
  if (!(await organizationHasBillingAccess(organizationId)))
    throw new TracerError(
      "UNAUTHORIZED",
      "An active Datool Cloud subscription is required. Manage billing at /billing.",
      {
        status: 402,
        details: { reason: "SUBSCRIPTION_REQUIRED", billingUrl: "/billing" },
      }
    )
}

export async function createCheckout(
  organizationId: string,
  plan: BillingPlan,
  email: string
) {
  const config = billingConfig()
  await cloudPrice(plan)
  return locked(organizationId, async (client, row) => {
    const stripe = getStripe()
    if (!row.customer_id) {
      const customer = await stripe.customers.create(
        { metadata: { datool_organization_id: organizationId } },
        {
          idempotencyKey: `datool-customer:${organizationId}`,
        }
      )
      await client.query(
        "UPDATE organization_billing SET customer_id=$2 WHERE organization_id=$1",
        [organizationId, customer.id]
      )
      row.customer_id = customer.id
    }
    row = await sync(client, row)
    if (
      [
        "active",
        "trialing",
        "past_due",
        "unpaid",
        "paused",
        "incomplete",
      ].includes(row.status)
    )
      throw new TracerError(
        "CONFLICT",
        "This organization already has a subscription. Use Manage billing to update it."
      )

    // Keep customer creation idempotent across retries and different admins.
    // Fill a missing billing email from the authenticated session, never the body;
    // preserve an existing billing contact chosen by the organization.
    const customer = await stripe.customers.retrieve(row.customer_id!)
    if (!customer.deleted && !customer.email)
      await stripe.customers.update(customer.id, { email })

    if (row.checkout_session_id) {
      const previous = await stripe.checkout.sessions.retrieve(
        row.checkout_session_id
      )
      if (
        previous.status === "open" &&
        previous.url &&
        row.checkout_price_id === config.prices[plan] &&
        previous.allow_promotion_codes === true &&
        previous.payment_method_collection === "if_required"
      )
        return previous.url
      if (previous.status === "open")
        await stripe.checkout.sessions.expire(previous.id)
      // A completed checkout can be waiting for asynchronous payment settlement.
      if (
        previous.status === "complete" &&
        previous.payment_status === "unpaid"
      )
        throw new TracerError(
          "CONFLICT",
          "Payment is still processing. Refresh billing shortly."
        )
      row.checkout_attempt_id = crypto.randomUUID()
      row.checkout_price_id = null
      row.checkout_parameters = null
      await client.query(
        "UPDATE organization_billing SET checkout_session_id=NULL, checkout_attempt_id=$2, checkout_price_id=NULL, checkout_parameters=NULL WHERE organization_id=$1",
        [organizationId, row.checkout_attempt_id]
      )
    }
    if (row.checkout_price_id && row.checkout_price_id !== config.prices[plan])
      throw new TracerError(
        "CONFLICT",
        "A checkout attempt is pending for another plan. Retry that plan before switching."
      )
    // Freeze the exact parameters before calling Stripe. A timeout can be retried
    // with the same idempotency key even after configuration changes.
    let parameters = row.checkout_parameters
    if (!parameters) {
      const history = await stripe.subscriptions.list({
        customer: row.customer_id!,
        status: "all",
        limit: 1,
      })
      parameters = {
        customer: row.customer_id!,
        mode: "subscription",
        currency: "usd",
        adaptive_pricing: { enabled: false },
        allow_promotion_codes: true,
        payment_method_collection: "if_required",
        payment_method_types: ["card"],
        line_items: [{ price: config.prices[plan], quantity: 1 }],
        client_reference_id: organizationId,
        subscription_data: {
          metadata: { datool_organization_id: organizationId },
          ...(config.trialDays && history.data.length === 0
            ? { trial_period_days: config.trialDays }
            : {}),
        },
        success_url: `${config.origin}${billingPath(plan, "success")}`,
        cancel_url: `${config.origin}${billingPath(plan, "canceled")}`,
      }
      await client.query(
        "UPDATE organization_billing SET checkout_price_id=$2, checkout_parameters=$3 WHERE organization_id=$1",
        [organizationId, config.prices[plan], parameters]
      )
    }
    const session = await stripe.checkout.sessions.create(parameters, {
      idempotencyKey: `datool-checkout:${row.checkout_attempt_id}`,
    })
    await client.query(
      "UPDATE organization_billing SET checkout_session_id=$2 WHERE organization_id=$1",
      [organizationId, session.id]
    )
    if (!session.url) throw new Error("Stripe did not return a checkout URL.")
    return session.url
  })
}

export async function createPortal(organizationId: string) {
  const row = await getBilling(organizationId)
  if (!row?.customer_id)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Start a subscription before managing billing."
    )
  const session = await getStripe().billingPortal.sessions.create({
    customer: row.customer_id,
    return_url: `${billingConfig().origin}/billing`,
    ...(process.env.STRIPE_PORTAL_CONFIGURATION_ID
      ? { configuration: process.env.STRIPE_PORTAL_CONFIGURATION_ID }
      : {}),
  })
  return session.url
}

export async function processBillingEvent(event: Stripe.Event) {
  if (!(
    event.type.startsWith("customer.subscription.") ||
    event.type.startsWith("invoice.") ||
    event.type.startsWith("checkout.session.")
  ))
    return
  const object = event.data.object as {
    customer?: string | { id: string } | null
  }
  const customerId =
    typeof object.customer === "string" ? object.customer : object.customer?.id
  if (!customerId) return
  const mapping = await db.query<{ organization_id: string }>(
    "SELECT organization_id FROM organization_billing WHERE customer_id=$1",
    [customerId]
  )
  if (!mapping.rows[0]) return
  await locked(mapping.rows[0].organization_id, async (client, row) => {
    const receipt = await client.query(
      "SELECT event_id FROM billing_webhook_receipt WHERE event_id=$1",
      [event.id]
    )
    if (receipt.rowCount) return
    const current = await sync(client, row)
    const productEvent = await subscriptionActivatedEvent(
      client,
      current,
      event
    )
    await client.query(
      "INSERT INTO billing_webhook_receipt(event_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [event.id]
    )
    if (productEvent) {
      // Stripe can generate distinct Event IDs for the same invoice. Record the
      // logical activation as well, using the existing billing receipt store.
      const receipt = await client.query(
        "INSERT INTO billing_webhook_receipt(event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id",
        [`subscription.activated:${productEvent.subscriptionId}`]
      )
      if (receipt.rowCount) await emitProductEvent(productEvent)
    }
  })
}

async function subscriptionActivatedEvent(
  client: PoolClient,
  row: BillingRow,
  event: Stripe.Event
): Promise<ProductEvent | undefined> {
  if (
    event.type !== "invoice.paid" ||
    !row.subscription_id ||
    !row.plan ||
    event.data.object.amount_paid <= 0
  )
    return
  const notified = await client.query(
    "SELECT 1 FROM billing_webhook_receipt WHERE event_id=$1",
    [`subscription.activated:${row.subscription_id}`]
  )
  if (notified.rowCount) return
  // Invoice history comes from Stripe, not checkout input. The first positive
  // payment covers trial conversions and ignores renewals and free invoices.
  let first: Stripe.Invoice | undefined
  for await (const invoice of getStripe().invoices.list({
    subscription: row.subscription_id,
    status: "paid",
    limit: 100,
  })) {
    if (invoice.status !== "paid" || invoice.amount_paid <= 0) continue
    const paidAt = invoice.status_transitions.paid_at ?? invoice.created
    if (!first || paidAt < (first.status_transitions.paid_at ?? first.created))
      first = invoice
  }
  if (!first || first.id !== event.data.object.id) return
  const { rows } = await client.query<{ name: string }>(
    "SELECT name FROM organization WHERE id=$1",
    [row.organization_id]
  )
  if (!rows[0]) return
  return {
    type: "subscription.activated",
    organizationName: rows[0].name,
    subscriptionId: row.subscription_id,
    plan: row.plan,
    amountPaid: first.amount_paid,
    currency: first.currency,
    livemode: first.livemode,
  }
}
