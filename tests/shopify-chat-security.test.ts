import assert from "node:assert/strict"
import { afterEach, expect, test } from "bun:test"
import { createHmac, randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { configureBuildTestEnvironment } from "./helpers/build-env"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"
import {
  createTracerDatabase,
  closeTracerDatabase,
} from "@/src/server/tracer/db"
import { createBuildContext } from "@/src/server/build/context"
import { createAgent } from "@/src/server/build/agents"
import {
  createChannelConnection,
  createPublicSession,
  enqueuePublicMessage,
  readPublicConversation,
  PublicAdmissionRateLimitError,
} from "@/src/server/build/channels/service"
import { shopifyStorefrontSession } from "@/src/server/build/integrations/shopify-storefront"
import {
  verifyNewVisitorChallenge,
  PublicChallengeRequiredError,
} from "@/src/server/build/channels/challenge"

configureBuildTestEnvironment()
const cleanup: Array<() => Promise<void>> = []
const saved = new Map<string, string | undefined>()
function env(name: string, value: string) {
  if (!saved.has(name)) saved.set(name, process.env[name])
  process.env[name] = value
}
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  saved.clear()
})

async function fixture() {
  env("BETTER_AUTH_SECRET", "s".repeat(64))
  env("BETTER_AUTH_URL", "https://chat.example.test")
  env("DATOOL_SHOPIFY_CLIENT_ID", "fixture-client")
  env("DATOOL_SHOPIFY_CLIENT_SECRET", "fixture-secret")
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const database = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  cleanup.push(async () => {
    await closeTracerDatabase(database)
    await target.close()
  })
  const context = createBuildContext(database, {
    organizationId: target.organizationId,
    actorId: target.ownerId,
  })
  const agent = await createAgent(context, {
    name: "Shopify support",
    slug: "shopify-support",
  })
  const shop = "fixture.myshopify.com"
  const channel = await createChannelConnection(context, {
    agentId: agent.id,
    channel: "web",
    label: "Store chat",
    config: {
      shopifyShop: shop,
      originAllowlist: [`https://${shop}`, "https://store.example.test"],
      publicAdmission: {
        visitorMessagesPerMinute: 2,
        visitorMessagesPerDay: 3,
      },
    },
  })
  const connectionId = randomUUID()
  await database.execute(
    sql`UPDATE build_channel_connection SET status='connected' WHERE id=${channel.id}::uuid`
  )
  await database.execute(sql`INSERT INTO build_app_connections(id,project_id,request_key,toolkit,label,provider_user_id,auth_config_id,status)
    VALUES (${connectionId}::uuid,${context.projectId},${connectionId},'shopify_native',${shop},'fixture','shopify-native-v1','active')`)
  await database.execute(sql`INSERT INTO build_shopify_connections(connection_id,project_id,shop,client_id,authorization_expires_at)
    VALUES (${connectionId}::uuid,${context.projectId},${shop},'fixture-client',now()+interval '10 minutes')`)
  function request(customer = "", changed: Record<string, string> = {}) {
    const query = new URLSearchParams({
      shop,
      logged_in_customer_id: customer,
      path_prefix: "/apps/datool",
      timestamp: String(Math.floor(Date.now() / 1000)),
      ...changed,
    })
    query.set(
      "signature",
      createHmac("sha256", "fixture-secret")
        .update(
          [...query]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join("")
        )
        .digest("hex")
    )
    return new Request(
      `https://chat.example.test/api/shopify/storefront/${channel.id}?${query}`,
      { method: "POST" }
    )
  }
  const session = (customer: string, body: unknown = {}) =>
    shopifyStorefrontSession(context, channel.id, request(customer), body)
  return { context, database, channel, session, request, connectionId }
}

test("Shopify identity shares a customer's threads across devices and revokes a browser on logout or account switch", async () => {
  const f = await fixture()
  const guest = await f.session("")
  const first = await f.session("123", { browserToken: guest.browserToken })
  await enqueuePublicMessage(
    f.context,
    f.channel.id,
    first.conversationId,
    first.visitorToken,
    {
      text: "Customer A private question",
      origin: "https://chat.example.test",
      idempotencyKey: "first",
    }
  )
  const otherDevice = await f.session("123", {
    origin: "https://store.example.test",
  })
  expect(
    JSON.parse(
      Buffer.from(first.visitorToken.split(".")[0], "base64url").toString()
    ).origin
  ).toBe("https://chat.example.test")
  expect(otherDevice.visitorId).toBe(first.visitorId)
  expect(otherDevice.conversationId).toBe(first.conversationId)
  expect(
    (
      await readPublicConversation(
        f.context,
        f.channel.id,
        otherDevice.conversationId,
        otherDevice.visitorToken,
        "https://chat.example.test"
      )
    )[0].text
  ).toBe("Customer A private question")
  const loggedOut = await f.session("", { browserToken: first.browserToken })
  expect(loggedOut.visitorId).toBe(guest.visitorId)
  // A delayed request carrying an old browser credential cannot undo logout.
  await assert.rejects(
    f.session("123", { browserToken: first.browserToken }),
    /Invalid visitor/
  )
  expect(loggedOut.conversationId).not.toBe(first.conversationId)
  await assert.rejects(
    readPublicConversation(
      f.context,
      f.channel.id,
      first.conversationId,
      first.visitorToken,
      "https://chat.example.test"
    ),
    /changed/
  )
  const switched = await f.session("456", {
    browserToken: loggedOut.browserToken,
    conversationId: first.conversationId,
  })
  expect(switched.conversationId).not.toBe(first.conversationId)
  await assert.rejects(
    readPublicConversation(
      f.context,
      f.channel.id,
      first.conversationId,
      switched.visitorToken,
      "https://chat.example.test"
    ),
    /not available/
  )
  // The browser credential alone never authorizes transcript reads.
  await assert.rejects(
    readPublicConversation(
      f.context,
      f.channel.id,
      first.conversationId,
      first.browserToken,
      "https://chat.example.test"
    ),
    /Invalid visitor/
  )
  await f.database.execute(
    sql`UPDATE build_app_connections SET status='disconnected' WHERE id=${f.connectionId}::uuid`
  )
  await assert.rejects(
    readPublicConversation(
      f.context,
      f.channel.id,
      first.conversationId,
      otherDevice.visitorToken,
      "https://chat.example.test"
    ),
    /changed/
  )
}, 30_000)

