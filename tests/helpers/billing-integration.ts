import { strict as assert } from "node:assert"
import { makeSignature } from "better-auth/crypto"
import type Stripe from "stripe"
import { getAuth } from "../../lib/auth"
import { db, analyticsDb } from "../../lib/db"
import { cloudPrice, getStripe } from "../../src/server/billing/config"
import {
  getBilling,
  hasSubscriptionAccess,
  organizationHasBillingAccess,
} from "../../src/server/billing/store"
import { POST as checkout } from "../../app/api/billing/checkout/route"
import { POST as portal } from "../../app/api/billing/portal/route"
import { GET as status } from "../../app/api/billing/status/route"
import { POST as webhook } from "../../app/api/billing/webhook/route"
import { authorizeProject } from "../../src/server/tracer/http"
import { isAllowedGoogleUser } from "../../src/server/auth/launch-access"
import { verifyCloudEntitlements } from "./billing-entitlements"

const stripe = getStripe()
let customers = 0,
  sessions = 0,
  failSync = false,
  failCheckoutOnce = false
let subscriptions: Stripe.Subscription[] = []
let invoices: Partial<Stripe.Invoice>[] = []
stripe.invoices.list = ((params: Stripe.InvoiceListParams) => {
  const data = invoices.filter((invoice) => invoice.status === params.status)
  return Object.assign(Promise.resolve({ data }), {
    async *[Symbol.asyncIterator]() {
      yield* data
    },
  })
}) as unknown as typeof stripe.invoices.list
const checkoutSessions = new Map<
  string,
  {
    id: string
    url: string
    status: string
    payment_status: string
    allow_promotion_codes: boolean
    payment_method_collection: Stripe.Checkout.Session.PaymentMethodCollection
  }
>()
let priceCurrency = "usd"
stripe.prices.retrieve = (async (id: string) => ({
  id,
  active: true,
  currency: priceCurrency,
  type: "recurring",
  recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
  billing_scheme: "per_unit",
  unit_amount: id === "price_pro" ? 19900 : 2900,
})) as typeof stripe.prices.retrieve
assert.deepEqual(await cloudPrice("core"), {
  amount: 2900,
  currency: "usd",
  trialDays: 0,
})
assert.equal((await cloudPrice("pro")).amount, 19900)
priceCurrency = "brl"
await assert.rejects(cloudPrice("core"), /fixed monthly USD price/)
priceCurrency = "usd"
stripe.customers.create = (async () => ({
  id: `cus_${++customers}`,
})) as typeof stripe.customers.create
const customerEmails = new Map<string, string>()
stripe.customers.retrieve = (async (id: string) => ({
  id,
  email: customerEmails.get(id) ?? null,
})) as typeof stripe.customers.retrieve
stripe.customers.update = (async (
  id: string,
  params: Stripe.CustomerUpdateParams
) => {
  if (typeof params.email === "string") customerEmails.set(id, params.email)
  return { id, email: customerEmails.get(id) }
}) as typeof stripe.customers.update
stripe.subscriptions.list = (() => {
  const data = failSync
    ? Promise.reject(new Error("Temporary Stripe outage"))
    : Promise.resolve({ data: subscriptions })
  Object.assign(data, {
    async *[Symbol.asyncIterator]() {
      if (failSync) throw new Error("Temporary Stripe outage")
      yield* subscriptions
    },
  })
  // The list call supports either pagination or awaiting its first page.
  data.catch(() => {})
  return data
}) as typeof stripe.subscriptions.list
const attempts = new Map<string, { parameters: unknown; sessionId: string }>()
stripe.checkout.sessions.create = (async (
  parameters: Stripe.Checkout.SessionCreateParams,
  options: Stripe.RequestOptions
) => {
  const key = options.idempotencyKey!
  const previous = attempts.get(key)
  if (previous) {
    assert.deepEqual(
      parameters,
      previous.parameters,
      "Retries must preserve Stripe parameters"
    )
    return checkoutSessions.get(previous.sessionId)
  }
  const session = {
    id: `cs_${++sessions}`,
    url: `https://checkout.stripe.com/c/pay/${sessions}`,
    status: "open",
    payment_status: "unpaid",
    allow_promotion_codes: parameters.allow_promotion_codes ?? false,
    payment_method_collection: parameters.payment_method_collection ?? "always",
  }
  attempts.set(key, {
    parameters: structuredClone(parameters),
    sessionId: session.id,
  })
  checkoutSessions.set(session.id, session)
  if (failCheckoutOnce) {
    failCheckoutOnce = false
    throw new Error("Response lost after Stripe created checkout")
  }
  return session
}) as typeof stripe.checkout.sessions.create
stripe.checkout.sessions.retrieve = (async (id: string) =>
  checkoutSessions.get(id)) as typeof stripe.checkout.sessions.retrieve
