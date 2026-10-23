import assert from "node:assert/strict"
import { afterEach, expect, spyOn, test } from "bun:test"
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
import { composioUserId } from "@/src/server/build/integrations/provider"
import { Session } from "@shopify/shopify-api"
import { encryptProviderKey } from "@/src/server/model-providers/secrets"
import { saveAction, saveProcedure } from "@/src/server/build/definitions"
import { runAgentTurn } from "@/src/server/build/runtime"
import { shopifyCartTools } from "@/src/server/build/integrations/shopify-cart"
import { createAgent, updateAgent } from "@/src/server/build/agents"
import { ConversationService } from "@/src/server/build/conversations"
import { shopifyShopper } from "@/src/server/build/integrations/shopify-identity"
import { claimShopifyInvitation } from "@/src/server/build/integrations/shopify-invitations"
import {
  createChannelConnection,
  createPublicSession,
  enqueuePublicMessage,
  enqueueAgentTurnResult,
  readPublicConversation,
  PublicAdmissionRateLimitError,
  updateChannelConnection,
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

async function fixture(
  publicAdmission: Record<string, unknown> = {
    visitorMessagesPerMinute: 2,
    visitorMessagesPerDay: 3,
  }
) {
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
      publicAdmission,
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
  return { context, database, channel, session, request, connectionId, agent }
}

async function activateShopifyConnection(
  f: Awaited<ReturnType<typeof fixture>>,
  scope = "read_products,read_legal_policies,write_app_proxy"
) {
  const providerSession = new Session({
    id: "offline_fixture",
    shop: "fixture.myshopify.com",
    state: "",
    isOnline: false,
    scope,
    accessToken: "private-fixture-token",
    expires: new Date(Date.now() + 3600000),
  })
  const encrypted = encryptProviderKey(
    JSON.stringify(providerSession.toPropertyArray()),
    f.context.projectId,
    `shopify:${f.connectionId}`
  )
  await f.database.execute(
    sql`UPDATE build_shopify_connections SET session_encrypted=${encrypted} WHERE connection_id=${f.connectionId}::uuid`
  )
  await f.database.execute(
    sql`UPDATE build_app_connections SET provider_user_id=${composioUserId(f.context.organizationId!, f.context.projectId)} WHERE id=${f.connectionId}::uuid`
  )
}

test("commerce authorization uses admitted Shopify identity and rejects forged metadata, wrong stores and revoked sessions", async () => {
  const f = await fixture()
  const attempts = await Promise.all(
    Array.from({ length: 5 }, () =>
      claimShopifyInvitation(f.context, f.connectionId, "Buyer@example.test")
    )
  )
  expect(attempts.filter(Boolean)).toHaveLength(1)
  expect(
    await claimShopifyInvitation(
      f.context,
      f.connectionId,
      "buyer@example.test"
    )
  ).toBe(false)
  expect(
    await claimShopifyInvitation(
      f.context,
      f.connectionId,
      "neighbor@example.test"
    )
  ).toBe(true)
  await f.database.execute(
    sql`UPDATE build_shopify_invitation_cooldown SET attempted_at=now()-interval '11 minutes' WHERE project_id=${f.context.projectId}`
  )
  expect(
    await claimShopifyInvitation(
      f.context,
      f.connectionId,
      "buyer@example.test"
    )
  ).toBe(true)
  const session = await f.session("123")
  const message = await enqueuePublicMessage(
    f.context,
    f.channel.id,
    session.conversationId,
    session.visitorToken,
    {
      text: "Where is my order?",
      origin: "https://chat.example.test",
      metadata: {
        customerId: "999",
        shop: "other.myshopify.com",
        visitorId: "forged",
      },
    }
  )
  if (!("messageId" in message)) throw new Error("Expected admitted message")
  const jobs = await f.database.execute<{ id: string }>(
    sql`SELECT id FROM build_channel_job WHERE message_id=${message.messageId}`
  )
  const conversations = new ConversationService(f.context)
  const admitted = await conversations.startTurn(session.conversationId, {
    requestKey: `channel:${jobs.rows[0].id}`,
    input: "Where is my order?",
    metadata: {},
    snapshot: {},
  })
  const input = {
    connectionId: f.connectionId,
    conversationId: session.conversationId,
    turnId: admitted.turn.id,
    shop: "fixture.myshopify.com",
  }
  expect(await shopifyShopper(f.context, input)).toMatchObject({
    customerId: "123",
    shop: "fixture.myshopify.com",
  })
  await assert.rejects(
    shopifyShopper(f.context, { ...input, shop: "other.myshopify.com" }),
    /Reconnect/
  )
  await assert.rejects(
    shopifyShopper(f.context, { ...input, connectionId: randomUUID() }),
    /Reconnect/
  )
  await assert.rejects(
    shopifyShopper(f.context, {
      ...input,
      conversationId: "other-conversation",
    }),
    /Reconnect/
  )
  await f.database.execute(
    sql`UPDATE build_app_connections SET status='disconnected' WHERE id=${f.connectionId}::uuid`
  )
  await assert.rejects(shopifyShopper(f.context, input), /Reconnect/)
  await f.database.execute(
    sql`UPDATE build_app_connections SET status='active' WHERE id=${f.connectionId}::uuid`
  )
  expect((await shopifyShopper(f.context, input)).customerId).toBe("123")
  await f.database.execute(
    sql`UPDATE build_shopify_visitor_sessions SET verified_at=now()-interval '6 minutes' WHERE project_id=${f.context.projectId}`
  )
  await assert.rejects(shopifyShopper(f.context, input), /Reconnect/)
  const refreshed = await f.session("123", {
    browserToken: session.browserToken,
  })
  expect((await shopifyShopper(f.context, input)).customerId).toBe("123")
  await f.session("456", { browserToken: refreshed.browserToken })
  await assert.rejects(shopifyShopper(f.context, input), /Reconnect/)
}, 30_000)

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
  await updateChannelConnection(f.context, {
    connectionId: f.channel.id,
    publicAdmission: { visitorMessagesPerDay: null },
  })
  await f.database.execute(
    sql`UPDATE build_public_admission_bucket SET window_started_at=window_started_at-interval '3 minutes' WHERE scope='message' AND window_started_at<>date_trunc('day',now())`
  )
  await enqueuePublicMessage(
    f.context,
    f.channel.id,
    two.conversationId,
    two.visitorToken,
    { text: "The merchant removed the optional daily quota" }
  )
}, 30_000)

