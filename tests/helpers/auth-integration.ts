import { strict as assert } from "node:assert"
import { makeSignature } from "better-auth/crypto"
import { createHash } from "node:crypto"
import { getAuth } from "../../lib/auth"
import { db, analyticsDb } from "../../lib/db"
import {
  createOrganizationKey,
  listOrganizationKeys,
  revokeOrganizationKey,
} from "../../src/server/auth/key-management"
import { authorizeOrganizationKey } from "../../src/server/auth/request"
import { withOAuthProject } from "../../src/server/auth/oauth-context"
import { authenticate, mcpConfig } from "../../src/server/mcp/auth"
import { POST as agentPost } from "../../app/api/agent/[operation]/route"
import { POST as mcpPost } from "../../app/api/mcp/route"
import { mcpScopes, workspaceScopes } from "../../src/lib/auth/permissions"

const base = process.env.BETTER_AUTH_URL!
// Simulate an installation created before trace/review scopes were added.
// Better Auth's default insert-only seed leaves these policies unchanged.
for (const resource of ["mcp", "cli"]) {
  await db.query(
    `INSERT INTO "oauthResource" (id, identifier, name, "allowedScopes", metadata, disabled)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      `existing-${resource}`,
      `${base}/api/${resource}`,
      `Existing ${resource} resource`,
      JSON.stringify(["metrics:read", "offline_access"]),
      JSON.stringify({ operatorNote: "preserve me" }),
      resource === "cli",
    ]
  )
}
const auth = getAuth()
await auth.$context
let cookie = ""
const headers = () =>
  new Headers({ origin: base, cookie, "content-type": "application/json" })
async function call(
  path: string,
  body?: unknown,
  extra?: Record<string, string>
) {
  const response = await auth.handler(
    new Request(`${base}/api/auth${path}`, {
      method: body ? "POST" : "GET",
      headers: { ...Object.fromEntries(headers()), ...extra },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  )
  const cookies = response.headers.getSetCookie()
  if (cookies.length)
    cookie = cookies.map((value) => value.split(";")[0]).join("; ")
  const text = await response.text()
  assert(
    text,
    `${path}: empty HTTP ${response.status} location=${response.headers.get("location")}`
  )
  const data = JSON.parse(text)
  assert(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`)
  return data
}
try {
  // Seed the isolated authorization fixture without reopening password signup.
  const context = await auth.$context
  const owner = await context.internalAdapter.createUser(
    {
      name: "Owner",
      email: "owner@example.test",
      emailVerified: true,
    },
    { method: "oauth" }
  )
  const seededSession = await context.internalAdapter.createSession(owner.id)
  assert(seededSession)
  const signature = await makeSignature(seededSession.token, context.secret)
  cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${seededSession.token}.${signature}`)}`
  const session = await auth.api.getSession({ headers: headers() })
  assert(session)
  const ownerCookie = cookie
  const org = await auth.api.createOrganization({
    headers: headers(),
    body: { name: "Org A", slug: "org-a" },
  })
  assert(org)
  const projectId = crypto.randomUUID()
  await db.query(
    "INSERT INTO project (id,organization_id,name,slug,created_at,updated_at) VALUES ($1,$2,'A','a',NOW(),NOW())",
    [projectId, org.id]
  )
  const request = () =>
    new Request(`${base}/api/organizations/${org.id}/api-keys`, {
      method: "POST",
      headers: headers(),
    })
  const key = await createOrganizationKey(request(), org.id, {
    name: "Ingestion",
    expiresIn: null,
  })
  assert(key.key.startsWith("dtk_"))
  const createdKey = (await listOrganizationKeys(request(), org.id)).keys.find(item => item.id === key.id)
  assert(createdKey)
  assert.equal(createdKey.expiresAt, null)
  assert.deepEqual(createdKey.scopes, ["traces:write"])
  const keyRequest = new Request(`${base}/api/traces`, {
    headers: { authorization: `Bearer ${key.key}` },
  })
  assert(
    await authorizeOrganizationKey(keyRequest, projectId, ["traces:write"])
  )
  await assert.rejects(() =>
    authorizeOrganizationKey(keyRequest, projectId, ["metrics:read"])
  )
  await assert.rejects(() =>
    authorizeOrganizationKey(keyRequest, "other-project", ["traces:write"])
  )
  const reader = await createOrganizationKey(request(), org.id, {
    name: "Agent reader", scopes: ["datasets:read", "traces:read", "evals:read"],
  })
  const writer = await createOrganizationKey(request(), org.id, {
    name: "Agent datasets", scopes: ["datasets:read", "datasets:write"],
  })
  const agentCall = (operation: string, apiKey: string, input: unknown = {}, selectedProject = projectId) => agentPost(new Request(`${base}/api/agent/${operation}`, {
    method: "POST", headers: { authorization: `Bearer ${apiKey}`, "x-project-id": selectedProject, "content-type": "application/json" }, body: JSON.stringify(input),
  }), { params: Promise.resolve({ operation }) })
  assert.equal((await agentCall("list_datasets", reader.key)).status, 200)
  assert.equal((await agentCall("describe_agent_operations", reader.key)).status, 200)
  assert.equal((await agentCall("list_traces", reader.key)).status, 200)
  const deniedRead = await agentCall("list_traces", key.key)
  assert.equal(deniedRead.status, 403)
  assert.deepEqual((await deniedRead.json()).error.details, { reason: "INSUFFICIENT_SCOPE", missingScopes: ["traces:read"] })
  assert.equal((await agentCall("list_traces", "dtk_invalid")).status, 401)
  // The real auth plugin masks database errors as INVALID_API_KEY. Simulate
  // connection loss below the plugin and check the public HTTP response.
  const connect = db.connect
  const unavailable = Object.assign(new Error("Fixture database unavailable"), { code: "ECONNREFUSED" })
  db.connect = ((callback?: (error: Error) => void) => {
    if (callback) { queueMicrotask(() => callback(unavailable)); return }
    return Promise.reject(unavailable)
  }) as typeof db.connect
  try {
    const unavailableResponse = await agentCall("list_traces", reader.key)
    assert.equal(unavailableResponse.status, 503)
    assert.equal((await unavailableResponse.json()).error.code, "INTERNAL_ERROR")
  } finally {
    db.connect = connect
  }
  assert.equal((await agentCall("list_traces", reader.key)).status, 200)
  assert.equal((await agentCall("list_traces", "dtk_invalid")).status, 401)
  console.log("PASS organization key database outage returns retryable HTTP 503 and recovers without accepting invalid keys")
  assert.equal((await agentCall("describe_agent_operations", key.key)).status, 200)
  assert.equal((await agentCall("list_eval_runs", reader.key)).status, 200)
  assert(!(await agentCall("create_dataset", reader.key, { name: "Denied" })).ok)
  assert(!(await agentCall("start_eval_run", reader.key, {})).ok)
  assert(!(await agentCall("list_datasets", reader.key, {}, "other-project")).ok)
  const created = await agentCall("create_dataset", writer.key, { name: "API foundation" })
  assert.equal(created.status, 200)
  const dataset = (await created.json()).data
  const snapshot = await agentCall("create_dataset_snapshot", writer.key, { datasetId: dataset.id })
  assert.equal(snapshot.status, 200)
  assert.equal((await agentCall("list_dataset_snapshots", reader.key, { datasetId: dataset.id })).status, 200)
  assert.equal((await agentCall("list_traces", reader.key, { limit: 101 })).status, 400)
  console.log("PASS agent HTTP reads, writes, schema validation and project permissions")
  assert(
    !JSON.stringify(await listOrganizationKeys(request(), org.id)).includes(
      key.key
    )
  )
  await db.query("INSERT INTO organization_key_policy VALUES ($1,true)", [
    org.id,
  ])
  await assert.rejects(() =>
    createOrganizationKey(request(), org.id, { name: "Blocked" })
  )
  await assert.rejects(() =>
    auth.api.createApiKey({
      headers: headers(),
      body: { organizationId: org.id, name: "Direct bypass" },
    })
  )
  await db.query(
    "UPDATE organization_key_policy SET creation_disabled=false WHERE organization_id=$1",
    [org.id]
  )
  await revokeOrganizationKey(request(), org.id, key.id)
  await assert.rejects(
    () => authorizeOrganizationKey(keyRequest, projectId, ["traces:write"]),
    { status: 401 }
  )
  console.log(
    "PASS organization key scope, project boundary, masking, policy, revocation"
  )

  const registration = await call(
    "/oauth2/register",
    {
      application_type: "native",
      client_name: "Test MCP",
      redirect_uris: ["http://127.0.0.1:39871/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "traces:read metrics:read reviews:read reviews:write offline_access",
    },
    { cookie: "" }
  )
  const adminResource = await auth.handler(
    new Request(`${base}/api/auth/admin/oauth2/resources`, {
      headers: headers(),
    })
  )
  assert(!adminResource.ok, "A regular session can administer OAuth resources")
  const verifier = "test-pkce-verifier-abcdefghijklmnopqrstuvwxyz-0123456789"
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const query = new URLSearchParams({
    client_id: registration.client_id,
    redirect_uri: "http://127.0.0.1:39871/callback",
    response_type: "code",
    scope: "traces:read metrics:read reviews:read reviews:write offline_access",
    resource: `${base}/api/mcp`,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "test-state",
  })
  const start = await auth.handler(
    new Request(`${base}/api/auth/oauth2/authorize?${query}`, {
      headers: headers(),
    })
  )
  let destination = start.headers.get("location")
  if (!destination) destination = (await start.json()).url
  assert(
    destination?.includes("/mcp/connect"),
    `Expected project selection: ${destination}`
  )
  const continued = await withOAuthProject(projectId, () =>
    call("/oauth2/continue", {
      postLogin: true,
      oauth_query: new URL(destination!, base).search.slice(1),
    })
  )
  assert(
    continued.url.includes("/mcp/consent"),
    `Expected consent; got ${new URL(continued.url, base).pathname} ${new URL(continued.url, base).searchParams.get("error_description")}`
  )
  const granted = await withOAuthProject(projectId, () =>
    call("/oauth2/consent", {
      accept: true,
      oauth_query: new URL(continued.url, base).search.slice(1),
    })
  )
  const consent = await db.query<{ scopes: string[] }>(
    'SELECT scopes FROM "oauthConsent" WHERE "clientId" = $1 AND "referenceId" = $2',
    [registration.client_id, projectId]
  )
  assert.deepEqual(consent.rows[0].scopes, ["traces:read", "metrics:read", "reviews:read", "reviews:write", "offline_access"])
  const callback = new URL(granted.url)
  assert.equal(callback.searchParams.get("state"), "test-state")
  const code = callback.searchParams.get("code")
  assert(code, `No code: ${granted.url}`)
  const tokenBody = {
    grant_type: "authorization_code",
    code,
    client_id: registration.client_id,
    redirect_uri: "http://127.0.0.1:39871/callback",
    code_verifier: verifier,
    resource: `${base}/api/mcp`,
  }
  async function exchange(body: Record<string, string>) {
    const response = await auth.handler(
      new Request(`${base}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
      })
    )
    return { response, data: await response.json() }
  }
  const wrongPkce = await exchange({
    ...tokenBody,
    code_verifier: "wrong-verifier-abcdefghijklmnopqrstuvwxyz-0123456789",
  })
  assert(!wrongPkce.response.ok)
  // A failed verifier consumes the code. Obtain a fresh grant for the success path.
  const retriedGrant = await withOAuthProject(projectId, () =>
    call("/oauth2/consent", {
      accept: true,
      oauth_query: new URL(continued.url, base).search.slice(1),
    })
  )
  tokenBody.code = new URL(retriedGrant.url).searchParams.get("code")!
  let token = await exchange(tokenBody)
  assert(token.response.ok, JSON.stringify(token.data))
  const mcpRequest = () =>
    new Request(`${base}/api/mcp`, {
      headers: { authorization: `Bearer ${token.data.access_token}` },
    })
  const identity = await authenticate(mcpRequest(), mcpConfig())
  assert.equal(identity.projectId, projectId)
  assert.equal(identity.organizationId, org.id)
  assert.deepEqual(identity.scopes, ["traces:read", "metrics:read", "reviews:read", "reviews:write"])
  for (const [resource, scopes] of [
    ["mcp", mcpScopes],
    ["cli", workspaceScopes],
  ] as const) {
    const policy = await db.query<{
      allowedScopes: string[]
      name: string
      metadata: unknown
      disabled: boolean
    }>(
      'SELECT "allowedScopes", name, metadata, disabled FROM "oauthResource" WHERE identifier = $1',
      [`${base}/api/${resource}`]
    )
    assert.deepEqual(policy.rows[0].allowedScopes, [...scopes, "offline_access"])
    assert.equal(policy.rows[0].name, `Existing ${resource} resource`)
    assert.deepEqual(policy.rows[0].metadata, { operatorNote: "preserve me" })
    assert.equal(policy.rows[0].disabled, resource === "cli")
  }
  async function mcp(method: string, params: Record<string, unknown>) {
    const response = await mcpPost(
      new Request(`${base}/api/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.data.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
    )
    assert.equal(response.status, 200)
    const result = await response.json()
    assert(!result.error, JSON.stringify(result.error))
    assert(!result.result.isError, JSON.stringify(result.result.content))
    return result.result
  }
  const tools = (await mcp("tools/list", {})).tools.map(
    (tool: { name: string }) => tool.name
  )
  assert(tools.includes("get_trace"))
  assert(tools.includes("get_span_path"))
  assert(tools.includes("query_metrics"))
  assert(
    !tools.includes("create_dataset"),
    "Unconsented write scope became available"
  )
  await db.query(
    `INSERT INTO traces (id, project_id, name, operation, status, started_at, input_json)
     VALUES ('oauth-trace', $1, 'OAuth trace', 'test', 'completed', '2026-09-01T00:00:00Z', '{"prompt":"test input"}')`,
    [projectId]
  )
  const trace = await mcp("tools/call", {
    name: "get_trace",
    arguments: { id: "oauth-trace" },
  })
  assert.equal(trace.structuredContent.data.id, "oauth-trace")
  assert.deepEqual(trace.structuredContent.data.input, { prompt: "test input" })
  const oauthReview = (await mcp("tools/call", {
    name: "create_review_session", arguments: { name: "OAuth attribution test", traceIds: ["oauth-trace"] },
  })).structuredContent.data
  const oauthSaved = (await mcp("tools/call", {
    name: "record_review", arguments: { sessionId: oauthReview.id, itemId: oauthReview.items[0].id, expectedRevision: 0, notes: "OAuth AI finding", agent: { name: "Review test", model: "fixture" } },
  })).structuredContent.data
  assert.equal(oauthSaved.label, "AI-labelled")
  assert.equal(oauthSaved.notesProvenance.authType, "oauth")
  assert.equal(oauthSaved.notesProvenance.principal.id, owner.id)
  assert.equal(oauthSaved.notesProvenance.clientId, registration.client_id)
  assert.equal(oauthSaved.humanVerified, false)
  console.log("PASS real OAuth review attribution")
  const refresh = await exchange({
    grant_type: "refresh_token",
    client_id: registration.client_id,
    refresh_token: token.data.refresh_token,
    resource: `${base}/api/mcp`,
  })
  assert(refresh.response.ok, JSON.stringify(refresh.data))
  assert.notEqual(refresh.data.refresh_token, token.data.refresh_token)
  const refreshedIdentity = await authenticate(
    new Request(`${base}/api/mcp`, {
      headers: { authorization: `Bearer ${refresh.data.access_token}` },
    }),
    mcpConfig()
  )
  assert.deepEqual(refreshedIdentity.scopes, ["traces:read", "metrics:read", "reviews:read", "reviews:write"])
  const consents = await db.query<{ id: string }>(
    'SELECT id FROM "oauthConsent" WHERE "userId"=$1 AND "referenceId"=$2',
    [session.user.id, projectId]
  )
  await auth.api.deleteOAuthConsent({
    headers: headers(),
    body: { id: consents.rows[0].id },
  })
  await assert.rejects(() => authenticate(mcpRequest(), mcpConfig()))
  assert(
    !(
      await exchange({
        grant_type: "refresh_token",
        client_id: registration.client_id,
        refresh_token: refresh.data.refresh_token,
        resource: `${base}/api/mcp`,
      })
    ).response.ok,
    "Revoked consent refreshed token"
  )
  // Reconnect gives a new grant; the old refresh token must stay revoked.
  const reconnected = await withOAuthProject(projectId, () =>
    call("/oauth2/consent", {
      accept: true,
      oauth_query: new URL(continued.url, base).search.slice(1),
    })
  )
  tokenBody.code = new URL(reconnected.url).searchParams.get("code")!
  token = await exchange(tokenBody)
  assert(token.response.ok)
  assert(
    !(
      await exchange({
        grant_type: "refresh_token",
        client_id: registration.client_id,
        refresh_token: refresh.data.refresh_token,
        resource: `${base}/api/mcp`,
      })
    ).response.ok,
    "Reconnect revived old refresh token"
  )
  assert(await authenticate(mcpRequest(), mcpConfig()))
  await db.query(
    'DELETE FROM member WHERE "userId"=$1 AND "organizationId"=$2',
    [session.user.id, org.id]
  )
  await assert.rejects(() => authenticate(mcpRequest(), mcpConfig()))
  const revokedRefresh = await exchange({
    grant_type: "refresh_token",
    client_id: registration.client_id,
    refresh_token: token.data.refresh_token,
    resource: `${base}/api/mcp`,
  })
  assert(!revokedRefresh.response.ok, "Removed member refreshed token")
  assert(
    !(await exchange(tokenBody)).response.ok,
    "Authorization code replay accepted"
  )
  cookie = ownerCookie
  console.log(
    "PASS OAuth selection, consent, S256 PKCE, code replay, project binding, refresh rotation, membership revocation"
  )
} finally {
  await analyticsDb.end()
  await db.end()
}
