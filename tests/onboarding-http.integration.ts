import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { makeSignature } from "better-auth/crypto"

// Run against the local billing app. Only this run's fixture user/org are changed.
const database = new URL(process.env.DATABASE_URL ?? "http://invalid")
const base = process.env.BETTER_AUTH_URL
assert(["localhost", "127.0.0.1"].includes(database.hostname))
assert(base && ["localhost", "127.0.0.1"].includes(new URL(base).hostname))
assert.equal(process.env.DATOOL_BILLING_ENABLED, "true")
assert(process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_"))
const { getAuth } = await import("../lib/auth")
const { db, analyticsDb } = await import("../lib/db")
const suffix = randomUUID()
let userId: string | undefined
let organizationId: string | undefined
let cookie = ""

async function request(path: string, body?: unknown, sessionCookie = cookie) {
  const response = await fetch(new URL(path, base), {
    redirect: "manual",
    method: body ? "POST" : "GET",
    headers: {
      cookie: sessionCookie,
      origin: base!,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { response, body: (await response.text()).replaceAll("<!-- -->", "") }
}

async function expectRedirect(path: string, destination: string) {
  const result = await request(path)
  assert(
    result.response.headers.get("location") === destination ||
      result.body.includes(`NEXT_REDIRECT;replace;${destination};307;`),
    `${path} must redirect to ${destination}, got ${result.response.status}`
  )
}

try {
  await expectRedirect(
    "/organizations/new",
    "/sign-in?callbackUrl=%2Forganizations%2Fnew"
  )
  const context = await getAuth().$context
  const user = await context.internalAdapter.createUser(
    {
      name: "Onboarding routing fixture",
      email: `onboarding-${suffix}@example.test`,
      emailVerified: true,
    },
    { method: "oauth" }
  )
  userId = user.id
  const session = await context.internalAdapter.createSession(user.id)
  assert(session)
  const signature = await makeSignature(session.token, context.secret)
  cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`

  for (const path of ["/", "/?returnTo=%2Fprojects", "/organizations/new"]) {
    const page = await request(path)
    assert.equal(page.response.status, 200)
    assert(page.body.includes("Create your organization"))
    assert(page.body.includes("Create &amp; choose a plan"))
    assert(page.body.includes("Sign out"))
    assert(!page.body.includes("0 available"))
    assert(!page.body.includes("Core plan benefits"))
  }
  const pro = await request("/?returnTo=%2Fbilling%3Fplan%3Dpro")
  assert(pro.body.includes("Pro plan benefits"))
  assert(pro.body.includes("Create &amp; continue to payment"))
  await expectRedirect("/pricing", "/?returnTo=%2Fpricing")

  const creation = await request("/api/auth/organization/create", {
    name: "Onboarding fixture",
    slug: `onboarding-${suffix}`,
  })
  assert.equal(creation.response.status, 200)
  organizationId = JSON.parse(creation.body).id
  assert(organizationId)
  const pickerSession = await context.internalAdapter.createSession(user.id)
  assert(pickerSession)
  const pickerSignature = await makeSignature(
    pickerSession.token,
    context.secret
  )
  const pickerCookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${pickerSession.token}.${pickerSignature}`)}`
  const unsubscribedPicker = await request(
    "/?returnTo=%2Fprojects",
    undefined,
    pickerCookie
  )
  assert(unsubscribedPicker.body.includes('data-plan="none"'))
  assert(unsubscribedPicker.body.includes('title="0 traces"'))
  const selection = await request("/api/auth/organization/set-active", {
    organizationId,
  })
  assert.equal(selection.response.status, 200)
  for (const path of [
    "/",
    "/projects",
    "/members",
    "/settings/general",
    "/settings/mcp",
    "/usage",
    "/api-keys",
    "/p/unknown/traces",
    "/billing",
  ]) {
    await expectRedirect(path, "/pricing")
  }
  const pricing = await request("/pricing")
  assert.equal(pricing.response.status, 200)
  assert(pricing.body.includes("Choose your plan"))
  assert(pricing.body.includes("Get Core"))
  assert(pricing.body.includes("Get Pro"))
  assert(pricing.body.includes("Sign out"))
  assert(pricing.body.includes("Compare all features"))
  assert(pricing.body.includes("Frequently asked questions"))
  assert(!pricing.body.includes("<footer"))
  const selected = await request("/billing?plan=pro")
  assert(!selected.body.includes("NEXT_REDIRECT"))
  assert(!selected.body.includes('aria-label="Organization settings"'))
  assert(selected.body.includes("Sign out"))
  const denied = await request(
    `/api/organizations/${organizationId}/projects`,
    { name: "Blocked project" }
  )
  assert.equal(denied.response.status, 402)

  // A checkout URL alone never unlocks the workspace.
  const pending = await request("/billing?plan=pro&checkout=success")
  assert.equal(pending.response.status, 200)
  await expectRedirect("/projects", "/pricing")

  // Local subscription fixture verifies the same gate after confirmed payment.
  await db.query(
    `INSERT INTO organization_billing
    (organization_id, subscription_id, price_id, status, current_period_end, access_until, plan, record_limit, checkout_attempt_id, reconcile_after)
    VALUES ($1, $2, $3, 'active', NOW() + INTERVAL '1 day', NOW() + INTERVAL '1 day', 'pro', 1000000, $4, NOW() + INTERVAL '1 day')`,
    [
      organizationId,
      `sub_fixture_${suffix}`,
      process.env.STRIPE_PRO_PRICE_ID,
      randomUUID(),
    ]
  )
  const projectSetup = await request("/projects")
  assert.equal(projectSetup.response.status, 200)
  assert(projectSetup.body.includes("Create your first project"))
  await expectRedirect("/", "/projects")

  // Organization totals include traces from every project, but never their spans.
  for (const count of [1000, 500]) {
    const projectId = randomUUID()
    await db.query(
      `INSERT INTO project (id, organization_id, name, slug)
       VALUES ($1, $2, 'Trace count fixture', $1)`,
      [projectId, organizationId]
    )
    await db.query(
      `INSERT INTO traces (id, project_id, name, operation, status, started_at)
       SELECT $1 || '-trace-' || n, $1, 'Fixture trace', 'test', 'ok', NOW()::text
       FROM generate_series(1, $2::integer) n`,
      [projectId, count]
    )
    await db.query(
      `INSERT INTO spans (id, project_id, trace_id, name, kind, status, started_at)
       SELECT id || '-span', project_id, id, 'Fixture span', 'test', 'ok', started_at
       FROM traces WHERE project_id = $1`,
      [projectId]
    )
  }
  const paidPicker = await request(
    "/?returnTo=%2Fprojects",
    undefined,
    pickerCookie
  )
  assert(paidPicker.body.includes('data-plan="pro"'))
  assert(paidPicker.body.includes("1.5k traces"))
  assert(paidPicker.body.includes('title="1,500 traces"'))
  await db.query(
    "UPDATE organization_billing SET plan='core' WHERE organization_id=$1",
    [organizationId]
  )
  const corePicker = await request(
    "/?returnTo=%2Fprojects",
    undefined,
    pickerCookie
  )
  assert(corePicker.body.includes('data-plan="core"'))

  const newOrganization = await request("/organizations/new")
  assert.equal(newOrganization.response.status, 200)
  assert(newOrganization.body.includes("Create your organization"))
  assert(newOrganization.body.includes("Create &amp; choose a plan"))
  assert(!newOrganization.body.includes("Use an existing organization"))

  // Existing subscriptions retain their billing recovery route.
  await db.query(
    "UPDATE organization_billing SET status='unpaid', access_until=NULL WHERE organization_id=$1",
    [organizationId]
  )
  await expectRedirect("/projects", "/billing")
  const recovery = await request("/billing")
  assert.equal(recovery.response.status, 200)
  assert(recovery.body.includes("Billing &amp; usage"))

  const signOut = await request("/api/auth/sign-out", {})
  assert.equal(signOut.response.status, 200)
  await expectRedirect("/projects", "/sign-in?callbackUrl=%2Fprojects")
  console.log(
    "PASS direct signup, chosen-plan signup, organization creation, retained trace totals, pricing, protected routes/API, checkout confirmation gate, paid project setup, payment recovery, and sign out."
  )
} finally {
  if (organizationId) {
    await db.query(
      "DELETE FROM organization_billing WHERE organization_id=$1",
      [organizationId]
    )
    await db.query("DELETE FROM organization WHERE id=$1", [organizationId])
  }
  if (userId) await db.query('DELETE FROM "user" WHERE id=$1', [userId])
  await analyticsDb.end()
  await db.end()
}