test("public chat throttles one visitor's burst without daily quotas or blocking other shoppers", async () => {
  const f = await fixture({})
  let now = Date.now()
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  try {
    const shopper = await createPublicSession(f.context, f.channel.id)
    let sequence = 0
    const send = (session: typeof shopper, clientKey?: string) =>
      enqueuePublicMessage(
        f.context,
        f.channel.id,
        session.conversationId,
        session.visitorToken,
        {
          text: "Product question",
          idempotencyKey: String(sequence++),
          clientKey,
        }
      )
    for (let index = 0; index < 20; index++) await send(shopper, "ip:shared")
    // Flooding by this visitor must not consume the shared IP's allowance.
    await Promise.all(
      Array.from({ length: 120 }, () =>
        assert.rejects(send(shopper, "ip:shared"), (error: unknown) => {
          assert(error instanceof PublicAdmissionRateLimitError)
          assert(error.retryAfterSeconds > 0 && error.retryAfterSeconds <= 60)
          return true
        })
      )
    )
    const neighbor = await createPublicSession(f.context, f.channel.id)
    await send(neighbor, "ip:shared")
    // A busy channel without a trusted client IP still isolates signed visitors.
    await Promise.all(
      Array.from({ length: 30 }, async (_, customer) => {
        const other = await createPublicSession(f.context, f.channel.id, {
          clientKey: `ip:shopper-${customer}`,
        })
        for (let message = 0; message < 20; message++) await send(other)
      })
    )
    // Returning after the cooldown works, including beyond 100 messages/day.
    for (let minute = 0; minute < 5; minute++) {
      now += 60_000
      for (let message = 0; message < 20; message++) await send(shopper)
    }
    const count = await f.database.execute<{ count: string }>(
      sql`SELECT count(*)::text FROM build_channel_job WHERE kind='process_inbound'`
    )
    expect(count.rows[0].count).toBe("721")
  } finally {
    clock.mockRestore()
  }
}, 60_000)

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