test("storefront identity rejects tampering, stale signatures and a different store before issuing sessions", async () => {
  const f = await fixture()
  const forged = new URL(f.request("123").url)
  forged.searchParams.set("logged_in_customer_id", "456")
  await assert.rejects(
    shopifyStorefrontSession(f.context, f.channel.id, new Request(forged), {})
  )
  await assert.rejects(
    shopifyStorefrontSession(
      f.context,
      f.channel.id,
      f.request("123", {
        timestamp: String(Math.floor(Date.now() / 1000) - 1000),
      }),
      {}
    )
  )
  await assert.rejects(
    shopifyStorefrontSession(
      f.context,
      f.channel.id,
      f.request("123", { shop: "other.myshopify.com" }),
      {}
    ),
    /unavailable/
  )
  await assert.rejects(
    f.session("123", { origin: "https://attacker.example" }),
    /domain/
  )
  env("DATOOL_TURNSTILE_SITE_KEY", "public-site-key")
  env("DATOOL_TURNSTILE_SECRET_KEY", "private-secret")
  const expired = Buffer.from(
    JSON.stringify({
      id: randomUUID(),
      connectionId: f.channel.id,
      expiresAt: 1,
      version: 1,
    })
  ).toString("base64url")
  const signature = createHmac("sha256", "s".repeat(64))
    .update(`shopify-browser:${expired}`)
    .digest("base64url")
  await assert.rejects(
    f.session("", { browserToken: `${expired}.${signature}` }),
    PublicChallengeRequiredError
  )
  const count = await f.database.execute<{ count: string }>(
    sql`SELECT count(*)::text FROM build_shopify_visitor_sessions`
  )
  expect(count.rows[0].count).toBe("0")
}, 30_000)

test("visitor limits survive conversation resets, IP changes, and minute-bucket cleanup without charging rejected messages", async () => {
  const f = await fixture()
  const one = await createPublicSession(f.context, f.channel.id)
  const two = await createPublicSession(f.context, f.channel.id, {
    visitorToken: one.visitorToken,
  })
  expect(two.visitorId).toBe(one.visitorId)
  for (const [index, session] of [one, two].entries())
    await enqueuePublicMessage(
      f.context,
      f.channel.id,
      session.conversationId,
      session.visitorToken,
      { text: "Hello", idempotencyKey: String(index), clientKey: `ip:${index}` }
    )
  await assert.rejects(
    enqueuePublicMessage(
      f.context,
      f.channel.id,
      two.conversationId,
      two.visitorToken,
      { text: "Too fast", clientKey: "another-ip" }
    ),
    PublicAdmissionRateLimitError
  )
  // Expire only minute counts, preserving the daily ledger across new minute windows.
  await f.database.execute(
    sql`UPDATE build_public_admission_bucket SET window_started_at=window_started_at-interval '3 minutes' WHERE scope='message' AND window_started_at<>date_trunc('day',now())`
  )
  await enqueuePublicMessage(
    f.context,
    f.channel.id,
    two.conversationId,
    two.visitorToken,
    { text: "Third today", idempotencyKey: "third" }
  )
  await assert.rejects(
    enqueuePublicMessage(
      f.context,
      f.channel.id,
      two.conversationId,
      two.visitorToken,
      { text: "Daily quota exceeded" }
    ),
    PublicAdmissionRateLimitError
  )
  const count = await f.database.execute<{ count: string }>(
    sql`SELECT count(*)::text FROM build_channel_job WHERE kind='process_inbound'`
  )
  expect(count.rows[0].count).toBe("3")
  const stranger = await createPublicSession(f.context, f.channel.id)
  await enqueuePublicMessage(
    f.context,
    f.channel.id,
    stranger.conversationId,
    stranger.visitorToken,
    { text: "Another shopper is unaffected" }
  )
}, 30_000)

test("Turnstile requires provider verification, correct hostname, action and deployment binding", async () => {
  env("DATOOL_TURNSTILE_SITE_KEY", "public-site-key")
  env("DATOOL_TURNSTILE_SECRET_KEY", "private-secret")
  env("BETTER_AUTH_URL", "https://chat.example.test")
  const original = globalThis.fetch
  let payload: Record<string, unknown> = {
    success: true,
    hostname: "chat.example.test",
    action: "datool_chat",
    cdata: "channel",
  }
  globalThis.fetch = (async () => Response.json(payload)) as typeof fetch
  try {
    await assert.rejects(
      verifyNewVisitorChallenge("channel"),
      PublicChallengeRequiredError
    )
    await verifyNewVisitorChallenge("channel", "provider-token")
    for (const replacement of [
      { success: false },
      { hostname: "evil.test" },
      { action: "another-form" },
      { cdata: "another-channel" },
    ]) {
      const previous = payload
      payload = { ...payload, ...replacement }
      await assert.rejects(
        verifyNewVisitorChallenge("channel", "provider-token"),
        PublicChallengeRequiredError
      )
      payload = previous
    }
  } finally {
    globalThis.fetch = original
  }
})
