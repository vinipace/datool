import assert from "node:assert/strict"
import { afterEach, expect, spyOn, test } from "bun:test"
import { createHmac, randomUUID } from "node:crypto"
import { readFile, mkdtemp, stat, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
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
import {
  encryptProviderKey,
  decryptProviderKey,
} from "@/src/server/model-providers/secrets"
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
  claimNextChannelJob,
  processChannelJob,
  completeChannelJob,
  failChannelJob,
} from "@/src/server/build/channels/service"
import { handleShopifyCommerceWebhook } from "@/src/server/build/integrations/shopify-webhook"
import { enqueueShopifyReconciliationJobs } from "@/src/server/build/integrations/shopify-reconciliation"
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
  return {
    context,
    database,
    channel,
    session,
    request,
    connectionId,
    agent,
    testDatabaseUrl: target.databaseUrl,
  }
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
  "products-variants",
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
        const variantPage =
          flow === "products-variants" && body.variables.variantAfter
        if (variantPage) {
          expect(body.variables.query).toContain("id:123")
          expect(body.variables.variantAfter).toBe("more-options")
        }
        return Response.json({
          data: {
            shop: {
              currencyCode: "BRL",
              primaryDomain: { url: "https://fixture.myshopify.com" },
            },
            products: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: (variantPage ? ["123"] : ["123", "456"]).map((id) => ({
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
                  pageInfo: {
                    hasNextPage: flow === "products-variants" && !variantPage,
                    endCursor:
                      flow === "products-variants" && !variantPage
                        ? "more-options"
                        : null,
                  },
                  nodes: [
                    {
                      id: `gid://shopify/ProductVariant/${flow === "products-variants" && !variantPage && id === "123" ? "124" : id}`,
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
    if (flow === "products-variants") {
      // An installed action keeps its old saved schema across application upgrades.
      await f.database.execute(sql`UPDATE build_action_revisions
        SET definition_json=jsonb_set(definition_json, '{inputSchema}', ${JSON.stringify({ type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false })}::jsonb)
        WHERE action_id=${searchAction.id}`)
    }
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
      let first = catalog.products[0].cartInteraction!
      const second = catalog.products[1].cartInteraction!
      expect(first.actionId).toBe(action.id)
      if (flow === "products-variants") {
        expect(catalog.products[0].variants[0].cartVariantId).toBe("124")
        const page = catalog.products[0].variantInteraction
        expect(page).toBeDefined()
        const loaded = await runAgentTurn(
          f.context,
          await admittedTurn({
            widgetInteraction: {
              ...page,
              input: {
                query: "different",
                productId: "gid://shopify/Product/456",
                variantAfter: "forged",
              },
            },
          }),
          { agent, dependencies }
        )
        await enqueueAgentTurnResult(f.context, loaded, "variant-page")
        const messages = await readPublicConversation(
          f.context,
          f.channel.id,
          session.conversationId,
          session.visitorToken,
          "https://chat.example.test"
        )
        const next = shopifyProductsSchema.parse(
          messages.at(-1)?.metadata.shopifyProducts
        )
        expect(next.products).toHaveLength(1)
        expect(next.products[0].id).toBe("gid://shopify/Product/123")
        expect(next.products[0].variants[0].cartVariantId).toBe("123")
        expect(next.products[0].variantInteraction).toBeUndefined()
        first = next.products[0].cartInteraction!
        await assert.rejects(
          runAgentTurn(
            f.context,
            await admittedTurn({
              widgetInteraction: { ...page, input: {} },
            }),
            { agent, dependencies }
          ),
          /no longer available/
        )
      }
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
      Array.from(
        { length: flow === "products-variants" ? 3 : productsFlow ? 2 : 1 },
        () => ({
          status: "completed",
        })
      )
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
      let orderQuantity = 2
      let orderVariant = "123"
      let moreOrderItems = false
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
        lineItems: {
          nodes: [
            {
              variant: { id: `gid://shopify/ProductVariant/${orderVariant}` },
              currentQuantity: orderQuantity,
            },
          ],
          pageInfo: { hasNextPage: moreOrderItems },
        },
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
      const purchaseSnapshot = {
        id: randomUUID(),
        expiresAt: Date.now() + 30 * 86400000,
      }
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
                  purchaseSnapshot,
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
            purchaseSnapshot: {
              id: randomUUID(),
              expiresAt: Date.now() + 60000,
            },
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
      async function reconcileCheckout() {
        const response = await handleShopifyCommerceWebhook(
          commerceWebhook(
            {
              admin_graphql_api_id: providerPlaced ? order().id : draftId(),
              tags: `datool-operation-${firstOperation}`,
            },
            { topic: providerPlaced ? "orders/updated" : "draft_orders/update" }
          ),
          f.database
        )
        expect(response.status).toBe(204)
        const job = await reconciliationJob(f)
        await processChannelJob(job, noModel, f.database)
        await completeChannelJob(f.database, job)
        let delivery = await claimNextChannelJob(f.database)
        while (delivery?.kind === "deliver_outbound") {
          await processChannelJob(delivery, noModel, f.database)
          await completeChannelJob(f.database, delivery)
          delivery = await claimNextChannelJob(f.database)
        }
        return readPublicConversation(
          f.context,
          f.channel.id,
          session.conversationId,
          session.visitorToken,
          "https://chat.example.test"
        )
      }
      expect((await check({ operationId: randomUUID() })).text).toContain(
        "no checkout"
      )
      expect(lookups).toHaveLength(0)
      if (paymentMethod === "online") {
        const resumed = await check()
        expect(resumed.text).toContain("existing Shopify checkout")
        expect(resumed.text).toContain("Payment has not been confirmed")
        if (orderSource === "cart") {
          const unpaid = await reconcileCheckout()
          expect(
            unpaid.filter((m) => m.metadata.shopifyCartCleanup)
          ).toHaveLength(0)
        }
        providerPlaced = true
        expect((await check()).text).toContain("Payment status: pending")
        financialStatus = "PAID"
        if (orderSource === "cart") {
          // Payment does not prove that the quoted cart was purchased: a merchant
          // may have edited the order, or the provider read may be incomplete.
          for (const changed of ["quantity", "variant", "page"]) {
            orderQuantity = changed === "quantity" ? 1 : 2
            orderVariant = changed === "variant" ? "999" : "123"
            moreOrderItems = changed === "page"
            const altered = await reconcileCheckout()
            expect(
              altered.filter((m) => m.metadata.shopifyCartCleanup)
            ).toHaveLength(0)
          }
          orderQuantity = 2
          orderVariant = "123"
          moreOrderItems = false
        }
        {
          await f.database.execute(
            sql`UPDATE build_shopify_order_operations SET reconcile_after=NULL WHERE id=${firstOperation}::uuid`
          )
          const response = await handleShopifyCommerceWebhook(
            commerceWebhook({
              admin_graphql_api_id: "gid://shopify/Order/100",
              tags: `datool-operation-${firstOperation}`,
            }),
            f.database
          )
          expect(response.status).toBe(204)
          const job = await reconciliationJob(f)
          await processChannelJob(job, noModel, f.database)
          await completeChannelJob(f.database, job)
          const delivery = await claimNextChannelJob(f.database)
          expect(delivery?.kind).toBe("deliver_outbound")
          await processChannelJob(delivery!, noModel, f.database)
          await completeChannelJob(f.database, delivery!)
          const visible = await readPublicConversation(
            f.context,
            f.channel.id,
            session.conversationId,
            session.visitorToken,
            "https://chat.example.test"
          )
          expect(
            visible.filter(
              (m) =>
                m.direction === "outbound" &&
                m.text.includes("payment is complete")
            )
          ).toHaveLength(1)
          const cleanup = visible.filter((m) => m.metadata.shopifyCartCleanup)
          expect(cleanup).toHaveLength(orderSource === "cart" ? 1 : 0)
          if (orderSource === "cart")
            expect(cleanup[0].metadata.shopifyCartCleanup).toEqual({
              operationId: firstOperation,
              snapshotId: purchaseSnapshot.id,
              expiresAt: purchaseSnapshot.expiresAt,
            })
        }
        expect((await check()).text).toContain("payment is complete")
        financialStatus = "REFUNDED"
        expect((await check()).text).toContain("Payment status: refunded")
        if (orderSource === "items") {
          await handleShopifyCommerceWebhook(
            commerceWebhook({
              admin_graphql_api_id: "gid://shopify/Order/100",
              tags: `datool-operation-${firstOperation}`,
            }),
            f.database
          )
          const refunded = await reconciliationJob(f)
          await processChannelJob(refunded, noModel, f.database)
          await completeChannelJob(f.database, refunded)
          expect(await enqueueShopifyReconciliationJobs(f.database)).toBe(0)
          expect(
            (
              await f.database.execute<{ due: unknown }>(
                sql`SELECT reconcile_after AS due FROM build_shopify_order_operations WHERE id=${firstOperation}::uuid`
              )
            ).rows[0].due
          ).toBeNull()
        }
      } else {
        expect((await check()).text).toContain("#100")
        if (orderSource === "cart") {
          const placed = await reconcileCheckout()
          expect(
            placed
              .filter((m) => m.metadata.shopifyCartCleanup)
              .map((m) => m.metadata.shopifyCartCleanup)
          ).toEqual([
            {
              operationId: firstOperation,
              snapshotId: purchaseSnapshot.id,
              expiresAt: purchaseSnapshot.expiresAt,
            },
          ])
        }
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
      if (orderSource === "items" && paymentMethod !== "online") {
        // Reapply the complete migration to existing real checkout records:
        // unpaid COD needs polling; already-paid free orders need no new alert.
        await f.database.execute(
          sql.raw(`
          ALTER TABLE build_shopify_order_operations DROP COLUMN reconcile_after CASCADE;
          DROP INDEX build_shopify_reconciliation_active;
          DROP TABLE build_shopify_webhook_receipts;
        `)
        )
        await f.database.execute(
          sql.raw(
            await readFile(
              new URL(
                "../migrations/0069_shopify_reconciliation.sql",
                import.meta.url
              ),
              "utf8"
            )
          )
        )
        const migrated = await f.database.execute<{ due: unknown }>(
          sql`SELECT reconcile_after AS due FROM build_shopify_order_operations WHERE id=${firstOperation}::uuid`
        )
        expect(migrated.rows[0].due !== null).toBe(
          paymentMethod === "cash_on_delivery"
        )
      }
    }, 60_000)
  }
}

async function returnRuntimeFixture(
  options: {
    guest?: boolean
    approval?: boolean
    exchange?: boolean
    fulfillment?: boolean
  } = {}
) {
  const f = await fixture({ visitorMessagesPerMinute: 120 })
  await activateShopifyConnection(
    f,
    "read_products,read_legal_policies,write_app_proxy,read_orders,read_customers,write_returns,write_orders" +
      (options.fulfillment ? ",write_merchant_managed_fulfillment_orders" : "")
  )
  const { shopifyReturnTools } =
    await import("@/src/server/build/integrations/shopify-return-process")
  const { shopifyReturnStatusTools } =
    await import("@/src/server/build/integrations/shopify-return-status")
  const { shopifyReturnFixture } = await import("./helpers/shopify-return")
  const provider = shopifyReturnFixture()
  const input: Record<string, unknown> = {
    ...provider.input,
    ...(options.guest
      ? { orderNumber: "#1001", email: "buyer@example.test" }
      : {}),
    replacements: options.exchange ? [{ variantId: "60", quantity: 1 }] : [],
  }
  let action = await saveAction(f.context, f.agent.id, {
    slug: "return-items",
    definition: {
      type: "integration",
      name: "Return or exchange items",
      connectionId: f.connectionId,
      toolSlug: "SHOPIFY_RETURN_OR_EXCHANGE",
      channels: ["web"],
      inputSchema: shopifyReturnTools[0].inputSchema,
      shopifySettings: {
        requireHumanApproval: options.approval ?? false,
        allowExchanges: options.exchange ?? false,
      },
    },
  })
  const checkAction = await saveAction(f.context, f.agent.id, {
    slug: "check-return",
    definition: {
      type: "integration",
      name: "Check return",
      connectionId: f.connectionId,
      toolSlug: "SHOPIFY_CHECK_RETURN",
      channels: ["web"],
      inputSchema: shopifyReturnStatusTools[0].inputSchema,
    },
  })
  let checking = false
  let checkInput: Record<string, unknown> = {}
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    url: RequestInfo | URL,
    init?: RequestInit
  ) => {
    const request = new Request(url, init)
    if (!request.url.startsWith("https://fixture.myshopify.com/admin/api/"))
      throw new Error("Unexpected network request")
    const { query, variables } = (await request.json()) as {
      query: string
      variables: Record<string, unknown>
    }
    return provider.graphql(query, { variables })
  }) as typeof fetch)
  cleanup.push(async () => {
    fetchSpy.mockRestore()
  })
  let agent = await updateAgent(f.context, f.agent.id, {
    expectedRevision: 1,
    apply: true,
    configuration: {
      ...f.agent.configuration,
      model: "test-model",
      channelAllowlist: ["web"],
    },
  })
  let session = await f.session(options.guest ? "" : "123")
  const dependencies = {
    generateText: (async ({
      tools,
    }: {
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
      await tools[checking ? checkAction.id : action.id].execute(
        checking ? checkInput : input,
        {
          toolCallId: checking ? "check-return" : "return-items",
        }
      )
      return {
        text: "Review your return.",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }
    }) as never,
  }
  const confirm = (continuationId: string) => ({
    widgetInteraction: {
      actionId: action.id,
      continuationId,
      input: {
        items: [
          {
            fulfillmentLineItemId: "gid://shopify/FulfillmentLineItem/999",
            quantity: 99,
          },
        ],
        refundAmount: 999999,
      },
    },
  })
  async function turn(metadata: Record<string, unknown> = {}, approve = false) {
    // Inbox approval is an operator turn, not a fresh storefront message.
    let requestKey = `operator:${randomUUID()}`
    if (!approve) {
      const queued = await enqueuePublicMessage(
        f.context,
        f.channel.id,
        session.conversationId,
        session.visitorToken,
        {
          text: "Return these items",
          origin: "https://chat.example.test",
          metadata,
        }
      )
      if (!("messageId" in queued)) throw new Error("Expected admitted message")
      const jobs = await f.database.execute<{ id: string }>(
        sql`SELECT id FROM build_channel_job WHERE message_id=${queued.messageId}`
      )
      requestKey = `channel:${jobs.rows[0].id}`
    }
    return runAgentTurn(
      f.context,
      {
        agentId: f.agent.id,
        channel: "web",
        conversationId: session.conversationId,
        requestKey,
        message: "Return these items",
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
  return {
    ...f,
    provider,
    input,
    turn,
    confirm,
    refreshSession: async (sameBrowser = true) => {
      session = await f.session(options.guest ? "" : "123", {
        ...(sameBrowser ? { browserToken: session.browserToken } : {}),
        conversationId: session.conversationId,
      })
      return session
    },
    setSettings: async (settings: Record<string, unknown>) => {
      if (action.definition.type !== "integration")
        throw new Error("Expected integration")
      action = await saveAction(f.context, f.agent.id, {
        id: action.id,
        expectedRevision: action.revision,
        definition: {
          ...action.definition,
          shopifySettings: {
            ...action.definition.shopifySettings,
            ...settings,
          },
        },
      })
      agent = await updateAgent(f.context, f.agent.id, {
        expectedRevision: agent.currentRevision,
        apply: true,
        configuration: agent.configuration,
      })
    },
    check: async (args: Record<string, unknown> = {}) => {
      checking = true
      checkInput = args
      try {
        const result = await turn()
        const call = result.toolCalls.find(
          (entry) =>
            entry.turnId === result.turn.id && entry.actionId === checkAction.id
        )
        expect(call?.status).toBe("completed")
        return call!.output as Record<string, unknown>
      } finally {
        checking = false
      }
    },
    newConversation: async () => {
      const original = session
      const previous = session.conversationId
      session = await f.session(options.guest ? "" : "123")
      expect(session.conversationId).not.toBe(previous)
      return () => {
        session = original
      }
    },
  }
}

for (const changedQuote of [false, true]) {
  test(`Shopify delayed approval survives session reverification with pinned inputs (changed quote: ${changedQuote})`, async () => {
    const f = await returnRuntimeFixture({
      approval: true,
      guest: changedQuote,
    })
    const pending = await f.turn()
    const original = pending.continuations[0]
    await f.database.execute(sql`
      UPDATE build_shopify_visitor_sessions SET verified_at=now()-interval '6 minutes'
      WHERE project_id=${f.context.projectId}
    `)
    const before = f.provider.calls.length
    const approved = await f.turn(f.confirm(original.continuationId!), true)
    const continuation = approved.continuations[0]
    expect(approved.status).toBe("awaiting_client")
    expect(continuation.type).toBe("client_action")
    expect(continuation.eventName).toBe("Continue approved change")
    expect(continuation.shopifyReturnQuote).toEqual(original.shopifyReturnQuote)
    expect(f.provider.calls).toHaveLength(before)
    expect(f.provider.state.created).toBe(0)
    await enqueueAgentTurnResult(
      f.context,
      approved,
      `operator:${approved.turn.id}`
    )
    await assert.rejects(
      f.turn(f.confirm(original.continuationId!), true),
      /no longer available/
    )
    const refreshed = await f.refreshSession()
    const delivered = await readPublicConversation(
      f.context,
      f.channel.id,
      refreshed.conversationId,
      refreshed.visitorToken,
      "https://chat.example.test"
    )
    expect(JSON.stringify(delivered)).toContain("Continue approved change")
    if (changedQuote) {
      f.provider.state.returnedPrice = "20.99"
      f.provider.state.transferAmount = "20.7"
    }
    const confirmation = f.confirm(continuation.continuationId!)
    let result = await f.turn(confirmation)
    if (changedQuote) {
      expect(result.continuations[0].type).toBe("approval_required")
      expect(result.continuations[0].shopifyReturnQuote?.operationId).toBe(
        original.shopifyReturnQuote?.operationId
      )
      expect(
        result.continuations[0].shopifyReturnQuote?.settlement.amount
      ).toBe("20.7")
      expect(f.provider.state.created).toBe(0)
      const changed = f.confirm(result.continuations[0].continuationId!)
      await assert.rejects(f.turn(changed), /no longer available/)
      result = await f.turn(changed, true)
    }
    expect(result.status).toBe("completed")
    expect(result.text).toContain("confirmed the refund")
    expect(f.provider.state.created).toBe(1)
    expect(f.provider.state.processed).toBe(1)
    const processing = f.provider.calls.find((call) =>
      call.query.includes("DatoolProcessReturn")
    )!.variables.input as Record<string, unknown>
    expect(processing.returnLineItems).toEqual([
      { id: "gid://shopify/ReturnLineItem/1", quantity: 1 },
    ])
    await assert.rejects(f.turn(confirmation), /no longer available/)
    expect(f.provider.state.processed).toBe(1)
  }, 60_000)
}

test("Shopify delayed approval cannot transfer to another browser of the same customer", async () => {
  const f = await returnRuntimeFixture({ approval: true })
  const pending = await f.turn()
  await f.database.execute(sql`
    UPDATE build_shopify_visitor_sessions SET verified_at=now()-interval '6 minutes'
    WHERE project_id=${f.context.projectId}
  `)
  const approved = await f.turn(
    f.confirm(pending.continuations[0].continuationId!),
    true
  )
  const before = f.provider.calls.length
  await f.refreshSession(false)
  await assert.rejects(
    f.turn(f.confirm(approved.continuations[0].continuationId!)),
    /verify|session/i
  )
  expect(f.provider.calls).toHaveLength(before)
  expect(f.provider.state.created).toBe(0)
}, 60_000)

for (const revoked of ["connection", "identity"] as const) {
  test(`Shopify delayed approval cannot revive a revoked ${revoked}`, async () => {
    const f = await returnRuntimeFixture({ approval: true })
    const pending = await f.turn()
    const session = await f.refreshSession()
    if (revoked === "connection") {
      await f.database.execute(sql`
        UPDATE build_app_connections SET status='disconnected'
        WHERE id=${f.connectionId}::uuid
      `)
    } else {
      await f.session("456", { browserToken: session.browserToken })
    }
    const before = f.provider.calls.length
    await assert.rejects(
      f.turn(f.confirm(pending.continuations[0].continuationId!), true),
      /verify|session/i
    )
    expect(f.provider.calls).toHaveLength(before)
    expect(f.provider.state.created).toBe(0)
  }, 60_000)
}

test("unfinished replacement exchanges cannot be configured or executed", async () => {
  const f = await fixture()
  await activateShopifyConnection(f)
  const { listAppTools, executeAppAction } =
    await import("@/src/server/build/integrations/service")
  expect(
    (await listAppTools(f.context, f.connectionId)).some(
      (tool) => tool.slug === "SHOPIFY_CREATE_EXCHANGE_ORDER"
    )
  ).toBe(false)
  await assert.rejects(
    saveAction(f.context, f.agent.id, {
      slug: "replacement",
      definition: {
        type: "integration",
        name: "Replacement",
        connectionId: f.connectionId,
        toolSlug: "SHOPIFY_CREATE_EXCHANGE_ORDER",
        channels: ["web"],
        inputSchema: { type: "object", properties: {} },
      },
    }),
    /Choose an enabled action/
  )
  const conversations = new ConversationService(f.context)
  const conversation = await conversations.getOrCreate({
    agentId: f.agent.id,
    channel: "web",
    metadata: {},
  })
  const { turn } = await conversations.startTurn(conversation.id, {
    requestKey: "old-replacement",
    input: "Exchange",
    metadata: {},
    snapshot: {},
  })
  let providerCalls = 0
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
    providerCalls++
    throw new Error("Unexpected provider request")
  })
  try {
    await assert.rejects(
      executeAppAction(f.context, {
        connectionId: f.connectionId,
        toolSlug: "SHOPIFY_CREATE_EXCHANGE_ORDER",
        agentId: f.agent.id,
        conversationId: conversation.id,
        turnId: turn.id,
        toolCallId: "old-replacement",
        arguments: {},
      }),
      /unavailable/i
    )
    expect(providerCalls).toBe(0)
  } finally {
    fetchSpy.mockRestore()
  }
}, 60_000)

for (const scenario of [
  "refund",
  "pending",
  "collect",
  "even",
  "exchange-refund",
] as const) {
  test(`Shopify return runtime confirms and processes original-order settlement (${scenario})`, async () => {
    const exchange = ["collect", "even", "exchange-refund"].includes(scenario)
    const approval = scenario === "even"
    const f = await returnRuntimeFixture({
      guest: scenario === "refund",
      exchange,
      approval,
    })
    const s = f.provider.state
    if (scenario === "pending") s.refundStatus = "PENDING"
    if (scenario === "collect") {
      s.direction = "InvoiceReturnOutcome"
      s.transferAmount = "0.4"
    }
    if (scenario === "even") {
      s.replacementPrice = "19.60"
      s.transferAmount = "0"
    }
    if (scenario === "exchange-refund") {
      s.replacementPrice = "10.00"
      s.transferAmount = "9.6"
    }
    let pending = await f.turn()
    expect(pending.continuations[0].type).toBe(
      approval ? "approval_required" : "client_action"
    )
    expect(pending.continuations[0].shopifyReturnQuote?.items).toEqual([
      { title: "Board wax 101", quantity: 1 },
    ])
    expect(s.created).toBe(0)
    if (scenario === "refund") {
      s.omitMaximumRefundable = true // Shopify documents this field as nullable.
      // Consent to the old amount cannot authorize a changed quote.
      s.returnedPrice = "20.99"
      s.transferAmount = "20.7"
      pending = await f.turn(
        f.confirm(pending.continuations[0].continuationId!)
      )
      expect(
        pending.continuations[0].shopifyReturnQuote?.settlement.amount
      ).toBe("20.7")
      expect(s.created).toBe(0)
    }
    const confirmation = f.confirm(pending.continuations[0].continuationId!)
    if (approval) {
      expect(pending.continuations[0].message).toContain(
        "No payment difference"
      )
      await assert.rejects(f.turn(confirmation), /no longer available/)
      expect(s.created).toBe(0)
    }
    const result = await f.turn(confirmation, approval)
    expect(s.created).toBe(1)
    expect(s.processed).toBe(1)
    expect(s.invoices).toBe(scenario === "collect" ? 1 : 0)
    expect(result.text).toContain(
      scenario === "pending"
        ? "refund is pending"
        : scenario === "collect"
          ? "payment invoice"
          : scenario === "even"
            ? "no payment difference"
            : "confirmed the refund"
    )
    const processing = f.provider.calls.find((call) =>
      call.query.includes("DatoolProcessReturn")
    )!.variables.input as Record<string, unknown>
    expect(processing.returnLineItems).toEqual([
      { id: "gid://shopify/ReturnLineItem/1", quantity: 1 },
    ])
    expect(JSON.stringify(processing)).not.toContain("999")
    if (["refund", "pending", "exchange-refund"].includes(scenario))
      expect(processing.financialTransfer).toEqual({
        issueRefund: {
          allowOverRefunding: false,
          orderTransactions: [
            {
              parentId: "gid://shopify/OrderTransaction/300",
              transactionAmount: {
                amount: s.transferAmount,
                currencyCode: "USD",
              },
            },
          ],
        },
      })
    else expect(processing.financialTransfer).toBeUndefined()
    const saved = await f.database.execute<{
      status: string
      return_id: string
      result_json: { paymentStatus: string }
    }>(
      sql`SELECT status,return_id,result_json FROM build_shopify_order_operations WHERE kind='return'`
    )
    expect(saved.rows).toHaveLength(1)
    expect(saved.rows[0]).toMatchObject({
      status: "return_processed",
      return_id: "gid://shopify/Return/1",
      result_json: {
        paymentStatus:
          scenario === "pending"
            ? "refund_pending"
            : scenario === "collect"
              ? "payment_required"
              : scenario === "even"
                ? "no_payment_difference"
                : "refunded",
      },
    })
    await assert.rejects(f.turn(confirmation, approval), /no longer available/)
    expect(s.processed).toBe(1)
  }, 60_000)
}

for (const lost of [
  "create",
  "process",
  "invoice",
  "record",
  "finish",
] as const) {
  test(`Shopify return runtime preserves uncertain ${lost} and blocks another conversation from repeating it`, async () => {
    const f = await returnRuntimeFixture({
      guest: true,
      exchange: lost === "invoice",
    })
    const s = f.provider.state
    if (lost === "invoice") {
      s.direction = "InvoiceReturnOutcome"
      s.transferAmount = "0.4"
    }
    const pending = await f.turn()
    s.lost = lost === "record" || lost === "finish" ? "" : lost
    if (lost === "record" || lost === "finish") {
      await f.database.execute(
        sql.raw(`
        CREATE FUNCTION reject_return_storage() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'fixture: return storage unavailable'; END $$;
        CREATE TRIGGER reject_return_storage BEFORE UPDATE OF ${lost === "record" ? "return_id" : "result_json"}
        ON build_shopify_order_operations FOR EACH ROW EXECUTE FUNCTION reject_return_storage();
      `)
      )
    }
    await assert.rejects(
      f.turn(f.confirm(pending.continuations[0].continuationId!)),
      { code: "ACTION_UNCERTAIN" }
    )
    const saved = await f.database.execute<{
      status: string
      return_id: string | null
    }>(
      sql`SELECT status,return_id FROM build_shopify_order_operations WHERE kind='return'`
    )
    expect(saved.rows[0]).toEqual({
      status: "uncertain",
      return_id:
        lost === "create" || lost === "record"
          ? null
          : "gid://shopify/Return/1",
    })
    const restore = await f.newConversation()
    const retry = await f.turn()
    await assert.rejects(
      f.turn(f.confirm(retry.continuations[0].continuationId!)),
      /still being processed|needs review/
    )
    const operationId = pending.continuations[0].shopifyReturnQuote!.operationId
    const reads = f.provider.calls.length
    expect((await f.check({ operationId })).status).toBe("not_found")
    expect(f.provider.calls.length).toBe(reads)
    restore()
    if (lost === "record" || lost === "finish") {
      await f.database.execute(
        sql.raw(
          "DROP TRIGGER reject_return_storage ON build_shopify_order_operations"
        )
      )
    }
    const recovered = await f.check({ operationId })
    expect(recovered).toMatchObject({
      returnId: "gid://shopify/Return/1",
      operationId,
      status:
        lost === "create" || lost === "record"
          ? "needs_review"
          : "return_processed",
      ...(lost === "create" || lost === "record"
        ? {}
        : {
            paymentStatus: lost === "invoice" ? "payment_required" : "refunded",
          }),
    })
    if (lost === "invoice") expect(recovered.paymentUrl).toBe(s.paymentUrl)
    expect(
      (
        await f.database.execute(
          sql`SELECT return_id FROM build_shopify_order_operations WHERE id=${operationId}::uuid`
        )
      ).rows[0].return_id
    ).toBe("gid://shopify/Return/1")
    const replayed = await f.check({ operationId })
    expect(replayed.status).toBe(recovered.status)
    if (lost === "finish") {
      s.guestEmail = "different-buyer@example.test"
      const denied = await f.check({ operationId })
      expect(denied.status).toBe("needs_review")
      expect(JSON.stringify(denied)).not.toContain("different-buyer")
      expect(denied.returnId).toBeUndefined()
    }
    expect(s.created).toBe(1)
    expect(s.processed).toBe(lost === "create" || lost === "record" ? 0 : 1)
    expect(s.invoices).toBe(lost === "invoice" ? 1 : 0)
  }, 60_000)
}

for (const changed of ["owner", "balance", "transaction"] as const) {
  test(`Shopify return runtime stops before money moves when ${changed} changes`, async () => {
    const f = await returnRuntimeFixture()
    const s = f.provider.state
    const pending = await f.turn()
    if (changed === "owner") s.foreignOutcome = true
    if (changed === "balance") s.transferAmount = "18.00"
    if (changed === "transaction") s.foreignTransaction = true
    const result = await f.turn(
      f.confirm(pending.continuations[0].continuationId!)
    )
    expect(result.text).toContain(
      changed === "owner"
        ? "Order access changed"
        : changed === "balance"
          ? "changed the return balance"
          : "original payment methods"
    )
    expect(s.created).toBe(1)
    expect(s.processed).toBe(0)
    expect(
      (
        await f.database.execute(
          sql`SELECT status FROM build_shopify_order_operations WHERE kind='return'`
        )
      ).rows[0].status
    ).toBe("needs_review")
  }, 60_000)
}

test("Shopify return runtime does not invoice an unapproved existing balance", async () => {
  const f = await returnRuntimeFixture({ exchange: true })
  const s = f.provider.state
  s.direction = "InvoiceReturnOutcome"
  s.transferAmount = "0.4"
  const pending = await f.turn()
  s.outstanding = "9.4"
  const result = await f.turn(
    f.confirm(pending.continuations[0].continuationId!)
  )
  expect(s.processed).toBe(1)
  expect(s.invoices).toBe(0)
  expect(result.text).toContain("outstanding balance differs")
  expect(
    (
      await f.database.execute(
        sql`SELECT status FROM build_shopify_order_operations WHERE kind='return'`
      )
    ).rows[0].status
  ).toBe("needs_review")
}, 60_000)

test("Shopify return recovery rejects ambiguous matches and changed ownership, then tracks the original pending refund", async () => {
  const f = await returnRuntimeFixture()
  const s = f.provider.state
  const pending = await f.turn()
  s.lost = "create"
  await assert.rejects(
    f.turn(f.confirm(pending.continuations[0].continuationId!)),
    { code: "ACTION_UNCERTAIN" }
  )
  for (const mode of [
    "missing",
    "partial_marker",
    "duplicate",
    "repeat_cursor",
  ] as const) {
    s.returnSearch = mode
    expect((await f.check()).status).toBe("needs_review")
  }
  s.returnSearch = "normal"
  s.foreignReturn = true
  expect((await f.check()).status).toBe("needs_review")
  expect(
    f.provider.calls.some((call) =>
      call.query.includes("DatoolCheckCreatedReturn")
    )
  ).toBe(false)
  s.foreignReturn = false
  // Shopify subsequently completes the original return; the original request must never replay.
  s.processed = 1
  s.refundStatus = "PENDING"
  expect(await f.check()).toMatchObject({
    status: "return_processed",
    paymentStatus: "refund_pending",
  })
  s.partialProcessing = true
  expect((await f.check()).status).toBe("needs_review")
  s.partialProcessing = false
  s.refundStatus = "FAILURE"
  expect((await f.check()).status).toBe("needs_review")
  s.refundStatus = "SUCCESS"
  s.moreTransactions = true
  expect((await f.check()).status).toBe("needs_review")
  s.moreTransactions = false
  expect(await f.check()).toMatchObject({
    status: "return_processed",
    paymentStatus: "refunded",
  })
  expect(s.created).toBe(1)
  expect(
    f.provider.calls.filter((call) => call.query.includes("mutation")).length
  ).toBe(1)
}, 60_000)

test("Shopify return recovery only offers the approved exchange balance and distinguishes pending from paid", async () => {
  const f = await returnRuntimeFixture({ exchange: true })
  const s = f.provider.state
  s.direction = "InvoiceReturnOutcome"
  s.transferAmount = "0.4"
  const pending = await f.turn()
  await f.turn(f.confirm(pending.continuations[0].continuationId!))
  expect(await f.check()).toMatchObject({
    paymentStatus: "payment_required",
    paymentUrl: s.paymentUrl,
  })
  s.paymentUrl = "javascript:alert(1)"
  expect((await f.check()).paymentUrl).toBeUndefined()
  s.outstanding = "9.4"
  expect((await f.check()).status).toBe("needs_review")
  s.outstanding = "0"
  expect(await f.check()).toMatchObject({ paymentStatus: "payment_pending" })
  s.fullyPaid = true
  s.financialStatus = "PAID"
  expect(await f.check()).toMatchObject({ paymentStatus: "paid" })
  s.cancelledAt = new Date().toISOString()
  expect((await f.check()).status).toBe("needs_review")
  expect(s.created).toBe(1)
  expect(s.processed).toBe(1)
  expect(s.invoices).toBe(1)
}, 60_000)

test("Shopify return recovery waits for an active writer and cannot overwrite a newer reconciliation", async () => {
  const f = await returnRuntimeFixture()
  const pending = await f.turn()
  await f.turn(f.confirm(pending.continuations[0].continuationId!))
  const { ShopifyOperationStore } =
    await import("@/src/server/build/integrations/shopify-operation-store")
  const { checkShopifyReturn } =
    await import("@/src/server/build/integrations/shopify-return-status")
  const row = (
    await f.database.execute<{
      id: string
      conversation_id: string
      browser_session_id: string
      customer_id: string
    }>(
      sql`SELECT id,conversation_id,browser_session_id,customer_id FROM build_shopify_order_operations WHERE kind='return'`
    )
  ).rows[0]
  const shopper = {
    shop: "fixture.myshopify.com",
    customerId: row.customer_id,
    browserSessionId: row.browser_session_id,
  }
  const operations = new ShopifyOperationStore(
    f.context,
    f.connectionId,
    row.conversation_id,
    shopper
  )
  await f.database.execute(
    sql`UPDATE build_shopify_order_operations SET status='processing',updated_at=now() WHERE id=${row.id}::uuid`
  )
  const calls = f.provider.calls.length
  expect(
    (await checkShopifyReturn({}, shopper, operations, f.provider.graphql))
      .status
  ).toBe("processing")
  expect(f.provider.calls.length).toBe(calls)
  await f.database.execute(
    sql`UPDATE build_shopify_order_operations SET status='uncertain' WHERE id=${row.id}::uuid`
  )
  const operation = (await operations.readReturn())!
  await assert.rejects(
    checkShopifyReturn({}, shopper, operations, async (query, options) => {
      const response = await f.provider.graphql(query, options)
      // Another reconciler commits after this read has taken its snapshot.
      await operations.finishReturn(
        row.id,
        { status: "return_processed", paymentStatus: "refund_pending" },
        operation.revision
      )
      return response
    }),
    /return changed while checking/
  )
  const saved = (
    await f.database.execute<{ result_json: { paymentStatus: string } }>(
      sql`SELECT result_json FROM build_shopify_order_operations WHERE id=${row.id}::uuid`
    )
  ).rows[0]
  expect(saved.result_json.paymentStatus).toBe("refund_pending")
  expect(f.provider.state.processed).toBe(1)
}, 60_000)

for (const interrupted of ["create", "balance"] as const) {
  test(`Shopify return continuation requotes and processes the existing return after ${interrupted}`, async () => {
    const approval = interrupted === "balance"
    const f = await returnRuntimeFixture({
      guest: !approval,
      approval,
      exchange: !approval,
    })
    const s = f.provider.state
    if (!approval) {
      s.direction = "InvoiceReturnOutcome"
      s.transferAmount = "0.4"
    }
    const first = await f.turn()
    const operationId = first.continuations[0].shopifyReturnQuote!.operationId
    const initialConfirmation = f.confirm(
      first.continuations[0].continuationId!
    )
    if (interrupted === "create") {
      s.lost = "create"
      await assert.rejects(f.turn(initialConfirmation), {
        code: "ACTION_UNCERTAIN",
      })
    } else {
      s.transferAmount = "18.00"
      const changed = await f.turn(initialConfirmation, true)
      expect(changed.text).toContain("changed the return balance")
      // The original merchant approval policy must survive a later settings relaxation.
      await f.setSettings({ requireHumanApproval: false })
    }
    for (const key of Object.keys(f.input)) delete f.input[key]
    f.input.operationId = operationId
    if (!approval) {
      const restore = await f.newConversation()
      const calls = f.provider.calls.length
      await assert.rejects(f.turn(), /no return to continue/i)
      expect(f.provider.calls.length).toBe(calls)
      restore()
    }
    let resumed = await f.turn()
    let quote = resumed.continuations[0].shopifyReturnQuote!
    expect(quote.resume?.returnId).toBe("gid://shopify/Return/1")
    expect(quote.input.items).toEqual([
      {
        fulfillmentLineItemId: "gid://shopify/FulfillmentLineItem/101",
        quantity: 1,
      },
    ])
    expect(quote.credit).toBeUndefined()
    expect(s.created).toBe(1)
    expect(s.processed).toBe(0)
    if (approval) {
      expect(resumed.continuations[0].type).toBe("approval_required")
      expect(quote.resume?.requireHumanApproval).toBe(true)
      expect(quote.settlement.amount).toBe("18")
      await assert.rejects(
        f.turn(f.confirm(resumed.continuations[0].continuationId!)),
        { code: "CONTINUATION_NOT_AVAILABLE" }
      )
    } else {
      // A changed balance requires consent again; the confirmation cannot pin the old amount.
      s.transferAmount = "0.5"
      s.outstanding = "0.5"
      resumed = await f.turn(
        f.confirm(resumed.continuations[0].continuationId!)
      )
      quote = resumed.continuations[0].shopifyReturnQuote!
      expect(quote.settlement.amount).toBe("0.5")
      expect(s.processed).toBe(0)
      s.stock = 0
      await assert.rejects(
        f.turn(f.confirm(resumed.continuations[0].continuationId!)),
        /replacement.*unavailable/i
      )
      s.stock = 10
      resumed = await f.turn()
    }
    s.lost = ""
    const result = await f.turn(
      f.confirm(resumed.continuations[0].continuationId!),
      approval
    )
    expect(result.text).toContain(
      approval ? "confirmed the refund" : "sent a payment invoice"
    )
    expect(s.created).toBe(1)
    expect(s.processed).toBe(1)
    const recorded = (
      await f.database.execute<{
        return_process_started: boolean
        quote_json: { settlement: { amount: string } }
      }>(
        sql`SELECT return_process_started,quote_json FROM build_shopify_order_operations WHERE id=${operationId}::uuid`
      )
    ).rows[0]
    expect(recorded.return_process_started).toBe(true)
    expect(recorded.quote_json.settlement.amount).toBe(approval ? "18" : "0.5")
    await assert.rejects(
      f.turn(),
      /processing already started|cannot be replayed/i
    )
    expect(s.processed).toBe(1)
  }, 60_000)
}

test("Shopify return continuation rejects a lost processing response even when Shopify temporarily reports zero processed items", async () => {
  const f = await returnRuntimeFixture()
  const pending = await f.turn()
  f.provider.state.lost = "process"
  await assert.rejects(
    f.turn(f.confirm(pending.continuations[0].continuationId!)),
    { code: "ACTION_UNCERTAIN" }
  )
  const operationId = pending.continuations[0].shopifyReturnQuote!.operationId
  const calls = f.provider.calls.length
  f.provider.state.processed = 0
  for (const key of Object.keys(f.input)) delete f.input[key]
  f.input.operationId = operationId
  await assert.rejects(
    f.turn(),
    /processing already started|cannot be replayed/i
  )
  expect(f.provider.calls.length).toBe(calls)
  expect(f.provider.state.created).toBe(1)
  // Upgrade an existing ledger row with no processing marker. Unknown legacy
  // history must not be interpreted as proof that a refund never started.
  await f.database.execute(
    sql.raw(
      "ALTER TABLE build_shopify_order_operations DROP COLUMN return_process_started"
    )
  )
  const migration = await readFile(
    new URL(
      "../migrations/0067_shopify_return_processing.sql",
      import.meta.url
    ),
    "utf8"
  )
  await f.database.execute(sql.raw(migration))
  await assert.rejects(
    f.turn(),
    /processing already started|cannot be replayed/i
  )
  expect(f.provider.calls.length).toBe(calls)
}, 60_000)

test("Shopify exchange releases only recorded payment holds after payment and recovers a lost release response", async () => {
  const f = await returnRuntimeFixture({ exchange: true, fulfillment: true })
  const s = f.provider.state
  s.direction = "InvoiceReturnOutcome"
  s.transferAmount = "0.4"
  const pending = await f.turn()
  const operationId = pending.continuations[0].shopifyReturnQuote!.operationId
  await f.turn(f.confirm(pending.continuations[0].continuationId!))
  const plan = (
    await f.database.execute<{
      return_hold_plan: { orders: Array<{ id: string; holdIds: string[] }> }
    }>(
      sql`SELECT return_hold_plan FROM build_shopify_order_operations WHERE id=${operationId}::uuid`
    )
  ).rows[0].return_hold_plan
  expect(
    plan.orders.map((order) => ({ id: order.id, holdIds: order.holdIds }))
  ).toEqual([
    {
      id: "gid://shopify/FulfillmentOrder/901",
      holdIds: ["gid://shopify/FulfillmentHold/501"],
    },
  ])
  expect((await f.check()).message).toContain("remain until payment")
  expect(s.holdReleases).toBe(0)
  s.outstanding = "0"
  s.financialStatus = "AUTHORIZED"
  expect((await f.check()).message).toContain(
    "not confirmed a completed payment"
  )
  expect(s.holdReleases).toBe(0)
  s.financialStatus = "PAID"
  s.fullyPaid = true
  // A new hold after payment is not part of the earlier approval, even with the same reason.
  s.holds.push({
    id: "gid://shopify/FulfillmentHold/505",
    reason: "AWAITING_PAYMENT",
    heldByRequestingApp: true,
    heldByApp: null,
  })
  s.loseHoldRelease = true
  await assert.rejects(f.check(), { code: "ACTION_UNCERTAIN" })
  const released = f.provider.calls.filter((call) =>
    call.query.includes("DatoolReleaseExchangeHolds")
  )
  expect(released.map((call) => call.variables)).toEqual([
    {
      id: "gid://shopify/FulfillmentOrder/901",
      holdIds: ["gid://shopify/FulfillmentHold/501"],
      externalId: `datool-return-${operationId}`,
    },
  ])
  expect(s.holds.map((hold) => hold.id)).toEqual([
    "gid://shopify/FulfillmentHold/502",
    "gid://shopify/FulfillmentHold/503",
    "gid://shopify/FulfillmentHold/505",
  ])
  const recovered = await f.check()
  expect(recovered.message).toContain("payment holds are cleared")
  expect(recovered.message).toContain("Other fulfillment holds remain")
  expect(s.holdReleases).toBe(1)
  expect(s.created).toBe(1)
  expect(s.processed).toBe(1)
  expect(s.invoices).toBe(1)
}, 60_000)

for (const changed of [
  "balance",
  "owner",
  "lines",
  "hold",
  "routing",
] as const) {
  test(`Shopify exchange preserves holds when ${changed} changes before release`, async () => {
    const f = await returnRuntimeFixture({ exchange: true, fulfillment: true })
    const s = f.provider.state
    s.direction = "InvoiceReturnOutcome"
    s.transferAmount = "0.4"
    const pending = await f.turn()
    await f.turn(f.confirm(pending.continuations[0].continuationId!))
    s.outstanding = "0"
    s.financialStatus = "PAID"
    s.fullyPaid = true
    if (changed === "balance" || changed === "owner")
      s.changeAfterFulfillmentRead = changed
    else if (changed === "lines") s.fulfillmentMode = "mixed"
    else if (changed === "routing") s.fulfillmentMode = "expanded"
    else s.holds[0].reason = "HIGH_RISK_OF_FRAUD"
    if (changed === "owner")
      await assert.rejects(f.check(), { code: "ACTION_FAILED" })
    else assert.match(String((await f.check()).message), /changed|preserved/i)
    expect(s.holdReleases).toBe(0)
    expect(s.holds).toHaveLength(3)
  }, 60_000)
}

test("Shopify exchange requires a pre-payment hold record and complete fulfillment visibility", async () => {
  const f = await returnRuntimeFixture({ exchange: true, fulfillment: true })
  const s = f.provider.state
  s.direction = "InvoiceReturnOutcome"
  s.transferAmount = "0.4"
  s.fulfillmentMode = "repeat_cursor"
  const pending = await f.turn()
  await f.turn(f.confirm(pending.continuations[0].continuationId!))
  expect((await f.check()).message).toContain("complete exchange fulfillment")
  s.fulfillmentMode = "mixed"
  expect((await f.check()).message).toContain("shares or changed")
  s.fulfillmentMode = "missing"
  expect((await f.check()).message).toContain("after routing completes")
  s.fulfillmentMode = "normal"
  s.outstanding = "0"
  s.financialStatus = "PAID"
  s.fullyPaid = true
  expect((await f.check()).message).toContain("not recorded before payment")
  expect(s.holdReleases).toBe(0)
}, 60_000)

test("Shopify exchange recovers a failed hold-plan save without repeating processing or invoicing", async () => {
  const f = await returnRuntimeFixture({ exchange: true, fulfillment: true })
  const s = f.provider.state
  s.direction = "InvoiceReturnOutcome"
  s.transferAmount = "0.4"
  const pending = await f.turn()
  await f.database.execute(
    sql.raw(`
    CREATE FUNCTION reject_hold_storage() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fixture: hold storage unavailable'; END $$;
    CREATE TRIGGER reject_hold_storage BEFORE UPDATE OF return_hold_plan
    ON build_shopify_order_operations FOR EACH ROW EXECUTE FUNCTION reject_hold_storage();
  `)
  )
  await assert.rejects(
    f.turn(f.confirm(pending.continuations[0].continuationId!)),
    { code: "ACTION_UNCERTAIN" }
  )
  expect(
    (
      await f.database.execute<{ return_hold_plan: unknown }>(
        sql`SELECT return_hold_plan FROM build_shopify_order_operations WHERE kind='return'`
      )
    ).rows[0].return_hold_plan
  ).toBeNull()
  expect(s.invoices).toBe(0)
  expect(s.holdReleases).toBe(0)
  await f.database.execute(
    sql.raw(
      "DROP TRIGGER reject_hold_storage ON build_shopify_order_operations"
    )
  )
  expect((await f.check()).message).toContain("payment holds are recorded")
  s.outstanding = "0"
  s.financialStatus = "PAID"
  s.fullyPaid = true
  expect((await f.check()).fulfillmentStatus).toBe("payment_holds_cleared")
  expect(s.created).toBe(1)
  expect(s.processed).toBe(1)
  expect(s.invoices).toBe(0)
  expect(s.holdReleases).toBe(1)
}, 60_000)

function commerceWebhook(
  body: Record<string, unknown>,
  options: {
    topic?: string
    shop?: string
    id?: string
    corrupt?: boolean
    triggeredAt?: string
  } = {}
) {
  const raw = JSON.stringify(body)
  return new Request(
    "https://chat.example.test/api/shopify/webhooks/commerce",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": options.topic ?? "orders/paid",
        "x-shopify-shop-domain": options.shop ?? "fixture.myshopify.com",
        "x-shopify-api-version": "2026-10",
        "x-shopify-webhook-id": options.id ?? randomUUID(),
        "x-shopify-triggered-at":
          options.triggeredAt ?? new Date().toISOString(),
        "x-shopify-hmac-sha256": createHmac("sha256", "fixture-secret")
          .update(raw)
          .digest("base64"),
      },
      body: options.corrupt ? `${raw} ` : raw,
    }
  )
}

test("Shopify uninstall revokes store access and browser sessions without affecting another app", async () => {
  const f = await fixture()
  await activateShopifyConnection(f)
  const visitor = await f.session("42")
  const otherId = randomUUID()
  await f.database.execute(sql`
    INSERT INTO build_app_connections(id,project_id,request_key,toolkit,label,provider_user_id,auth_config_id,status)
    VALUES(${otherId}::uuid,${f.context.projectId},${otherId},'shopify_native','Other app','fixture','shopify-native-v1','active')
  `)
  await f.database.execute(sql`
    INSERT INTO build_shopify_connections(connection_id,project_id,shop,client_id,authorization_expires_at,session_encrypted)
    VALUES(${otherId}::uuid,${f.context.projectId},'fixture.myshopify.com','another-client',now(),'other-private-token')
  `)
  const installId = randomUUID()
  await f.database.execute(sql`
    INSERT INTO shopify_install_intent(id,client_id,shop,source,browser_hash,session_encrypted)
    VALUES(${installId}::uuid,'fixture-client','fixture.myshopify.com','shopify',${installId},'pending-private-token')
  `)
  const request = (corrupt = false) =>
    commerceWebhook(
      { id: 123, myshopify_domain: "fixture.myshopify.com" },
      { topic: "app/uninstalled", id: installId, corrupt }
    )
  expect(
    (await handleShopifyCommerceWebhook(request(true), f.database)).status
  ).toBe(401)
  expect(
    (await f.session("42", { browserToken: visitor.browserToken })).browserToken
  ).toBeTruthy()
  await f.database.execute(
    sql.raw(`
    CREATE FUNCTION reject_uninstall() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END; $$;
    CREATE TRIGGER reject_uninstall BEFORE UPDATE ON build_app_connections
      FOR EACH ROW WHEN (NEW.status='disconnected') EXECUTE FUNCTION reject_uninstall();
  `)
  )
  expect(
    (await handleShopifyCommerceWebhook(request(), f.database)).status
  ).toBe(503)
  expect(
    (
      await f.database.execute(
        sql`SELECT status FROM build_app_connections WHERE id=${f.connectionId}::uuid`
      )
    ).rows[0].status
  ).toBe("active")
  await f.database.execute(
    sql`DROP TRIGGER reject_uninstall ON build_app_connections`
  )
  expect(
    (await handleShopifyCommerceWebhook(request(), f.database)).status
  ).toBe(204)
  const connection = (
    await f.database.execute(sql`
    SELECT a.status,s.session_encrypted,s.oauth_state_hash,s.start_token_hash
    FROM build_app_connections a JOIN build_shopify_connections s ON s.connection_id=a.id
    WHERE a.id=${f.connectionId}::uuid
  `)
  ).rows[0]
  expect(connection).toEqual({
    status: "disconnected",
    session_encrypted: null,
    oauth_state_hash: null,
    start_token_hash: null,
  })
  expect(
    (
      await f.database.execute(
        sql`SELECT id FROM build_shopify_visitor_sessions WHERE shop='fixture.myshopify.com'`
      )
    ).rows
  ).toHaveLength(0)
  expect(
    (
      await f.database.execute(
        sql`SELECT id FROM shopify_install_intent WHERE id=${installId}::uuid`
      )
    ).rows
  ).toHaveLength(0)
  await assert.rejects(f.session("42", { browserToken: visitor.browserToken }))
  expect(
    (
      await f.database.execute(
        sql`SELECT status FROM build_app_connections WHERE id=${otherId}::uuid`
      )
    ).rows[0].status
  ).toBe("active")
  expect(
    (
      await f.database.execute(
        sql`SELECT session_encrypted FROM build_shopify_connections WHERE connection_id=${otherId}::uuid`
      )
    ).rows[0].session_encrypted
  ).toBe("other-private-token")
  // A retry from the old uninstall must not revoke a connection established again.
  await f.database.execute(
    sql`UPDATE build_app_connections SET status='active' WHERE id=${f.connectionId}::uuid`
  )
  await activateShopifyConnection(f)
  expect(
    (await handleShopifyCommerceWebhook(request(), f.database)).status
  ).toBe(204)
  expect(
    (
      await f.database.execute(
        sql`SELECT status FROM build_app_connections WHERE id=${f.connectionId}::uuid`
      )
    ).rows[0].status
  ).toBe("active")
  // First delivery can also arrive late, after a fresh installation.
  const oldEvent = new Date(Date.now() - 60_000).toISOString()
  await f.database.execute(
    sql`UPDATE build_shopify_connections SET installed_at=now() WHERE connection_id=${f.connectionId}::uuid`
  )
  expect(
    (
      await handleShopifyCommerceWebhook(
        commerceWebhook(
          { id: 123, myshopify_domain: "fixture.myshopify.com" },
          { topic: "app/uninstalled", triggeredAt: oldEvent }
        ),
        f.database
      )
    ).status
  ).toBe(204)
  expect(
    (
      await f.database.execute(
        sql`SELECT status FROM build_app_connections WHERE id=${f.connectionId}::uuid`
      )
    ).rows[0].status
  ).toBe("active")
}, 60_000)

test("Shopify privacy requests are encrypted and durable after uninstall, with retries on storage failure", async () => {
  const f = await fixture()
  await f.database.execute(
    sql`UPDATE build_app_connections SET status='disconnected' WHERE id=${f.connectionId}::uuid`
  )
  env("DATOOL_BUILD_ENABLED", "false")
  env("DATOOL_BUILD_ORGANIZATION_IDS", "")
  const payload = {
    shop_id: 123,
    shop_domain: "fixture.myshopify.com",
    customer: { id: 42, email: "buyer@example.test" },
    orders_to_redact: [77],
  }
  for (const topic of [
    "customers/data_request",
    "customers/redact",
    "shop/redact",
  ]) {
    const id = randomUUID()
    expect(
      (
        await handleShopifyCommerceWebhook(
          commerceWebhook(payload, { topic, id, corrupt: true }),
          f.database
        )
      ).status
    ).toBe(401)
    expect(
      (
        await handleShopifyCommerceWebhook(
          commerceWebhook(payload, { topic, id }),
          f.database
        )
      ).status
    ).toBe(204)
    expect(
      (
        await handleShopifyCommerceWebhook(
          commerceWebhook(payload, { topic, id }),
          f.database
        )
      ).status
    ).toBe(204)
  }
  const rows = (
    await f.database.execute<{
      id: string
      client_id: string
      payload_encrypted: string
      completed_at: string | null
      days: number
    }>(sql`
    SELECT id,client_id,payload_encrypted,completed_at,EXTRACT(epoch FROM due_at-received_at)/86400 AS days FROM shopify_privacy_requests
  `)
  ).rows
  expect(rows).toHaveLength(3)
  for (const row of rows) {
    expect(row.completed_at).toBeNull()
    expect(Number(row.days)).toBe(30)
    expect(row.payload_encrypted).not.toContain("buyer@example.test")
    expect(
      JSON.parse(
        decryptProviderKey(
          row.payload_encrypted,
          row.id,
          `shopify-privacy:${row.client_id}`
        )
      )
    ).toEqual(payload)
  }
  const missingStorage = () =>
    commerceWebhook(payload, { topic: "customers/redact", id: "retry-storage" })
  await f.database.execute(
    sql`ALTER TABLE shopify_privacy_requests RENAME TO privacy_temporarily_unavailable`
  )
  expect(
    (await handleShopifyCommerceWebhook(missingStorage(), f.database)).status
  ).toBe(503)
  await f.database.execute(
    sql`ALTER TABLE privacy_temporarily_unavailable RENAME TO shopify_privacy_requests`
  )
  expect(
    (await handleShopifyCommerceWebhook(missingStorage(), f.database)).status
  ).toBe(204)
  expect(
    (await f.database.execute(sql`SELECT id FROM shopify_privacy_requests`))
      .rows
  ).toHaveLength(4)
  const directory = await mkdtemp(join(tmpdir(), "datool-privacy-test-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const run = async (...args: string[]) => {
    const child = spawnSync(
      process.execPath,
      ["--no-env-file", "scripts/shopify-privacy.ts", ...args],
      {
        env: { ...process.env, DATABASE_URL: f.testDatabaseUrl },
        encoding: "utf8",
      }
    )
    return { code: child.status, stdout: child.stdout, stderr: child.stderr }
  }
  const listed = await run("list")
  expect(listed.code).toBe(0)
  expect(JSON.parse(listed.stdout)).toHaveLength(4)
  expect(listed.stdout).not.toContain("buyer@example.test")
  const output = join(directory, "request.json")
  expect(
    (await run("export", "--id", rows[0].id, "--output", output)).code
  ).toBe(0)
  expect((await stat(output)).mode & 0o777).toBe(0o600)
  expect(JSON.parse(await readFile(output, "utf8")).payload).toEqual(payload)
  expect(
    (await run("export", "--id", rows[0].id, "--output", output)).code
  ).not.toBe(0)
  expect((await run("complete", "--id", rows[0].id)).code).not.toBe(0)
  expect(
    (
      await run(
        "complete",
        "--id",
        rows[0].id,
        "--evidence",
        "disposable-fixture-fulfilled"
      )
    ).code
  ).toBe(0)
  const completed = (
    await f.database.execute(
      sql`SELECT payload_encrypted,shop,completed_at FROM shopify_privacy_requests WHERE id=${rows[0].id}`
    )
  ).rows[0]
  expect(completed.payload_encrypted).toBeNull()
  expect(completed.shop).toBeNull()
  expect(completed.completed_at).not.toBeNull()
  expect(JSON.parse((await run("list")).stdout)).toHaveLength(3)
}, 60_000)

async function reconciliationJob(f: Awaited<ReturnType<typeof fixture>>) {
  // These runtime fixtures execute their admitted turns directly. Finish those
  // inbound jobs before exercising the actual background worker boundary.
  await f.database.execute(
    sql`UPDATE build_channel_job SET status='succeeded' WHERE kind='process_inbound'`
  )
  await enqueueShopifyReconciliationJobs(f.database)
  let job = await claimNextChannelJob(f.database)
  while (job?.kind === "deliver_outbound") {
    await processChannelJob(job, noModel, f.database)
    await completeChannelJob(f.database, job)
    job = await claimNextChannelJob(f.database)
  }
  expect(job?.kind).toBe("shopify_reconcile")
  if (!job) throw new Error("Missing reconciliation job")
  return job
}
const noModel = async (): Promise<never> => {
  throw new Error("A payment update must not invoke the model")
}

// Owner-boundary coverage: signed ingress, real durable worker, provider read,
// saved approval and public/model delivery. Existing on-demand tests cannot
// catch dropped webhooks, background identity mistakes or duplicate messages.
test("Shopify payment webhooks reconcile approved exchanges after session expiry and deliver one durable update", async () => {
  const f = await returnRuntimeFixture({
    exchange: true,
    fulfillment: true,
    guest: true,
  })
  const s = f.provider.state
  s.direction = "InvoiceReturnOutcome"
  s.transferAmount = "0.4"
  const pending = await f.turn()
  const operationId = pending.continuations[0].shopifyReturnQuote!.operationId
  const originalConversation = pending.conversation.id
  await f.turn(f.confirm(pending.continuations[0].continuationId!))
  await f.database.execute(
    sql`DELETE FROM build_shopify_visitor_sessions WHERE project_id=${f.context.projectId}`
  )
  await f.database.execute(
    sql`UPDATE build_shopify_order_operations SET reconcile_after=NULL WHERE id=${operationId}::uuid`
  )
  const body = {
    admin_graphql_api_id: "gid://shopify/Order/10",
    financial_status: "paid",
    email: "never-retain@example.test",
  }
  const delivery = randomUUID()
  for (const options of [
    { corrupt: true },
    { shop: "foreign.myshopify.com" },
  ]) {
    const response = await handleShopifyCommerceWebhook(
      commerceWebhook(body, options),
      f.database
    )
    expect(response.status).toBe(options.corrupt ? 401 : 204)
    expect(await enqueueShopifyReconciliationJobs(f.database)).toBe(0)
  }
  await f.database.execute(
    sql.raw(`
    CREATE FUNCTION reject_payment_wake() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fixture: admission unavailable'; END $$;
    CREATE TRIGGER reject_payment_wake BEFORE UPDATE OF reconcile_after ON build_shopify_order_operations FOR EACH ROW EXECUTE FUNCTION reject_payment_wake();
  `)
  )
  expect(
    (
      await handleShopifyCommerceWebhook(
        commerceWebhook(body, { id: delivery }),
        f.database
      )
    ).status
  ).toBe(503)
  expect(
    (
      await f.database.execute(
        sql`SELECT * FROM build_shopify_webhook_receipts`
      )
    ).rows
  ).toHaveLength(0)
  await f.database.execute(
    sql.raw(
      "DROP TRIGGER reject_payment_wake ON build_shopify_order_operations"
    )
  )
  expect(
    (
      await handleShopifyCommerceWebhook(
        commerceWebhook(body, { id: delivery }),
        f.database
      )
    ).status
  ).toBe(204)
  const job = await reconciliationJob(f)
  expect(await enqueueShopifyReconciliationJobs(f.database)).toBe(0)
  // A signed "paid" payload is not payment proof: the provider still says pending.
  await processChannelJob(job, noModel, f.database)
  await completeChannelJob(f.database, job)
  expect(s.holdReleases).toBe(0)
  expect(
    (
      await f.database.execute(
        sql`SELECT id FROM build_channel_message WHERE direction='outbound'`
      )
    ).rows
  ).toHaveLength(0)
  const due = (
    await f.database.execute<{ due: string }>(
      sql`SELECT reconcile_after::text AS due FROM build_shopify_order_operations WHERE id=${operationId}::uuid`
    )
  ).rows[0].due
  await handleShopifyCommerceWebhook(
    commerceWebhook(body, { id: delivery }),
    f.database
  )
  expect(
    (
      await f.database.execute<{ due: string }>(
        sql`SELECT reconcile_after::text AS due FROM build_shopify_order_operations WHERE id=${operationId}::uuid`
      )
    ).rows[0].due
  ).toBe(due)
  s.outstanding = "0"
  s.fullyPaid = true
  s.financialStatus = "PAID"
  s.loseHoldRelease = true
  await handleShopifyCommerceWebhook(commerceWebhook(body), f.database)
  const lost = await reconciliationJob(f)
  await assert.rejects(
    processChannelJob(lost, noModel, f.database),
    /did not confirm/
  )
  await failChannelJob(f.database, lost, {
    message: "Lost provider reply",
    uncertain: true,
  })
  expect(s.holdReleases).toBe(1)
  // Periodic reconciliation recovers a missed event and a lost release response.
  await f.database.execute(
    sql`UPDATE build_shopify_order_operations SET reconcile_after=now()-interval '1 minute' WHERE id=${operationId}::uuid`
  )
  const recovered = await reconciliationJob(f)
  const priorMessages = (
    await new ConversationService(f.context).listMessages(originalConversation)
  ).items.length
  await f.database.execute(
    sql.raw(`
    CREATE FUNCTION reject_payment_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.kind='deliver_outbound' THEN RAISE EXCEPTION 'fixture: delivery storage unavailable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_payment_delivery BEFORE INSERT ON build_channel_job FOR EACH ROW EXECUTE FUNCTION reject_payment_delivery();
  `)
  )
  await assert.rejects(
    processChannelJob(recovered, noModel, f.database),
    /Failed query/
  )
  expect(
    (
      await f.database.execute(
        sql`SELECT id FROM build_channel_message WHERE direction='outbound'`
      )
    ).rows
  ).toHaveLength(0)
  expect(
    (
      await new ConversationService(f.context).listMessages(
        originalConversation
      )
    ).items
  ).toHaveLength(priorMessages)
  await f.database.execute(
    sql.raw("DROP TRIGGER reject_payment_delivery ON build_channel_job")
  )
  await processChannelJob(recovered, noModel, f.database)
  await completeChannelJob(f.database, recovered)
  const outbound = await claimNextChannelJob(f.database)
  expect(outbound?.kind).toBe("deliver_outbound")
  await processChannelJob(outbound!, noModel, f.database)
  await completeChannelJob(f.database, outbound!)
  const messages = await f.database.execute<{
    conversation_id: string
    content_json: { text: string }
    status: string
    runtime_message_id: string
  }>(sql`SELECT * FROM build_channel_message WHERE direction='outbound'`)
  expect(messages.rows).toHaveLength(1)
  expect(messages.rows[0].conversation_id).toBe(originalConversation)
  expect(messages.rows[0].content_json.text).toContain(
    "payment holds are cleared"
  )
  expect(messages.rows[0].status).toBe("sent")
  expect(
    (
      await new ConversationService(f.context).listMessages(
        originalConversation
      )
    ).items.some((m) => m.id === messages.rows[0].runtime_message_id)
  ).toBe(true)
  expect(s.holdReleases).toBe(1)
  expect(s.holds.map((h) => h.id)).toEqual([
    "gid://shopify/FulfillmentHold/502",
    "gid://shopify/FulfillmentHold/503",
  ])
  expect([s.created, s.processed, s.invoices]).toEqual([1, 1, 1])
  // A new delivery for the same payment must not create another notification.
  await handleShopifyCommerceWebhook(commerceWebhook(body), f.database)
  const duplicate = await reconciliationJob(f)
  const originalGraphql = f.provider.graphql
  let eventDuringRead = false
  f.provider.graphql = async (...args) => {
    const response = await originalGraphql(...args)
    if (!eventDuringRead && args[0].includes("DatoolCheckCreatedReturn")) {
      eventDuringRead = true
      await handleShopifyCommerceWebhook(commerceWebhook(body), f.database)
    }
    return response
  }
  await processChannelJob(duplicate, noModel, f.database)
  f.provider.graphql = originalGraphql
  await completeChannelJob(f.database, duplicate)
  expect(
    (
      await f.database.execute(
        sql`SELECT id FROM build_channel_message WHERE direction='outbound'`
      )
    ).rows
  ).toHaveLength(1)
  expect(eventDuringRead).toBe(true)
  expect(await enqueueShopifyReconciliationJobs(f.database)).toBe(1)
  const finalJob = await claimNextChannelJob(f.database)
  expect(finalJob?.kind).toBe("shopify_reconcile")
  await processChannelJob(finalJob!, noModel, f.database)
  await completeChannelJob(f.database, finalJob!)
  expect(await enqueueShopifyReconciliationJobs(f.database)).toBe(0)
  const privateRows = await f.database.execute(
    sql`SELECT * FROM build_shopify_webhook_receipts`
  )
  expect(JSON.stringify(privateRows.rows)).not.toContain("never-retain")
}, 60_000)

for (const invalidation of [
  "owner",
  "disconnect",
  "channel",
  "organization",
] as const) {
  test(`Shopify background reconciliation rejects ${invalidation} changes before payment completion`, async () => {
    const f = await returnRuntimeFixture({ exchange: true, fulfillment: true })
    f.provider.state.direction = "InvoiceReturnOutcome"
    f.provider.state.transferAmount = "0.4"
    const pending = await f.turn()
    await f.turn(f.confirm(pending.continuations[0].continuationId!))
    const job = await reconciliationJob(f)
    f.provider.state.outstanding = "0"
    f.provider.state.fullyPaid = true
    f.provider.state.financialStatus = "PAID"
    if (invalidation === "owner") f.provider.state.customerId = "999"
    if (invalidation === "disconnect")
      await f.database.execute(
        sql`UPDATE build_app_connections SET status='disconnected' WHERE id=${f.connectionId}::uuid`
      )
    if (invalidation === "channel")
      await f.database.execute(
        sql`UPDATE build_channel_connection SET config_json='{}'::jsonb WHERE id=${f.channel.id}::uuid`
      )
    if (invalidation === "organization") {
      env("DATOOL_BUILD_ENABLED", "false")
      env("DATOOL_BUILD_ORGANIZATION_IDS", "")
    }
    await processChannelJob(job, noModel, f.database)
    expect(f.provider.state.holdReleases).toBe(0)
    expect(
      (
        await f.database.execute(
          sql`SELECT id FROM build_channel_message WHERE direction='outbound'`
        )
      ).rows
    ).toHaveLength(0)
  }, 60_000)
}