for (const flow of [
  "model",
  "procedure",
  "products",
  "products-procedure",
  "products-intent",
  "products-approved",
  "products-approved-procedure",
])
  test(`native cart actions preserve merchant approval and deliver a one-shot browser result to the storefront (${flow})`, async () => {
    const f = await fixture({})
    await activateShopifyConnection(f)
    const action = await saveAction(f.context, f.agent.id, {
      slug: "update-cart",
      definition: {
        type: "integration",
        name: "Update cart",
        connectionId: f.connectionId,
        toolSlug: "SHOPIFY_UPDATE_CART",
        channels: ["web"],
        inputSchema: shopifyCartTools.find(
          (tool) => tool.slug === "SHOPIFY_UPDATE_CART"
        )!.inputSchema,
        shopifySettings: { requireHumanApproval: true },
      },
    })
    const nativeInput = {
      operation: "add",
      items: [{ variantId: "123", quantity: 2 }],
    }
    const productsFlow = flow.startsWith("products")
    const searchAction = productsFlow
      ? await saveAction(f.context, f.agent.id, {
          slug: "search-products",
          definition: {
            type: "integration",
            name: "Search products",
            connectionId: f.connectionId,
            toolSlug: "SHOPIFY_SEARCH_PRODUCTS",
            channels: ["web"],
            shopifySettings: {
              requireHumanApproval: flow.includes("approved"),
            },
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        })
      : action
    if (productsFlow) {
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
        _url: unknown,
        init: RequestInit
      ) => {
        const body = JSON.parse(String(init.body))
        if (!body.query.includes("DatoolProducts"))
          throw new Error("Unexpected external request")
        return Response.json({
          data: {
            shop: {
              currencyCode: "BRL",
              primaryDomain: { url: "https://fixture.myshopify.com" },
            },
            products: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: ["123", "456"].map((id) => ({
                id: `gid://shopify/Product/${id}`,
                title: id === "123" ? "Board wax" : "Helmet",
                description: "Live product",
                handle: id,
                status: "ACTIVE",
                publishedAt: "2020-01-01T00:00:00Z",
                onlineStoreUrl: null,
                priceRangeV2: {
                  minVariantPrice: { amount: "25" },
                  maxVariantPrice: { amount: "25" },
                },
                variants: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: `gid://shopify/ProductVariant/${id}`,
                      title: "Default Title",
                      price: "25",
                      availableForSale: true,
                    },
                  ],
                },
              })),
            },
          },
        })
      }) as typeof fetch)
      cleanup.push(async () => {
        fetchSpy.mockRestore()
      })
    }
    const procedure =
      flow.endsWith("procedure") || flow.endsWith("intent")
        ? await saveProcedure(f.context, f.agent.id, {
            slug: "cart-flow",
            definition: {
              name: "Cart flow",
              trigger: {
                type: flow.endsWith("intent") ? "intent" : "keyword",
                value: "Update cart",
              },
              steps: [
                {
                  id: "cart",
                  kind: "action",
                  actionId: searchAction.id,
                  input: productsFlow ? { query: "" } : nativeInput,
                },
                {
                  id: "next",
                  kind: "message",
                  content: "Continue to checkout when you are ready.",
                },
              ],
            },
          })
        : null
    const agent = await updateAgent(f.context, f.agent.id, {
      expectedRevision: 1,
      apply: true,
      configuration: {
        ...f.agent.configuration,
        model: "test-model",
        channelAllowlist: ["web"],
      },
    })
    const session = await f.session("")
    const dependencies = {
      generateText: (async (options: {
        tools: Record<
          string,
          {
            execute: (
              input: unknown,
              context: { toolCallId: string }
            ) => Promise<unknown>
          }
        >
      }) => {
        const output = await options.tools[
          flow.endsWith("intent")
            ? `procedure_${procedure!.id}`
            : searchAction.id
        ].execute(
          flow.endsWith("intent")
            ? {}
            : productsFlow
              ? { query: "" }
              : nativeInput,
          {
            toolCallId: "cart-call",
          }
        )
        if (flow.endsWith("intent"))
          expect(JSON.stringify(output)).toContain("Board wax")
        return {
          text: "Review your cart request.",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }
      }) as never,
    }
    async function admittedTurn(metadata: Record<string, unknown> = {}) {
      const queued = await enqueuePublicMessage(
        f.context,
        f.channel.id,
        session.conversationId,
        session.visitorToken,
        {
          text: "Update cart",
          origin: "https://chat.example.test",
          metadata,
        }
      )
      if (!("messageId" in queued))
        throw new Error("Expected admitted customer message")
      const jobs = await f.database.execute<{ id: string }>(
        sql`SELECT id FROM build_channel_job WHERE message_id=${queued.messageId}`
      )
      return {
        agentId: f.agent.id,
        channel: "web" as const,
        conversationId: session.conversationId,
        requestKey: `channel:${jobs.rows[0].id}`,
        message: "Update cart",
        metadata: metadata as never,
      }
    }
    let pending = await runAgentTurn(
      f.context,
      await admittedTurn({ shopifyCartApproved: true }),
      { agent, dependencies }
    )
    if (flow.includes("approved")) {
      expect(pending.continuations[0]?.type).toBe("approval_required")
      const continuationId = pending.continuations[0].continuationId
      if (!continuationId)
        throw new Error("Expected product approval capability")
      pending = await runAgentTurn(
        f.context,
        {
          agentId: f.agent.id,
          channel: "web",
          conversationId: session.conversationId,
          requestKey: "trusted-product-approval",
          message: "Approve product search",
          metadata: {
            widgetInteraction: {
              actionId: searchAction.id,
              continuationId,
              input: {},
            },
          },
        },
        {
          agent,
          dependencies,
          trustedApproval: { actionId: searchAction.id, continuationId },
        }
      )
      expect(pending.text).not.toContain("gid://shopify/")
    }
    if (productsFlow) {
      await enqueueAgentTurnResult(f.context, pending, "product-cards")
      const projected = await readPublicConversation(
        f.context,
        f.channel.id,
        session.conversationId,
        session.visitorToken,
        "https://chat.example.test"
      )
      const { shopifyProductsSchema } =
        await import("@/src/lib/build/shopify-products")
      const catalog = shopifyProductsSchema.parse(
        projected.at(-1)?.metadata.shopifyProducts
      )
      const first = catalog.products[0].cartInteraction!
      const second = catalog.products[1].cartInteraction!
      expect(first.actionId).toBe(action.id)
      await assert.rejects(
        runAgentTurn(
          f.context,
          await admittedTurn({
            widgetInteraction: {
              ...second,
              input: { variantId: "999", quantity: 2 },
            },
          }),
          { agent, dependencies }
        ),
        /product selection is no longer available/
      )
      pending = await runAgentTurn(
        f.context,
        await admittedTurn({
          shopifyCartApproved: true,
          widgetInteraction: {
            ...first,
            input: { variantId: "123", quantity: 2 },
          },
        }),
        { agent, dependencies }
      )
      await assert.rejects(
        runAgentTurn(
          f.context,
          await admittedTurn({
            widgetInteraction: {
              ...first,
              input: { variantId: "123", quantity: 2 },
            },
          }),
          { agent, dependencies }
        ),
        /no longer available/
      )
    }
    expect(pending.continuations[0]?.type).toBe("approval_required")
    const approvalId = pending.continuations[0].continuationId
    if (!approvalId) throw new Error("Expected approval capability")
    const approved = await runAgentTurn(
      f.context,
      {
        agentId: f.agent.id,
        channel: "web",
        conversationId: session.conversationId,
        requestKey: "trusted-cart-approval",
        message: "Approve cart request",
        metadata: {
          widgetInteraction: {
            actionId: action.id,
            continuationId: approvalId,
            input: { operation: "set", quantity: 99 },
          },
        },
      },
      {
        agent,
        dependencies,
        trustedApproval: {
          actionId: action.id,
          continuationId: approvalId,
        },
      }
    )
    expect(approved.continuations[0]).toMatchObject({
      type: "client_action",
      shopifyCart: { command: nativeInput },
    })
    await enqueueAgentTurnResult(f.context, approved, "cart-prompt")
    const browserMessages = await readPublicConversation(
      f.context,
      f.channel.id,
      session.conversationId,
      session.visitorToken,
      "https://chat.example.test"
    )
    const publicContinuations = browserMessages.at(-1)?.metadata.continuations
    if (!Array.isArray(publicContinuations))
      throw new Error("Expected public cart control")
    expect(publicContinuations[0]).toMatchObject({
      shopifyCart: { command: nativeInput },
    })
    const cart = {
      currency: "BRL",
      totalPrice: 5000,
      itemCount: 2,
      items: [
        {
          lineKey: "123:line",
          variantId: "123",
          title: "Board wax",
          quantity: 2,
          finalLinePrice: 5000,
          url: "https://fixture.myshopify.com/products/wax",
        },
      ],
      truncated: false,
      cartUrl: "https://fixture.myshopify.com/cart",
      checkoutUrl: "https://fixture.myshopify.com/checkout",
    }
    const interaction = {
      widgetInteraction: {
        actionId: action.id,
        continuationId: approved.continuations[0].continuationId,
        input: {
          cartResult: { status: "completed", cart },
          operation: "set",
          quantity: 99,
        },
      },
    }
    const result = await runAgentTurn(
      f.context,
      await admittedTurn(interaction),
      { agent, dependencies }
    )
    expect(result.status).toBe("completed")
    expect(result.continuations).toEqual([])
    if (flow === "procedure")
      expect(result.text).toContain("Continue to checkout")
    expect(result.message?.metadata.shopifyCart).toEqual(cart)
    await enqueueAgentTurnResult(f.context, result, "cart-result")
    const publicMessages = await readPublicConversation(
      f.context,
      f.channel.id,
      session.conversationId,
      session.visitorToken,
      "https://chat.example.test"
    )
    expect(publicMessages.at(-1)?.metadata.shopifyCart).toEqual(cart)
    if (flow === "model") {
      let nextMessages: Array<{ role: string; content: string }> = []
      await runAgentTurn(f.context, await admittedTurn(), {
        agent,
        dependencies: {
          generateText: (async (options: { messages: typeof nextMessages }) => {
            nextMessages = options.messages
            return {
              text: "I can help with that cart.",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }
          }) as never,
        },
      })
      // The next model turn needs the line key to remove/update the item the shopper just shared.
      expect(
        nextMessages.find(
          (message) =>
            message.role === "assistant" && message.content.includes("123:line")
        )?.content
      ).toContain("Board wax")
    }
    const usage = await f.database.execute<{ status: string }>(
      sql`SELECT status FROM build_usage_event WHERE connection_id=${f.connectionId}::uuid`
    )
    expect(usage.rows).toEqual(
      Array.from({ length: productsFlow ? 2 : 1 }, () => ({
        status: "completed",
      }))
    )
    await assert.rejects(
      runAgentTurn(f.context, await admittedTurn(interaction), {
        agent,
        dependencies,
      }),
      /no longer available/
    )
  }, 60_000)