stripe.checkout.sessions.expire = (async (id: string) => {
  checkoutSessions.get(id)!.status = "expired"
  return checkoutSessions.get(id)
}) as typeof stripe.checkout.sessions.expire
stripe.billingPortal.sessions.create = (async () => ({
  url: "https://billing.stripe.com/p/session/test",
})) as typeof stripe.billingPortal.sessions.create

const context = await getAuth().$context
async function user(name: string) {
  const user = await context.internalAdapter.createUser(
    { name, email: `${name}@example.test`, emailVerified: true },
    { method: "oauth" }
  )
  const session = await context.internalAdapter.createSession(user.id)
  assert(session)
  const signature = await makeSignature(session.token, context.secret)
  return {
    user,
    session,
    cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
  }
}
async function freshGoogleSignup() {
  const provider = context.socialProviders.find((item) => item.id === "google")!
  const token = `e30.${Buffer.from(JSON.stringify({ sub: "fresh-cloud-user", email: "fresh-cloud-user@example.test", email_verified: true, name: "Cloud owner" })).toString("base64url")}.signature`
  // Replace Google's external exchange only; exercise the real signup callback,
  // profile gate, persisted user/account/session, and destination preservation.
  provider.validateAuthorizationCode = async () => ({ idToken: token })
  const signIn = await getAuth().handler(
    new Request("http://localhost:3000/api/auth/sign-in/social", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "google",
        callbackURL: "/billing?plan=pro",
        disableRedirect: true,
      }),
    })
  )
  const state = new URL((await signIn.json()).url).searchParams.get("state")!
  const callback = await getAuth().handler(
    new Request(
      `http://localhost:3000/api/auth/callback/google?code=fixture&state=${encodeURIComponent(state)}`,
      {
        headers: {
          cookie: signIn.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; "),
        },
      }
    )
  )
  assert.equal(callback.status, 302)
  assert.equal(callback.headers.get("location"), "/billing?plan=pro")
  const cookie = callback.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ")
  const session = await getAuth().api.getSession({
    headers: new Headers({ cookie }),
  })
  assert(session)
  assert.equal(session.user.email, "fresh-cloud-user@example.test")
  return { cookie, user: session.user, session: session.session }
}
const owner = await freshGoogleSignup(),
  member = await user("billing-member"),
  outsider = await user("billing-outsider")
const org = await getAuth().api.createOrganization({
  headers: new Headers({ cookie: owner.cookie }),
  body: { name: "Billing", slug: "billing" },
})
assert(org)
await db.query(
  'INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES($1,$2,$3,\'member\',now())',
  [crypto.randomUUID(), org.id, member.user.id]
)
for (const item of [owner, member, outsider])
  await db.query('UPDATE session SET "activeOrganizationId"=$1 WHERE id=$2', [
    org.id,
    item.session.id,
  ])
