import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { makeSignature } from "better-auth/crypto"
import { db, analyticsDb } from "../../lib/db"
import { getAuth } from "../../lib/auth"
import {
  createCheckout,
  getBilling,
  hasSubscriptionAccess,
  organizationHasBillingAccess,
  reconcileBillingOrganization,
} from "../../src/server/billing/store"
import {
  beginShopifyInstall,
  completeShopifyInstall,
  createShopifyInstallIntent,
} from "../../src/server/build/integrations/shopify-install"
import { POST as claim } from "../../app/api/shopify/claim/route"
import { POST as checkout } from "../../app/api/billing/checkout/route"
import { GET as status } from "../../app/api/billing/status/route"
import {
  executionCredits,
  ExecutionCreditError,
} from "../../src/server/execution-credits/ledger"
import { executeShopifyTool } from "../../src/server/build/integrations/shopify"
import {
  createTracerDatabase,
  closeTracerDatabase,
} from "../../src/server/tracer/db"

const org = process.env.TEST_ORGANIZATION!,
  owner = process.env.TEST_OWNER!,
  project = process.env.TEST_PROJECT!
const origin = "https://datool.example",
  agent = "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36"
let partnerCalls = 0,
  fail = "",
  plan: string | null = "core",
  trial = false
let amount = "29.00",
  priceActive = true
