import "next/dist/server/node-environment-baseline"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { makeSignature } from "better-auth/crypto"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "../tests/helpers/postgres"
import { permissionStatements } from "../src/lib/auth/permissions"

// All writes are confined to the explicitly configured disposable loopback schema.
// Run in its own process so shared application pools cannot inherit another fixture.
const target = await createIsolatedPostgres()
const keep = process.argv.includes("--keep-fixture")
let retained = false
const base = "http://localhost:3091"
Object.assign(process.env, {
  DATABASE_URL: target.databaseUrl,
  BETTER_AUTH_URL: base,
  BETTER_AUTH_SECRET: `fixture-${crypto.randomUUID()}-${crypto.randomUUID()}`,
  DATOOL_BUILD_ENABLED: "false",
  DATOOL_BILLING_ENABLED: "false",
  DATOOL_META_APP_SECRET: `fixture-${crypto.randomUUID()}`,
})
const pools = await import("../lib/db")
try {
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const { getAuth } = await import("../lib/auth")
  const { createAgent } = await import("../src/server/build/agents")
  const { createTracerDatabase } = await import("../src/server/tracer/db")
  const { createChannelConnection } =
    await import("../src/server/build/channels/service")
  const { encryptChannelCredentials } =
    await import("../src/server/build/channels/secrets")
  const { POST: buildPost } = await import("../app/api/build/[operation]/route")
  const { GET: appearanceGet } =
    await import("../app/api/build-public/[connectionId]/appearance/route")
  const { POST: sessionPost } =
    await import("../app/api/build-public/[connectionId]/session/route")
  const { POST: telegramPost } =
    await import("../app/api/build-webhooks/telegram/[connectionId]/route")
  const { POST: whatsappPost } =
    await import("../app/api/build-webhooks/whatsapp/route")
  const auth = getAuth()
  const authContext = await auth.$context
  const tenants = []
  for (const name of ["allowed", "excluded"]) {
    const organizationId = crypto.randomUUID(),
      projectId = crypto.randomUUID()
    await pools.db.query(
      'insert into organization(id,name,slug,"createdAt") values($1,$2,$3,now())',
      [organizationId, name, organizationId]
    )
    await pools.db.query(
      'insert into member(id,"organizationId","userId",role,"createdAt") values($1,$2,$3,\'owner\',now())',
      [crypto.randomUUID(), organizationId, target.ownerId]
    )
    await pools.db.query(
      "insert into project(id,organization_id,name,slug) values($1,$2,$3,$3)",
      [projectId, organizationId, name]
    )
    const context = {
      database: createTracerDatabase(undefined, { projectId }),
      projectId,
      organizationId,
      actorId: target.ownerId,
    }
    const agent = await createAgent(context, {
      name: "Rollout fixture",
      configuration: { instructions: "Fixture", model: "test-model" },
    })
    const web = await createChannelConnection(context, {
      agentId: agent.id,
      channel: "web",
      label: "Widget",
    })
    const telegram = await createChannelConnection(context, {
      agentId: agent.id,
      channel: "telegram",
      label: "Telegram",
    })
    const whatsapp = await createChannelConnection(context, {
      agentId: agent.id,
      channel: "whatsapp",
      label: "WhatsApp",
    })
    await pools.db.query(
      "update build_channel_connection set status='connected' where project_id=$1",
      [projectId]
    )
    const webhookSecret = encryptChannelCredentials(
      { value: "fixture-webhook-secret" },
      projectId,
      telegram.id
    )
    await pools.db.query(
      "update build_channel_connection set encrypted_webhook_secret=$1 where id=$2",
      [webhookSecret, telegram.id]
    )
    await pools.db.query(
      "insert into build_whatsapp_account(connection_id,project_id,phone_number_id,waba_id,mode,display_phone_number,activated_at) values($1,$2,$3,$4,'cloud','Fixture',now())",
      [whatsapp.id, projectId, name, name]
    )
    // Legacy connections may have no organization_id: their owning project is authoritative.
    await pools.db.query(
      "update build_channel_connection set organization_id=null where project_id=$1",
      [projectId]
    )
    const key = await auth.api.createApiKey({
      body: {
        organizationId,
        userId: target.ownerId,
        name: "Rollout fixture",
        permissions: permissionStatements(["build:read"]),
        rateLimitMax: 1000,
      },
    })
    const session = await authContext.internalAdapter.createSession(
      target.ownerId
    )
    assert(session)
    await pools.db.query(
      'update session set "activeOrganizationId"=$1 where id=$2',
      [organizationId, session.id]
    )
    const cookieValue = encodeURIComponent(
      `${session.token}.${await makeSignature(session.token, authContext.secret)}`
    )
    tenants.push({
      name,
      organizationId,
      projectId,
      webId: web.id,
      telegramId: telegram.id,
      whatsappId: whatsapp.id,
      key: key.key,
      cookie: `${authContext.authCookies.sessionToken.name}=${cookieValue}`,
    })
  }
  const [allowed, excluded] = tenants
  process.env.DATOOL_BUILD_ORGANIZATION_IDS = allowed.organizationId
  for (const tenant of tenants) {
    const expected = tenant === allowed ? 200 : 404
    const response = await buildPost(
      new Request(`${base}/api/build/build_list_agents`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tenant.key}`,
          "x-project-id": tenant.projectId,
          "content-type": "application/json",
        },
        body: "{}",
      }),
      { params: Promise.resolve({ operation: "build_list_agents" }) }
    )
    assert.equal(
      response.status,
      expected,
      `${tenant.name} authenticated Build API: ${await response.text()}`
    )
    const params = { params: Promise.resolve({ connectionId: tenant.webId }) }
    const appearance = await appearanceGet(
      new Request(`${base}/api/build-public/${tenant.webId}/appearance`, {
        headers: {
          origin: "http://localhost:8086",
          "x-organization-id": allowed.organizationId,
        },
      }),
      params
    )
    assert.equal(
      appearance.status,
      expected,
      `${tenant.name} public appearance`
    )
    if (tenant === allowed)
      assert.equal(
        appearance.headers.get("access-control-allow-origin"),
        "http://localhost:8086"
      )
    const session = await sessionPost(
      new Request(`${base}/api/build-public/${tenant.webId}/session`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: "{}",
      }),
      params
    )
    assert.equal(
      session.status,
      expected,
      `${tenant.name} public session: ${await session.text()}`
    )
    const telegram = await telegramPost(
      new Request(`${base}/api/build-webhooks/telegram/${tenant.telegramId}`, {
        method: "POST",
        headers: {
          "x-telegram-bot-api-secret-token": "fixture-webhook-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          update_id: 1,
          message: {
            message_id: 1,
            chat: { id: 123, type: "private" },
            from: { id: 456, first_name: "Fixture" },
            text: "Fixture message",
          },
        }),
      }),
      { params: Promise.resolve({ connectionId: tenant.telegramId }) }
    )
    assert.equal(
      telegram.status,
      expected,
      `${tenant.name} Telegram ingress: ${await telegram.text()}`
    )
  }
  console.info(
    "PASS authenticated API, public appearance/session, and Telegram organization admission"
  )
  const payload = JSON.stringify({
    object: "whatsapp_business_account",
    entry: tenants.map((tenant) => ({
      id: tenant.name,
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: tenant.name },
            messages: [
              {
                id: `fixture-${tenant.name}`,
                from: "15555550123",
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: "text",
                text: { body: "Fixture message" },
              },
            ],
            statuses: [
              {
                id: `receipt-${tenant.name}`,
                status: "sent",
                timestamp: String(Math.floor(Date.now() / 1000)),
                recipient_id: "15555550123",
              },
            ],
          },
        },
      ],
    })),
  })
  const whatsapp = await whatsappPost(
    new Request(`${base}/api/build-webhooks/whatsapp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${createHmac("sha256", process.env.DATOOL_META_APP_SECRET!).update(payload).digest("hex")}`,
      },
      body: payload,
    })
  )
  assert.equal(whatsapp.status, 200)
  assert.equal((await whatsapp.json()).accepted, 1)
  const jobs = await pools.db.query(
    "select project_id,count(*)::int as count from build_channel_job group by project_id"
  )
  assert.deepEqual(jobs.rows, [{ project_id: allowed.projectId, count: 2 }])
  const receipts = await pools.db.query(
    "select project_id,count(*)::int as count from build_whatsapp_receipt group by project_id"
  )
  assert.deepEqual(receipts.rows, [{ project_id: allowed.projectId, count: 1 }])
  console.info(
    "PASS signed mixed-organization WhatsApp batch admits only enabled messages and receipts"
  )
  process.env.DATOOL_BUILD_ORGANIZATION_IDS = excluded.organizationId
  for (const tenant of tenants) {
    const response = await appearanceGet(
      new Request(`${base}/api/build-public/${tenant.webId}/appearance`),
      { params: Promise.resolve({ connectionId: tenant.webId }) }
    )
    assert.equal(response.status, tenant === excluded ? 200 : 404)
  }
  console.info(
    "PASS runtime allowlist changes reverse admission without rewriting channels"
  )
  if (keep) {
    process.env.DATOOL_BUILD_ORGANIZATION_IDS = allowed.organizationId
    await mkdir("artifacts", { recursive: true })
    await writeFile(
      "artifacts/build-access-fixture.json",
      JSON.stringify({
        base,
        schema: target.schema,
        tenants,
        env: Object.fromEntries(
          [
            "DATABASE_URL",
            "BETTER_AUTH_URL",
            "BETTER_AUTH_SECRET",
            "DATOOL_BUILD_ENABLED",
            "DATOOL_BUILD_ORGANIZATION_IDS",
            "DATOOL_BILLING_ENABLED",
          ].map((name) => [name, process.env[name]])
        ),
      })
    )
    retained = true
    console.info(
      "Fixture retained in artifacts/build-access-fixture.json for local HTTP/browser verification"
    )
  }
} finally {
  await Promise.all([pools.db.end(), pools.analyticsDb.end()])
  if (!retained) await target.close()
}