await db.query(
  "INSERT INTO project(id,organization_id,name,slug) VALUES('billing-project',$1,'Billing','billing')",
  [org.id]
)
const request = (
  action: string,
  cookie = owner.cookie,
  body: unknown = { plan: "core" },
  origin = "http://localhost:3000"
) =>
  new Request(`http://localhost:3000/api/billing/${action}`, {
    method: action === "status" ? "GET" : "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    ...(action === "status" ? {} : { body: JSON.stringify(body) }),
  })
async function sendEvent(id: string, signatureValid = true) {
  const body = JSON.stringify({
    id,
    type: "customer.subscription.updated",
    livemode: false,
    data: { object: { customer: "cus_1" } },
  })
  const signature = await stripe.webhooks.generateTestHeaderStringAsync({
    payload: body,
    secret: signatureValid ? "whsec_fixture" : "whsec_bad",
  })
  return webhook(
    new Request("http://localhost:3000/api/billing/webhook", {
      method: "POST",
      body,
      headers: { "stripe-signature": signature },
    })
  )
}
const active = (
  state = "active",
  end = Math.floor(Date.now() / 1000) + 86400
) =>
  ({
    id: "sub_fixture",
    created: 1,
    status: state,
    customer: "cus_1",
    cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_core" }, current_period_end: end }] },
  }) as Stripe.Subscription