const webhookSubscriptions = new Map<string, { topic: string; uri: string }[]>()
let webhookError = false
let grantedScopes = "read_products,read_legal_policies"
const periodStart = new Date(Date.now() - 1000).toISOString()
const periodEnd = new Date(Date.now() + 30 * 86400_000).toISOString()
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input)),
    body = JSON.parse(String(init?.body))
  assert.equal(init?.redirect, "error")
  if (url.host === "partners.shopify.com") {
    partnerCalls++
    assert.equal(url.pathname, "/123/api/2026-10/graphql.json")
    assert.equal(
      new Headers(init?.headers).get("X-Shopify-Access-Token"),
      "fixture-partner-token"
    )
    assert.deepEqual(body.variables, {
      appId: "gid://shopify/App/456",
      shopId: "gid://shopify/Shop/789",
    })
    if (fail === "http") return new Response("private-error", { status: 429 })
    if (fail === "graphql")
      return Response.json({
        errors: [{ message: "private-error" }],
        data: { activeSubscription: null },
      })
    if (fail === "malformed") return Response.json({ data: {} })
    return Response.json({
      data: {
        activeSubscription:
          plan === null
            ? null
            : {
                billingPeriod: "EVERY_30_DAYS",
                cancelAtEndOfCycle: false,
                trialEndsAt: trial ? periodEnd : null,
                currentBillingCycle: trial
                  ? null
                  : { startTime: periodStart, endTime: periodEnd },
                items: [
                  {
                    handle: plan,
                    price: {
                      __typename: "FlatRatePrice",
                      active: priceActive,
                      amount,
                      currency: "USD",
                    },
                  },
                ],
              },
      },
    })
  }
  assert(url.hostname.endsWith(".myshopify.com"))
  if (body.query?.includes("DatoolWebhookSubscriptions"))
    return Response.json({
      data: {
        webhookSubscriptions: {
          nodes: webhookSubscriptions.get(url.hostname) ?? [],
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      },
    })
  if (body.query?.includes("DatoolWebhookCreate")) {
    if (webhookError)
      return Response.json({
        data: {
          webhookSubscriptionCreate: {
            webhookSubscription: null,
            userErrors: [{ message: "fixture failure" }],
          },
        },
      })
    const subscriptions = webhookSubscriptions.get(url.hostname) ?? []
    subscriptions.push({
      topic: body.variables.topic,
      uri: body.variables.subscription.uri,
    })
    webhookSubscriptions.set(url.hostname, subscriptions)
    return Response.json({
      data: {
        webhookSubscriptionCreate: {
          webhookSubscription: { id: "gid://shopify/WebhookSubscription/1" },
          userErrors: [],
        },
      },
    })
  }
  if (url.pathname === "/admin/oauth/access_token")
    return Response.json({
      access_token: "private-oauth-access",
      refresh_token: "private-oauth-refresh",
      expires_in: 3600,
      refresh_token_expires_in: 7776000,
      scope: grantedScopes,
    })
  if (body.query.includes("DatoolBillingShop"))
    return Response.json({ data: { shop: { id: "gid://shopify/Shop/789" } } })
  if (body.query.includes("DatoolPolicies"))
    return Response.json({ data: { shop: { shopPolicies: [] } } })
  throw new Error("Unexpected external request")
}) as typeof fetch
const auth = await getAuth().$context
const session = await auth.internalAdapter.createSession(owner)
assert(session)
const signed = await makeSignature(session.token, auth.secret)
const authCookie = `${auth.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signed}`)}`
await db.query('UPDATE session SET "activeOrganizationId"=$1 WHERE id=$2', [
  org,
  session.id,
])
const signedUrl = (path: string, fields: Record<string, string>) => {
  const query = new URLSearchParams({
    ...fields,
    timestamp: String(Math.floor(Date.now() / 1000)),
  })
  query.set(
    "hmac",
    createHmac("sha256", "fixture-secret")
      .update(
        [...query]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join("&")
      )
      .digest("hex")
  )
  return `${origin}${path}?${query}`
}
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ")
async function install(
  shop: string,
  startCookie = "",
  expectedTopics = ["APP_UNINSTALLED"]
) {
  const begin = await beginShopifyInstall(
    db,
    new Request(signedUrl("/api/shopify/install", { shop }), {
      headers: { cookie: startCookie, "user-agent": agent },
    })
  )
  const cookie = cookies(begin),
    state = new URL(begin.headers.get("location")!).searchParams.get("state")!
  const callback = new Request(
    signedUrl("/api/shopify/callback", { shop, state, code: "fixture-code" }),
    { headers: { cookie, "user-agent": agent } }
  )
  const complete = await completeShopifyInstall(db, callback)
  assert.equal(complete?.status, 303)
  assert.equal(complete.headers.get("location"), `${origin}/shopify/connect`)
  assert.deepEqual(
    webhookSubscriptions.get(shop),
    expectedTopics.map((topic) => ({
      topic,
      uri: `${origin}/api/shopify/webhooks/commerce`,
    })),
    "A completed install must register permitted events without duplicating them on reinstall"
  )
  assert.equal(await completeShopifyInstall(db, callback), null)
  return cookies(complete)
}
const request = (
  path: string,
  cookie: string,
  body?: unknown,
  requestOrigin = origin
) =>
  new Request(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      cookie,
      origin: requestOrigin,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
const database = createTracerDatabase(process.env.DATABASE_URL, {
  projectId: project,
})
try {
  webhookError = true
  await assert.rejects(
    install("webhook-retry.myshopify.com"),
    /Shopify webhook registration failed/
  )
  assert.equal(
    (
      await db.query(
        "SELECT session_encrypted FROM shopify_install_intent WHERE shop=$1",
        ["webhook-retry.myshopify.com"]
      )
    ).rows[0].session_encrypted,
    null
  )
  webhookError = false
  await install("webhook-retry.myshopify.com")
  grantedScopes +=
    ",write_orders,write_draft_orders,write_returns,write_merchant_managed_fulfillment_orders"
  await install("commerce.myshopify.com", "", [
    "APP_UNINSTALLED",
    "ORDERS_CREATE",
    "ORDERS_PAID",
    "ORDERS_UPDATED",
    "ORDERS_CANCELLED",
    "DRAFT_ORDERS_UPDATE",
    "RETURNS_PROCESS",
    "RETURNS_UPDATE",
    "FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE",
  ])
  grantedScopes = "read_products,read_legal_policies"
  await assert.rejects(
    beginShopifyInstall(
      db,
      new Request(
        `${origin}/api/shopify/install?shop=fixture.myshopify.com&hmac=forged`
      )
    )
  )
  const browser = await install("new-store.myshopify.com"),
    cookie = `${authCookie}; ${browser}`
  const body = { organizationId: org, projectId: project }
  assert.equal(
    (await claim(request("/api/shopify/claim", browser, body))).status,
    401
  )
  assert.equal(
    (
      await claim(
        request("/api/shopify/claim", cookie, body, "https://attacker.example")
      )
    ).status,
    403
  )
  assert.equal(
    (
      await claim(
        request("/api/shopify/claim", cookie, {
          ...body,
          organizationId: "outsider",
        })
      )
    ).status,
    403
  )
  const response = await claim(request("/api/shopify/claim", cookie, body))
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal((await response.json()).provider, "shopify")
  assert.equal(
    (await claim(request("/api/shopify/claim", cookie, body))).status,
    200
  )
  assert.equal(
    (
      await db.query(
        "SELECT * FROM build_app_connections WHERE project_id=$1",
        [project]
      )
    ).rowCount,
    1
  )
  const price = await checkout(
    request("/api/billing/checkout", cookie, { plan: "pro" })
  )
  assert.equal(price.status, 200)
  assert.equal(
    (await price.json()).url,
    "https://admin.shopify.com/store/new-store/charges/datool/pricing_plans"
  )
  assert.equal(
    partnerCalls,
    0,
    "Opening plans does not claim a paid subscription"
  )
  trial = true
  await getBilling(org, true)
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS total FROM execution_credit_period WHERE organization_id=$1",
        [org]
      )
    ).rows[0].total,
    0,
    "Trials do not issue funded execution credits"
  )
  trial = false
  amount = "0.00"
  // Shopify's live no-charge contract retains the plan handle while its price
  // is marked inactive. Price activity is catalog metadata, not entitlement.
  priceActive = false
  const developerBilling = await getBilling(org, true)
  assert.equal(developerBilling?.status, "active")
  assert.equal(developerBilling?.plan, "core")
  assert(hasSubscriptionAccess(developerBilling))
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS total FROM execution_credit_period WHERE organization_id=$1",
        [org]
      )
    ).rows[0].total,
    0,
    "No-charge developer plans do not issue funded execution credits"
  )
  amount = "29.00"
  // Existing subscribers also retain access when a catalog price is replaced.
  let billing = await getBilling(org, true)
  assert.equal(
    billing?.plan,
    "core",
    "Provider contract wins over the browser's Pro selection"
  )
  assert.equal(billing?.record_limit, 100_000)
  assert(hasSubscriptionAccess(billing))
  priceActive = true
  const creditOperation = await executionCredits.reserve(
    project,
    "model",
    100,
    "test"
  )
  await executionCredits.settle(creditOperation, 25, null, {})
  await getBilling(org, true)
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS total FROM execution_credit_period WHERE organization_id=$1",
        [org]
      )
    ).rows[0].total,
    1,
    "Repeated verification cannot issue duplicate credits"
  )
  const calls = partnerCalls
  assert(await organizationHasBillingAccess(org))
  assert.equal(partnerCalls, calls, "Confirmed subscriptions are cached")
  for (const failure of ["http", "graphql", "malformed"]) {
    fail = failure
    const api = await status(request("/api/billing/status", cookie))
    assert.equal(api.status, 503)
    assert(!(await api.text()).includes("private-error"))
    assert.equal(
      (
        await db.query(
          "SELECT status,plan FROM organization_billing WHERE organization_id=$1",
          [org]
        )
      ).rows[0].plan,
      "core"
    )
  }
  fail = ""
  plan = "unconfigured-plan"
  await assert.rejects(getBilling(org, true), /not recognized/)
  plan = "pro"
  trial = true
  billing = await getBilling(org, true)
  assert.equal(billing?.plan, "pro")
  assert.equal(billing?.status, "trialing")
  assert.equal(billing?.record_limit, 1_000_000)
  trial = false
  plan = null
  billing = await getBilling(org, true)
  assert(!hasSubscriptionAccess(billing))
  assert.equal(billing?.access_until, null)
  await assert.rejects(
    executionCredits.reserve(project, "model", 100, "test"),
    ExecutionCreditError
  )
  assert.equal(
    await createCheckout(org, "core", "owner@example.test"),
    "https://admin.shopify.com/store/new-store/charges/datool/pricing_plans",
    "Cancellation cannot switch billing to Stripe"
  )
  plan = "core"
  await db.query(
    "UPDATE organization_billing SET reconcile_after=now()-interval '1 second' WHERE organization_id=$1",
    [org]
  )
  assert.equal((await reconcileBillingOrganization(org))?.status, "synced")
  const connection = (
    await db.query("SELECT id FROM build_app_connections WHERE project_id=$1", [
      project,
    ])
  ).rows[0]
  await executeShopifyTool(
    { database, projectId: project, organizationId: org },
    connection.id,
    "SHOPIFY_READ_POLICIES",
    {}
  )

  // Reopening Shopify without an explicit project reuses its original connection.
  const reconnectCookie = await install("new-store.myshopify.com")
  const reconnect = await claim(
    request("/api/shopify/claim", `${authCookie}; ${reconnectCookie}`, {
      organizationId: org,
    })
  )
  assert.equal(reconnect.status, 200)
  assert.equal((await reconnect.json()).projectId, project)
  assert.equal(
    (
      await db.query(
        "SELECT id FROM build_app_connections WHERE project_id=$1",
        [project]
      )
    ).rows[0].id,
    connection.id
  )

  // Existing Stripe customers keep their relationship even on an App Store install.
  const external = crypto.randomUUID(),
    externalProject = crypto.randomUUID()
  await db.query(
    `INSERT INTO organization(id,name,slug,"createdAt") VALUES($1,'Existing customer',$1,now())`,
    [external]
  )
  await db.query(
    `INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES($1,$2,$3,'owner',now())`,
    [crypto.randomUUID(), external, owner]
  )
  await db.query(
    "INSERT INTO project(id,organization_id,name,slug) VALUES($1,$2,'Existing','existing')",
    [externalProject, external]
  )
  await db.query(
    "INSERT INTO organization_billing(organization_id,customer_id,subscription_id,checkout_attempt_id) VALUES($1,'cus_existing','sub_existing',$2)",
    [external, crypto.randomUUID()]
  )
  const externalBrowser = await install("existing.myshopify.com")
  const linked = await claim(
    request("/api/shopify/claim", `${authCookie}; ${externalBrowser}`, {
      organizationId: external,
      projectId: externalProject,
    })
  )
  assert.equal(linked.status, 200)
  assert.equal((await linked.json()).provider, "stripe")
  assert.equal(
    (
      await db.query(
        "SELECT customer_id FROM organization_billing WHERE organization_id=$1",
        [external]
      )
    ).rows[0].customer_id,
    "cus_existing"
  )

  // Signed direct-project intent survives the App Store round trip and is single use.
  const directDb = createTracerDatabase(process.env.DATABASE_URL, {
    projectId: externalProject,
  })
  try {
    const start = await createShopifyInstallIntent({
      database: directDb,
      projectId: externalProject,
      organizationId: external,
    })
    const started = await beginShopifyInstall(
      db,
      new Request(start.redirectUrl)
    )
    assert.equal(
      started.headers.get("location"),
      "https://apps.shopify.com/datool"
    )
    await assert.rejects(
      beginShopifyInstall(db, new Request(start.redirectUrl))
    )
    const directCookie = await install(
      "existing.myshopify.com",
      cookies(started)
    )
    const result = await claim(
      request("/api/shopify/claim", `${authCookie}; ${directCookie}`, {
        organizationId: external,
        projectId: externalProject,
      })
    )
    assert.equal(result.status, 200)
    assert.equal((await result.json()).provider, "stripe")
  } finally {
    await closeTracerDatabase(directDb)
  }
  console.log("PASS Shopify billing lifecycle")
} finally {
  await closeTracerDatabase(database)
  await analyticsDb.end()
  await db.end()
}