for (const paymentMethod of ["online", "cash_on_delivery", "free"] as const) {
  for (const orderSource of ["items", "cart"] as const) {
    test(`Shopify orders calculate, confirm and place exactly once (${paymentMethod}, ${orderSource})`, async () => {
      const f = await fixture({ visitorMessagesPerMinute: 120 })
      const requireHumanApproval =
        paymentMethod === "cash_on_delivery" && orderSource === "cart"
      const requirePhone = paymentMethod === "online" && orderSource === "items"
      await activateShopifyConnection(
        f,
        "read_products,read_legal_policies,write_app_proxy,write_draft_orders,read_payment_terms,read_orders,read_customers"
      )
      const { shopifyOrderCreationTools } =
        await import("@/src/server/build/integrations/shopify-order-create")
      const { shopifyCheckoutTools } =
        await import("@/src/server/build/integrations/shopify-order-status")
      const checkAction = await saveAction(f.context, f.agent.id, {
        slug: "check-checkout",
        definition: {
          type: "integration",
          name: "Check checkout",
          connectionId: f.connectionId,
          toolSlug: "SHOPIFY_CHECK_CHECKOUT",
          channels: ["web"],
          inputSchema: shopifyCheckoutTools[0].inputSchema,
        },
      })
      const action = await saveAction(f.context, f.agent.id, {
        slug: "create-order",
        definition: {
          type: "integration",
          name: "Create order",
          connectionId: f.connectionId,
          toolSlug: "SHOPIFY_CREATE_ORDER",
          channels: ["web"],
          inputSchema: shopifyOrderCreationTools[0].inputSchema,
          shopifySettings: {
            requireHumanApproval,
            paymentMethod,
            orderSource,
            shippingPhone: requirePhone ? "required" : "omit",
            orderTags: ["support"],
            orderNote: "Chat order: {{paymentModeLabel}}",
          },
        },
      })
      const input = {
        email: "buyer@example.test",
        items: [{ variantId: "123", quantity: 2 }],
        shippingAddress: {
          firstName: "Alice",
          address1: "123 Main St",
          city: "Austin",
          countryCode: "US",
          phone: "+15555551234",
        },
      }
      let priceChanged = false
      let loseCreateResponse = false
      let loseCompleteResponse = false
      let createdTotalChanged = false
      let stock = 10
      let created = 0
      let completed = 0
      let createdInput: Record<string, unknown> | null = null
      let checking = false
      let checkInput: Record<string, unknown> = {}
      let providerPlaced = false
      let financialStatus = paymentMethod === "free" ? "PAID" : "PENDING"
      let indexed = true
      let duplicateMatch = false
      let wrongBuyer = false
      let wrongTag = false
      const lookups: Array<{
        query: string
        variables: Record<string, unknown>
      }> = []
      const draftId = () => `gid://shopify/DraftOrder/${98 + created}`
      const order = () => ({
        id: `gid://shopify/Order/${99 + created}`,
        name: `#${99 + created}`,
        displayFinancialStatus: financialStatus,
        fullyPaid: financialStatus === "PAID" || financialStatus === "REFUNDED",
        cancelledAt: null,
        currentTotalPriceSet: totals().totalPriceSet,
        email: wrongBuyer ? "someone-else@example.test" : input.email,
        customer:
          paymentMethod === "online"
            ? null
            : { id: `gid://shopify/Customer/${wrongBuyer ? "999" : "123"}` },
        tags: createdInput?.tags,
      })
      const totals = () => {
        const bag = (amount: string) => ({
          presentmentMoney: { amount, currencyCode: "USD" },
        })
        return {
          subtotalPriceSet: bag(paymentMethod === "free" ? "0.00" : "50.00"),
          totalShippingPriceSet: bag(
            paymentMethod === "free" ? "0.00" : "5.00"
          ),
          totalTaxSet: bag(paymentMethod === "free" ? "0.00" : "2.00"),
          totalPriceSet: bag(
            paymentMethod === "free" ? "0.00" : priceChanged ? "60.00" : "57.00"
          ),
        }
      }
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
        _url: unknown,
        init: RequestInit
      ) => {
        const { query, variables } = JSON.parse(String(init.body))
        if (
          query.includes("DatoolCheck") ||
          query.includes("DatoolFindDraftOrder")
        ) {
          lookups.push({ query, variables })
          const snapshot = {
            id: draftId(),
            status: providerPlaced ? "COMPLETED" : "OPEN",
            email: order().email,
            customer: order().customer,
            tags: wrongTag
              ? ["datool-operation-someone-else"]
              : createdInput?.tags,
            invoiceUrl:
              "https://fixture.myshopify.com/invoices/checkout-secret",
            ...totals(),
            order: providerPlaced ? order() : null,
          }
          if (query.includes("DatoolFindDraftOrder"))
            return Response.json({
              data: {
                draftOrders: {
                  nodes: indexed
                    ? duplicateMatch
                      ? [
                          snapshot,
                          { ...snapshot, id: "gid://shopify/DraftOrder/999" },
                        ]
                      : [snapshot]
                    : [],
                  pageInfo: { hasNextPage: false },
                },
              },
            })
          return Response.json({
            data: query.includes("DatoolCheckCreatedOrder")
              ? { order: providerPlaced ? order() : null }
              : { draftOrder: snapshot },
          })
        }
        if (query.includes("DatoolOrderVariants"))
          return Response.json({
            data: {
              nodes: [
                {
                  id: "gid://shopify/ProductVariant/123",
                  title: "Cool weather",
                  availableForSale: true,
                  inventoryQuantity: stock,
                  inventoryPolicy: "DENY",
                  inventoryItem: { tracked: true, requiresShipping: true },
                  product: {
                    title: "Board wax",
                    status: "ACTIVE",
                    publishedAt: "2020-01-01T00:00:00Z",
                    requiresSellingPlan: false,
                  },
                },
              ],
              shop: { currencyCode: "USD" },
              paymentTermsTemplates: [
                {
                  id: "gid://shopify/PaymentTermsTemplate/1",
                  paymentTermsType: "RECEIPT",
                },
              ],
            },
          })
        if (query.includes("DatoolCalculateOrder"))
          return Response.json({
            data: {
              draftOrderCalculate: {
                userErrors: [],
                calculatedDraftOrder: {
                  ...totals(),
                  availableShippingRates: [
                    {
                      handle: "ground",
                      title: "Ground",
                      price: { amount: "5", currencyCode: "USD" },
                    },
                  ],
                  lineItems: [
                    {
                      title: "Board wax",
                      variantTitle: "Cool weather",
                      quantity: 2,
                    },
                  ],
                  transformerFingerprint: null,
                },
              },
            },
          })
        if (query.includes("DatoolCreateOrder")) {
          created++
          createdInput = variables.input
          providerPlaced = false
          if (loseCreateResponse)
            throw new Error("Connection lost after dispatch")
          return Response.json({
            data: {
              draftOrderCreate: {
                userErrors: [],
                draftOrder: {
                  id: draftId(),
                  invoiceUrl:
                    "https://fixture.myshopify.com/invoices/checkout-secret",
                  ...totals(),
                  ...(createdTotalChanged
                    ? {
                        totalPriceSet: {
                          presentmentMoney: {
                            amount: "80",
                            currencyCode: "USD",
                          },
                        },
                      }
                    : {}),
                  paymentTerms:
                    paymentMethod === "cash_on_delivery"
                      ? { paymentTermsType: "RECEIPT" }
                      : null,
                },
              },
            },
          })
        }
        if (query.includes("DatoolCompleteOrder")) {
          completed++
          providerPlaced = true
          if (loseCompleteResponse)
            throw new Error("Connection lost after completing the draft")
          return Response.json({
            data: {
              draftOrderComplete: {
                userErrors: [],
                draftOrder: {
                  id: draftId(),
                  order: order(),
                },
              },
            },
          })
        }
        throw new Error("Unexpected Shopify request")
      }) as typeof fetch)
      cleanup.push(async () => {
        fetchSpy.mockRestore()
      })
      const agent = await updateAgent(f.context, f.agent.id, {
        expectedRevision: 1,
        apply: true,
        configuration: {
          ...f.agent.configuration,
          model: "test-model",
          channelAllowlist: ["web"],
        },
      })
      let session = await f.session(paymentMethod === "online" ? "" : "123")
      const dependencies = {
        generateText: (async (options: {
          tools: Record<
            string,
            {
              execute: (
                args: unknown,
                context: { toolCallId: string }
              ) => Promise<unknown>
            }
          >
        }) => {
          await options.tools[checking ? checkAction.id : action.id].execute(
            checking ? checkInput : input,
            {
              toolCallId: checking ? "check-checkout" : "create-order",
            }
          )
          return {
            text: "Review your order.",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }
        }) as never,
      }
      async function turn(
        metadata: Record<string, unknown> = {},
        approve = false
      ) {
        const queued = await enqueuePublicMessage(
          f.context,
          f.channel.id,
          session.conversationId,
          session.visitorToken,
          {
            text: "Place this order",
            origin: "https://chat.example.test",
            metadata,
          }
        )
        if (!("messageId" in queued))
          throw new Error("Expected customer message")
        const jobs = await f.database.execute<{ id: string }>(
          sql`SELECT id FROM build_channel_job WHERE message_id=${queued.messageId}`
        )
        return runAgentTurn(
          f.context,
          {
            agentId: f.agent.id,
            channel: "web",
            conversationId: session.conversationId,
            requestKey: `channel:${jobs.rows[0].id}`,
            message: "Place this order",
            metadata: metadata as never,
          },
          {
            agent,
            dependencies,
            ...(approve
              ? {
                  trustedApproval: {
                    actionId: action.id,
                    continuationId: (
                      metadata.widgetInteraction as { continuationId: string }
                    ).continuationId,
                  },
                }
              : {}),
          }
        )
      }
      if (requirePhone) {
        stock = 1
        await assert.rejects(turn(), /not enough stock/)
        stock = 10
        // Missing information is rejected before any draft order is created.
        delete (input.shippingAddress as { phone?: string }).phone
        await assert.rejects(turn(), /requires a phone/)
        input.shippingAddress.phone = "+15555551234"
        expect(created).toBe(0)
      }
      let pending = await turn()
      expect(created).toBe(0)
      async function readCart(
        pending: Awaited<ReturnType<typeof turn>>,
        requiresStoreCheckout = false
      ) {
        return turn({
          widgetInteraction: {
            actionId: action.id,
            continuationId: pending.continuations[0].continuationId,
            input: {
              cartResult: {
                status: "completed",
                cart: {
                  currency: "USD",
                  totalPrice: 1,
                  itemCount: 2,
                  items: [
                    {
                      lineKey: "123:key",
                      variantId: "123",
                      title: "Forged cheap price",
                      quantity: 2,
                      finalLinePrice: 1,
                      url: "https://fixture.myshopify.com/products/wax",
                    },
                  ],
                  truncated: false,
                  requiresStoreCheckout,
                  cartUrl: "https://fixture.myshopify.com/cart",
                  checkoutUrl: "https://fixture.myshopify.com/checkout",
                },
              },
            },
          },
        })
      }
      if (orderSource === "cart") {
        expect(pending.continuations[0].shopifyCart?.command).toEqual({
          operation: "read",
        })
        if (paymentMethod === "online") {
          await assert.rejects(
            readCart(pending, true),
            /custom options|subscriptions/
          )
          expect(created).toBe(0)
          pending = await turn()
        }
        pending = await readCart(pending)
      }
      expect(pending.continuations[0].type).toBe(
        requireHumanApproval ? "approval_required" : "client_action"
      )
      if (!requireHumanApproval)
        expect(pending.continuations[0].eventName).toBe("Confirm changes")
      expect(pending.continuations[0].shopifyOrderQuote?.total).toEqual({
        amount: paymentMethod === "free" ? "0" : "57",
        currencyCode: "USD",
      })
      await enqueueAgentTurnResult(f.context, pending, "order-quote")
      const publicMessages = await readPublicConversation(
        f.context,
        f.channel.id,
        session.conversationId,
        session.visitorToken,
        "https://chat.example.test"
      )
      const publicContinuations = publicMessages.at(-1)?.metadata.continuations
      if (!Array.isArray(publicContinuations))
        throw new Error("Expected order quote")
      expect(publicContinuations[0]).toMatchObject({
        shopifyOrderQuote: {
          items: [{ title: "Board wax (Cool weather)", quantity: 2 }],
        },
      })
      expect(created).toBe(0)
      const confirm = (continuationId: string) => ({
        widgetInteraction: {
          actionId: action.id,
          continuationId,
          input: {
            items: [{ variantId: "999", quantity: 99 }],
            total: 0,
            paymentMethod: "free",
          },
        },
      })
      if (paymentMethod === "online") {
        priceChanged = true
        pending = await turn(confirm(pending.continuations[0].continuationId!))
        expect(pending.continuations[0].shopifyOrderQuote?.total.amount).toBe(
          "60"
        )
        expect(created).toBe(0)
      }
      const confirmation = confirm(pending.continuations[0].continuationId!)
      if (requireHumanApproval) {
        await assert.rejects(turn(confirmation), /no longer available/)
        expect(created).toBe(0)
      }
      const result = await turn(confirmation, requireHumanApproval)
      expect(created).toBe(1)
      expect(completed).toBe(paymentMethod === "online" ? 0 : 1)
      expect(createdInput).toMatchObject({
        email: "buyer@example.test",
        lineItems: [
          { variantId: "gid://shopify/ProductVariant/123", quantity: 2 },
        ],
      })
      const submitted = createdInput as unknown as {
        shippingAddress: Record<string, unknown>
        tags: string[]
        purchasingEntity?: unknown
        reserveInventoryUntil?: string
      }
      expect(submitted.tags).toContain("support")
      expect(submitted.tags).toContain("datool")
      if (paymentMethod === "online")
        expect(submitted.reserveInventoryUntil).toBeUndefined()
      else
        expect(Date.parse(submitted.reserveInventoryUntil!) > Date.now()).toBe(
          true
        )
      expect(submitted.shippingAddress.phone).toBe(
        requirePhone ? "+15555551234" : undefined
      )
      if (paymentMethod === "online") {
        expect(result.text).toContain(
          "https://fixture.myshopify.com/invoices/checkout-secret"
        )
        expect(submitted.purchasingEntity).toBeUndefined()
      } else {
        expect(result.text).toContain("#100")
        expect(createdInput).toMatchObject({
          purchasingEntity: { customerId: "gid://shopify/Customer/123" },
        })
        if (paymentMethod === "free")
          expect(createdInput).toMatchObject({
            appliedDiscount: { value: 100, valueType: "PERCENTAGE" },
            shippingLine: { priceWithCurrency: { amount: "0" } },
          })
        else
          expect(createdInput).toMatchObject({
            paymentTerms: {
              paymentTermsTemplateId: "gid://shopify/PaymentTermsTemplate/1",
            },
          })
      }
      await assert.rejects(turn(confirmation), /no longer available/)
      expect(created).toBe(1)
      const recorded = await f.database.execute<{ provider_log_id: string }>(
        sql`SELECT provider_log_id FROM build_usage_event WHERE connection_id=${f.connectionId}::uuid AND provider_log_id IS NOT NULL`
      )
      expect(recorded.rows).toEqual([
        { provider_log_id: "gid://shopify/DraftOrder/99" },
      ])
      async function check(args: Record<string, unknown> = {}) {
        checking = true
        checkInput = args
        try {
          const result = await turn()
          const call = result.toolCalls.find(
            (entry) =>
              entry.turnId === result.turn.id &&
              entry.actionId === checkAction.id
          )
          expect(call?.status).toBe("completed")
          // Read tools feed the model. Inspect that persisted response, not the stub model's fixed reply.
          return {
            ...result,
            text: (call!.output as { message: string }).message,
          }
        } finally {
          checking = false
        }
      }
      const firstOperation =
        pending.continuations[0].shopifyOrderQuote!.operationId
      expect((await check({ operationId: randomUUID() })).text).toContain(
        "no checkout"
      )
      expect(lookups).toHaveLength(0)
      if (paymentMethod === "online") {
        const resumed = await check()
        expect(resumed.text).toContain("existing Shopify checkout")
        expect(resumed.text).toContain("Payment has not been confirmed")
        providerPlaced = true
        expect((await check()).text).toContain("Payment status: pending")
        financialStatus = "PAID"
        expect((await check()).text).toContain("payment is complete")
        financialStatus = "REFUNDED"
        expect((await check()).text).toContain("Payment status: refunded")
      } else {
        expect((await check()).text).toContain("#100")
        // Same customer on another verified device can recover the same conversation.
        session = await f.session("123")
        expect((await check({ operationId: firstOperation })).text).toContain(
          "#100"
        )
      }
      expect(created).toBe(1)
      expect(completed).toBe(paymentMethod === "online" ? 0 : 1)
      const originalSession = session
      session = await f.session(paymentMethod === "online" ? "" : "456")
      const readCount = lookups.length
      expect((await check({ operationId: firstOperation })).text).toContain(
        "no checkout"
      )
      expect(lookups).toHaveLength(readCount)
      session = originalSession
      if (paymentMethod === "online") {
        pending = await turn()
        if (orderSource === "cart") pending = await readCart(pending)
        loseCreateResponse = true
        await assert.rejects(
          turn(confirm(pending.continuations[0].continuationId!)),
          { code: "ACTION_UNCERTAIN" }
        )
        indexed = false
        expect((await check()).text).toContain("still unresolved")
        await assert.rejects(turn(), /previous order.*unresolved/)
        indexed = true
        wrongBuyer = true
        expect((await check()).text).toContain("needs review")
        wrongBuyer = false
        const recovered = await check()
        expect(recovered.text).toContain("existing Shopify checkout")
        expect(recovered.text).toContain(
          "https://fixture.myshopify.com/invoices/checkout-secret"
        )
        expect(recovered.text).toContain("Payment has not been confirmed")
        expect(created).toBe(2)
        expect(completed).toBe(0)
        // Once recovered, later checks use the saved external ID, without another search or create.
        expect((await check()).text).toContain("existing Shopify checkout")
        expect(lookups.at(-1)?.variables.id).toBe(
          "gid://shopify/DraftOrder/100"
        )
        expect(created).toBe(2)
      }
      if (paymentMethod === "online" && orderSource === "items") {
        // A provider success followed by a database failure is still an uncertain write to the caller.
        await f.database.execute(
          sql.raw(`
          CREATE FUNCTION reject_checkout_result() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'fixture: result storage unavailable'; END $$;
          CREATE TRIGGER reject_checkout_result BEFORE UPDATE OF result_json
          ON build_shopify_order_operations FOR EACH ROW EXECUTE FUNCTION reject_checkout_result();
        `)
        )
        loseCreateResponse = false
        pending = await turn()
        await assert.rejects(
          turn(confirm(pending.continuations[0].continuationId!)),
          { code: "ACTION_UNCERTAIN" }
        )
        expect(created).toBe(3)
        await assert.rejects(turn(), /previous order.*unresolved/)
        await f.database.execute(
          sql.raw(
            "DROP TRIGGER reject_checkout_result ON build_shopify_order_operations"
          )
        )
        expect((await check()).text).toContain("existing Shopify checkout")
        expect(created).toBe(3)
        expect(completed).toBe(0)
      }
      if (paymentMethod === "free") {
        pending = await turn()
        loseCreateResponse = orderSource === "items"
        loseCompleteResponse = orderSource === "cart"
        if (orderSource === "cart") pending = await readCart(pending)
        const uncertain = confirm(pending.continuations[0].continuationId!)
        await assert.rejects(turn(uncertain), { code: "ACTION_UNCERTAIN" })
        await assert.rejects(turn(uncertain), /no longer available/)
        expect(created).toBe(2)
        expect(completed).toBe(loseCompleteResponse ? 2 : 1)
        const uncertainty = await f.database.execute<{
          status: string
          provider_log_id: string | null
          provider_session_id: string
        }>(
          sql`SELECT status, provider_log_id, provider_session_id FROM build_usage_event WHERE connection_id=${f.connectionId}::uuid AND status='uncertain'`
        )
        expect(uncertainty.rows).toEqual([
          {
            status: "uncertain",
            provider_log_id: loseCompleteResponse
              ? "gid://shopify/DraftOrder/100"
              : null,
            provider_session_id:
              pending.continuations[0].shopifyOrderQuote?.operationId,
          },
        ])
        // A new model call must not bypass the unresolved financial write by making a new confirmation.
        await assert.rejects(turn(), /previous order.*unresolved/)
        expect(created).toBe(2)
        if (loseCreateResponse) {
          indexed = false
          expect((await check()).text).toContain("still unresolved")
          await assert.rejects(turn(), /previous order.*unresolved/)
          indexed = true
          wrongTag = true
          expect((await check()).text).toContain("still unresolved")
          wrongTag = false
          duplicateMatch = true
          expect((await check()).text).toContain("needs review")
          duplicateMatch = false
          wrongBuyer = true
          expect((await check()).text).toContain("needs review")
          wrongBuyer = false
          // Finding an uncompleted free-order draft must not silently finalize it.
          expect((await check()).text).toContain("needs review")
          expect(completed).toBe(1)
          providerPlaced = true // The store team completes the original draft in Shopify.
        }
        expect((await check()).text).toContain("Order #101 is placed")
        expect(created).toBe(2)
        expect(completed).toBe(loseCompleteResponse ? 2 : 1)
        const recovered = await turn()
        expect(recovered.continuations).toHaveLength(1)
        expect(created).toBe(2)
        if (loseCreateResponse)
          expect(
            lookups.some(
              (lookup) =>
                lookup.variables.query ===
                `tag:"datool-operation-${pending.continuations[0].shopifyOrderQuote!.operationId}"`
            )
          ).toBe(true)
        else
          expect(lookups.at(-1)?.variables.id).toBe(
            "gid://shopify/DraftOrder/100"
          )
      }
      if (paymentMethod === "cash_on_delivery" && orderSource === "items") {
        pending = await turn()
        createdTotalChanged = true
        const review = await turn(
          confirm(pending.continuations[0].continuationId!)
        )
        expect(review.text).toContain("not finalized")
        expect(created).toBe(2)
        expect(completed).toBe(1)
        await assert.rejects(turn(), /previous order.*unresolved/)
        expect(created).toBe(2)
      }
    }, 60_000)
  }
}