try {
  assert.equal((await checkout(request("checkout", ""))).status, 401)
  assert.equal((await checkout(request("checkout", member.cookie))).status, 403)
  assert.equal(
    (await checkout(request("checkout", outsider.cookie))).status,
    403
  )
  assert.equal((await status(request("status", outsider.cookie))).status, 403)
  assert.equal((await portal(request("portal", member.cookie))).status, 403)
  assert.equal(
    (
      await checkout(
        request(
          "checkout",
          owner.cookie,
          { plan: "core" },
          "https://attacker.test"
        )
      )
    ).status,
    403
  )
  assert.equal(
    (
      await checkout(
        request("checkout", owner.cookie, { plan: "price_untrusted" })
      )
    ).status,
    400
  )
  assert.equal(await organizationHasBillingAccess(org.id), false)
  await assert.rejects(
    () =>
      authorizeProject(
        new Request("http://localhost:3000/api/traces", {
          headers: { cookie: owner.cookie, "x-project-id": "billing-project" },
        })
      ),
    (error: unknown) => (error as { status?: number }).status === 402
  )
  const simultaneous = await Promise.all([
    checkout(request("checkout")),
    checkout(request("checkout")),
  ])
  assert(simultaneous.every((response) => response.status === 200))
  await assert.rejects(
    () =>
      getAuth().api.deleteOrganization({
        headers: new Headers({ cookie: owner.cookie }),
        body: { organizationId: org.id },
      }),
    /billing history/
  )
  assert.equal(
    (await db.query("SELECT id FROM organization WHERE id=$1", [org.id]))
      .rowCount,
    1
  )
  // Better Auth clears the active selection before running its deletion hook.
  await db.query('UPDATE session SET "activeOrganizationId"=$1 WHERE id=$2', [
    org.id,
    owner.session.id,
  ])
  assert.equal(customers, 1)
  assert.equal(sessions, 1)
  assert.equal(customerEmails.get("cus_1"), owner.user.email)
  const firstParameters = [...attempts.values()][0]
    .parameters as Stripe.Checkout.SessionCreateParams
  assert.equal(firstParameters.currency, "usd")
  assert.deepEqual(firstParameters.adaptive_pricing, { enabled: false })
  assert.equal(firstParameters.allow_promotion_codes, true)
  assert.equal(firstParameters.payment_method_collection, "if_required")
  assert.equal(
    firstParameters.success_url,
    "http://localhost:3000/billing?plan=core&checkout=success"
  )
  assert.equal(
    firstParameters.cancel_url,
    "http://localhost:3000/billing?plan=core&checkout=canceled"
  )
  customerEmails.set("cus_1", "accounts@example.test")
  assert.equal(
    (
      await checkout(
        request("checkout", owner.cookie, {
          plan: "core",
          email: "spoof@example.test",
        })
      )
    ).status,
    200
  )
  assert.equal(
    customerEmails.get("cus_1"),
    "accounts@example.test",
    "Preserve the existing billing contact"
  )
  assert.equal(
    await organizationHasBillingAccess(org.id),
    false,
    "Opening checkout must not grant access"
  )
  // A checkout opened before promo codes were supported must be replaced.
  checkoutSessions.get("cs_1")!.allow_promotion_codes = false
  failCheckoutOnce = true
  assert.equal((await checkout(request("checkout"))).status, 503)
  assert.equal(checkoutSessions.get("cs_1")!.status, "expired")
  process.env.DATOOL_BILLING_TRIAL_DAYS = "7"
  assert.equal(
    (await checkout(request("checkout", owner.cookie, { plan: "pro" }))).status,
    409
  )
  assert.equal((await checkout(request("checkout"))).status, 200)
  process.env.DATOOL_BILLING_TRIAL_DAYS = "0"
  assert.equal(sessions, 2)
  assert.equal((await sendEvent("evt_bad", false)).status, 400)
  assert.equal(
    (await db.query("SELECT * FROM billing_webhook_receipt")).rowCount,
    0
  )
  subscriptions = [active()]
  failSync = true
  assert.equal((await sendEvent("evt_retry")).status, 500)
  assert.equal(
    (await db.query("SELECT * FROM billing_webhook_receipt")).rowCount,
    0
  )
  failSync = false
  assert.equal((await sendEvent("evt_retry")).status, 200)
  assert.equal(await organizationHasBillingAccess(org.id), true)
  assert.equal((await sendEvent("evt_retry")).status, 200)
  assert.equal(
    (await db.query("SELECT * FROM billing_webhook_receipt")).rowCount,
    1
  )
  assert.equal((await checkout(request("checkout"))).status, 409)
  assert.equal((await portal(request("portal"))).status, 200)
  assert.equal((await status(request("status", member.cookie))).status, 200)
  await verifyCloudEntitlements(
    org.id,
    "billing-project",
    async (plan) => {
      subscriptions = [active()]
      subscriptions[0].items.data[0].price.id = `price_${plan}`
      await getBilling(org.id, true)
    },
    owner.cookie
  )
  subscriptions = [active()]
  await getBilling(org.id, true)
  subscriptions[0].cancel_at_period_end = false
  subscriptions[0].cancel_at = Math.floor(Date.now() / 1000) + 3600
  assert.equal((await sendEvent("evt_cancel_pending")).status, 200)
  assert.equal(
    await organizationHasBillingAccess(org.id),
    true,
    "Scheduled cancellation keeps paid access"
  )
  assert.equal((await getBilling(org.id))?.cancel_at_period_end, true)
  assert.equal(
    (await getBilling(org.id))?.current_period_end?.getTime(),
    subscriptions[0].cancel_at! * 1000
  )
  subscriptions = [active("past_due")]
  assert.equal((await sendEvent("evt_past_due")).status, 200)
  assert.equal(await organizationHasBillingAccess(org.id), false)
  const failedAt = Math.floor(Date.now() / 1000) - 3600
  invoices = [
    { id: "in_previous", status: "paid", amount_paid: 2900 },
    {
      id: "in_failed",
      status: "open",
      billing_reason: "subscription_cycle",
      created: failedAt,
      status_transitions: {
        finalized_at: failedAt,
        paid_at: null,
        marked_uncollectible_at: null,
        voided_at: null,
      },
      next_payment_attempt: failedAt + 86400,
    },
  ]
  assert.equal((await sendEvent("evt_grace")).status, 200)
  const grace = await getBilling(org.id)
  assert.equal(grace?.grace_until?.getTime(), (failedAt + 7 * 86400) * 1000)
  assert.equal(await organizationHasBillingAccess(org.id), true)
  assert.equal(
    hasSubscriptionAccess(grace, (failedAt + 7 * 86400) * 1000),
    false
  )
  await sendEvent("evt_retry_does_not_extend_grace")
  assert.equal(
    (await getBilling(org.id))?.grace_until?.getTime(),
    grace?.grace_until?.getTime()
  )
  subscriptions = [active()]
  assert.equal((await sendEvent("evt_payment_recovered")).status, 200)
  assert.equal((await getBilling(org.id))?.grace_until, null)
  assert.equal(await organizationHasBillingAccess(org.id), true)
  subscriptions = [active("active", 1)]
  await sendEvent("evt_expired")
  assert.equal(await organizationHasBillingAccess(org.id), false)
  subscriptions = []
  await sendEvent("evt_deleted")
  assert.equal((await getBilling(org.id))?.status, "none")
  assert.equal(
    hasSubscriptionAccess({
      status: "active",
      current_period_end: null,
      price_id: "price_core",
    }),
    false
  )
  assert.equal(
    hasSubscriptionAccess({
      status: "active",
      current_period_end: new Date(Date.now() + 1000),
      price_id: "price_foreign",
    }),
    false
  )
  assert.equal(
    isAllowedGoogleUser(
      { email: "new@example.com", emailVerified: true },
      "",
      true
    ),
    true
  )
  assert.equal(
    isAllowedGoogleUser(
      { email: "new@example.com", emailVerified: false },
      "",
      true
    ),
    false
  )
  assert.equal(
    isAllowedGoogleUser(
      { email: "new@example.com", emailVerified: true },
      "",
      false
    ),
    false
  )
  const proOrg = await getAuth().api.createOrganization({
    headers: new Headers({ cookie: owner.cookie }),
    body: { name: "Pro onboarding", slug: "pro-onboarding" },
  })
  assert(proOrg)
  await getAuth().api.setActiveOrganization({
    headers: new Headers({ cookie: owner.cookie }),
    body: { organizationId: proOrg.id },
  })
  assert.equal(
    (
      await checkout(
        request("checkout", owner.cookie, {
          plan: "pro",
          email: "spoof@example.test",
        })
      )
    ).status,
    200
  )
  const proParameters = [...attempts.values()].at(-1)!
    .parameters as Stripe.Checkout.SessionCreateParams
  assert.equal(proParameters.line_items?.[0].price, "price_pro")
  assert.equal(proParameters.allow_promotion_codes, true)
  assert.equal(proParameters.payment_method_collection, "if_required")
  assert.equal(
    proParameters.success_url,
    "http://localhost:3000/billing?plan=pro&checkout=success"
  )
  assert.equal(
    proParameters.cancel_url,
    "http://localhost:3000/billing?plan=pro&checkout=canceled"
  )
  assert.equal(
    customerEmails.get(proParameters.customer!),
    owner.user.email,
    "Use authenticated email, never caller-supplied email"
  )
  const cardRequiredSession = checkoutSessions.get(`cs_${sessions}`)!
  cardRequiredSession.payment_method_collection = "always"
  const sessionsBeforeReplacement = sessions
  assert.equal(
    (await checkout(request("checkout", owner.cookie, { plan: "pro" }))).status,
    200
  )
  assert.equal(cardRequiredSession.status, "expired")
  assert.equal(sessions, sessionsBeforeReplacement + 1)
  process.env.DATOOL_BILLING_ENABLED = "false"
  delete process.env.STRIPE_SECRET_KEY
  assert.equal(await organizationHasBillingAccess(org.id), true)
  assert.equal((await checkout(request("checkout"))).status, 404)
  console.log(
    "PASS billing authorization, checkout, webhook recovery, subscription access, and disabled mode"
  )
} finally {
  await analyticsDb.end()
  await db.end()
}
