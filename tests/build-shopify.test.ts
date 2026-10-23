import {
  createChannelConnection,
  updateChannelStatus,
  getChannelConnection,
} from "@/src/server/build/channels/service"
import { afterEach, expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { createHmac } from "node:crypto"
import { Pool } from "pg"
import {
  connectApp,
  disconnectApp,
  listAppConnections,
  listAppTools,
  refreshAppConnection,
  executeAppAction,
} from "@/src/server/build/integrations/service"
import { createAgent } from "@/src/server/build/agents"
import { ConversationService } from "@/src/server/build/conversations"
import {
  beginShopifyAuthorization,
  completeShopifyAuthorization,
  executeShopifyTool,
  configureShopifyChat,
} from "@/src/server/build/integrations/shopify"
import { SHOPIFY_TOOLKIT } from "@/src/server/build/integrations/shopify-provider"
import {
  createTracerDatabase,
  closeTracerDatabase,
} from "@/src/server/tracer/db"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  globalThis.fetch = originalFetch
  for (const key of [
    "DATOOL_SHOPIFY_CLIENT_ID",
    "DATOOL_SHOPIFY_CLIENT_SECRET",
    "DATOOL_PROVIDER_ENCRYPTION_KEY",
    "BETTER_AUTH_URL",
  ]) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  for (const close of cleanup.splice(0).reverse()) await close()
})

test("Shopify authorization binds a store to its project, rotates tokens once and revokes access", async () => {
  process.env.DATOOL_SHOPIFY_CLIENT_ID = "shopify-fixture-client"
  process.env.DATOOL_SHOPIFY_CLIENT_SECRET = "shopify-fixture-secret"
  process.env.DATOOL_PROVIDER_ENCRYPTION_KEY =
    "fixture-encryption-secret-only-for-tests"
  process.env.BETTER_AUTH_URL = "https://datool.example"
  const target = await createIsolatedPostgres()
  cleanup.push(target.close)
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const pool = new Pool({ connectionString: target.databaseUrl })
  const database = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  cleanup.push(async () => {
    await pool.end()
    await closeTracerDatabase(database)
  })
  const ctx = {
    database,
    projectId: target.projectId,
    organizationId: target.organizationId,
  }
  const shop = "fixture-store.myshopify.com"
  const userAgent = "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36"
  let exchanges = 0
  let refreshes = 0
  let reads = 0
  let fail = false
  let widgetValue: string | null = null
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    expect(url.hostname).toBe(shop)
    expect(init?.redirect).toBe("error")
    const body = JSON.parse(String(init?.body))
    if (url.pathname === "/admin/oauth/access_token") {
      if (body.grant_type === "refresh_token") {
        refreshes++
        expect(body.refresh_token).toBe("private-refresh-token")
      } else {
        exchanges++
        expect(body.expiring).toBe("1")
      }
      return Response.json({
        access_token: refreshes
          ? "private-refreshed-access"
          : "private-access-token",
        refresh_token: refreshes
          ? "private-rotated-refresh"
          : "private-refresh-token",
        expires_in: refreshes ? 3600 : 30,
        refresh_token_expires_in: 7776000,
        scope: "read_products,read_legal_policies,write_app_proxy",
      })
    }
    expect(url.pathname).toBe("/admin/api/2026-10/graphql.json")
    reads++
    expect(new Headers(init?.headers).get("X-Shopify-Access-Token")).toBe(
      "private-refreshed-access"
    )
    if (fail)
      return Response.json(
        { errors: "private-provider-error-body" },
        { status: 401 }
      )
    if (body.query.includes("DatoolChatConfigure")) {
      expect(body.variables.metafields[0]).toMatchObject({
        ownerId: "gid://shopify/AppInstallation/123",
        namespace: "datool",
        key: "widget",
        type: "json",
      })
      widgetValue = body.variables.metafields[0].value
      return Response.json({ data: { metafieldsSet: { userErrors: [] } } })
    }
    if (body.query.includes("DatoolChatInstallation"))
      return Response.json({
        data: {
          currentAppInstallation: {
            id: "gid://shopify/AppInstallation/123",
            metafield: widgetValue ? { value: widgetValue } : null,
          },
          shop: { primaryDomain: { url: "https://custom-store.example" } },
        },
      })
    if (body.query.includes("DatoolStore"))
      return Response.json({ data: { shop: { myshopifyDomain: shop } } })
    if (body.query.includes("DatoolPolicies"))
      return Response.json({
        data: {
          shop: {
            shopPolicies: [
              {
                title: "Refunds",
                body: "Returns within 14 days",
                url: `https://${shop}/policies/refund-policy`,
                type: "REFUND_POLICY",
              },
            ],
          },
        },
      })
    expect(body.variables.query).toBe(
      "status:active AND published_status:published"
    )
    const product = {
      title: "Snowboard",
      description: "Sample",
      handle: "snowboard",
      status: "ACTIVE",
      publishedAt: "2020-01-01T00:00:00Z",
      onlineStoreUrl: null,
      featuredMedia: {
        preview: {
          image: {
            url: "https://cdn.shopify.com/snowboard.png",
            altText: "Snowboard",
          },
        },
      },
      priceRangeV2: {
        minVariantPrice: { amount: "600" },
        maxVariantPrice: { amount: "650" },
      },
      variants: { nodes: [] },
    }
    return Response.json({
      data: {
        shop: {
          currencyCode: "BRL",
          primaryDomain: { url: `https://${shop}` },
        },
        products: {
          nodes: [
            product,
            { ...product, title: "Hidden", publishedAt: null },
            { ...product, title: "Draft", status: "DRAFT" },
          ],
        },
      },
    })
  }) as typeof fetch
  for (const store of [
    "https://attacker.example",
    "fixture.myshopify.com.evil.test",
    "user@fixture.myshopify.com",
    "fixture.myshopify.com/path",
    "http://fixture.myshopify.com",
  ]) {
    await rejects(connectApp(ctx, SHOPIFY_TOOLKIT, store), /myshopify.com/)
  }
  const started = await connectApp(
    { ...ctx, idempotencyKey: "first-connect" },
    SHOPIFY_TOOLKIT,
    shop
  )
  await rejects(
    connectApp(
      { ...ctx, idempotencyKey: "first-connect" },
      SHOPIFY_TOOLKIT,
      shop
    ),
    new RegExp("already started")
  )
  const startRequest = new Request(started.redirectUrl, {
    headers: { "user-agent": userAgent },
  })
  const authorization = await beginShopifyAuthorization(pool, startRequest)
  expect(authorization.status).toBe(302)
  await rejects(beginShopifyAuthorization(pool, startRequest))
  const authorizeUrl = new URL(authorization.headers.get("location")!)
  expect(authorizeUrl.host).toBe(shop)
  expect(authorizeUrl.searchParams.get("scope")).toBe(
    "read_products,read_legal_policies,write_app_proxy,write_customers,write_orders,write_draft_orders,read_payment_terms,write_returns,write_merchant_managed_fulfillment_orders,write_third_party_fulfillment_orders"
  )
  const cookie = authorization.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ")
  function callback(store = shop, validHmac = true) {
    const params = new URLSearchParams({
      code: "fixture-authorization-code",
      shop: store,
      state: authorizeUrl.searchParams.get("state")!,
      timestamp: String(Math.floor(Date.now() / 1000)),
    })
    const message = [...params]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("&")
    params.set(
      "hmac",
      validHmac
        ? createHmac("sha256", process.env.DATOOL_SHOPIFY_CLIENT_SECRET!)
            .update(message)
            .digest("hex")
        : "invalid"
    )
    return new Request(
      `https://datool.example/api/shopify/callback?${params}`,
      { headers: { cookie, "user-agent": userAgent } }
    )
  }
  await rejects(
    completeShopifyAuthorization(pool, callback("other.myshopify.com"))
  )
  await rejects(completeShopifyAuthorization(pool, callback(shop, false)))
  expect(exchanges).toBe(0)
  const done = await completeShopifyAuthorization(pool, callback())
  expect(done.status).toBe(200)
  await rejects(completeShopifyAuthorization(pool, callback()))
  expect(exchanges).toBe(1)
  const catalog = await listAppConnections(ctx)
  expect(
    catalog.connections.find((item) => item.id === started.id)?.status
  ).toBe("active")
  expect(JSON.stringify(catalog)).not.toContain("private-")
  const stored = await pool.query(
    "SELECT session_encrypted FROM build_shopify_connections WHERE connection_id=$1",
    [started.id]
  )
  expect(stored.rows[0].session_encrypted).not.toContain("private-")
  expect(
    (await listAppTools(ctx, started.id)).map((tool) => tool.slug)
  ).toContain("SHOPIFY_SEARCH_PRODUCTS")
  const results = await Promise.all([
    executeShopifyTool(ctx, started.id, "SHOPIFY_SEARCH_PRODUCTS", {
      query: "",
    }),
    executeShopifyTool(ctx, started.id, "SHOPIFY_SEARCH_PRODUCTS", {
      query: " ",
    }),
  ])
  expect(refreshes).toBe(1)
  // An existing catalog-only install keeps catalog access, but must grant the
  // newly requested permissions before order creation can reach Shopify.
  const readsBeforeOrder = reads
  await rejects(
    executeShopifyTool(ctx, started.id, "SHOPIFY_CREATE_ORDER", {
      email: "buyer@example.test",
      items: [{ variantId: "123", quantity: 1 }],
    }),
    /Reconnect Shopify.*permissions/
  )
  expect(reads).toBe(readsBeforeOrder)
  for (const result of results) {
    if (!("products" in result)) throw new Error("Expected product results")
    expect(result.products).toHaveLength(1)
    expect(result.products?.[0]).toMatchObject({
      title: "Snowboard",
      url: `https://${shop}/products/snowboard`,
      imageUrl: "https://cdn.shopify.com/snowboard.png",
      priceMin: "600",
      priceMax: "650",
    })
  }
  const agent = await createAgent(ctx, {
    id: "shopify-agent",
    name: "Shopify agent",
  })
  const channel = await createChannelConnection(ctx, {
    agentId: agent.id,
    channel: "web",
    label: "Shop chat",
    config: {},
  })
  await rejects(
    configureShopifyChat(ctx, started.id, channel.id),
    /Enable this chat/
  )
  await updateChannelStatus(ctx, channel.id, "connected")
  expect(await configureShopifyChat(ctx, started.id, channel.id)).toMatchObject(
    { shop, channelId: channel.id }
  )
  expect(JSON.parse(widgetValue!)).toEqual({
    enabled: true,
    channelId: channel.id,
    baseUrl: "https://datool.example",
  })
  const configured = (await getChannelConnection(ctx, channel.id)).connection
  expect(configured.config.shopifyShop).toBe(shop)
  expect(configured.config.originAllowlist).toEqual([
    "https://custom-store.example",
    `https://${shop}`,
  ])
  const conversations = new ConversationService(ctx)
  const conversation = await conversations.getOrCreate({
    agentId: agent.id,
    channel: "api",
    metadata: {},
  })
  const admission = await conversations.startTurn(conversation.id, {
    requestKey: "shopify-policy-read",
    input: "What is the return policy?",
    metadata: {},
    snapshot: {},
  })
  const invocation = {
    connectionId: started.id,
    toolSlug: "SHOPIFY_READ_POLICIES",
    agentId: agent.id,
    conversationId: conversation.id,
    turnId: admission.turn.id,
    toolCallId: "policies-1",
    arguments: {},
  }
  expect(await executeAppAction(ctx, invocation)).toMatchObject({
    status: "completed",
    output: { policies: [{ body: "Returns within 14 days" }] },
  })
  await rejects(executeAppAction(ctx, invocation), /already attempted/)
  expect(
    (
      await pool.query(
        "SELECT provider,status,cost_nano_usd FROM build_usage_event WHERE project_id=$1",
        [ctx.projectId]
      )
    ).rows
  ).toEqual([{ provider: "shopify", status: "completed", cost_nano_usd: "0" }])
  await refreshAppConnection(ctx, started.id)
  const before = reads
  await rejects(
    executeShopifyTool(ctx, started.id, "SHOPIFY_DELETE_PRODUCT", {})
  )
  expect(reads).toBe(before)
  const foreignProject = crypto.randomUUID()
  await pool.query(
    "INSERT INTO project(id,organization_id,name,slug) VALUES($1,$2,'Other','other')",
    [foreignProject, target.organizationId]
  )
  const foreignDb = createTracerDatabase(target.databaseUrl, {
    projectId: foreignProject,
    schema: target.schema,
  })
  cleanup.push(() => closeTracerDatabase(foreignDb))
  const foreign = { ...ctx, database: foreignDb, projectId: foreignProject }
  await rejects(connectApp(foreign, SHOPIFY_TOOLKIT, shop))
  await rejects(listAppTools(foreign, started.id))
  await rejects(configureShopifyChat(foreign, started.id, channel.id))
  await rejects(
    executeShopifyTool(foreign, started.id, "SHOPIFY_SEARCH_PRODUCTS", {
      query: "",
    })
  )
  expect(reads).toBe(before)
  fail = true
  await rejects(
    executeShopifyTool(ctx, started.id, "SHOPIFY_SEARCH_PRODUCTS", {
      query: "",
    }),
    new RegExp("Shopify could not read")
  )
  await disconnectApp(ctx, started.id)
  await rejects(
    executeShopifyTool(ctx, started.id, "SHOPIFY_SEARCH_PRODUCTS", {
      query: "",
    })
  )
  expect(
    (
      await pool.query(
        "SELECT session_encrypted FROM build_shopify_connections WHERE connection_id=$1",
        [started.id]
      )
    ).rows[0].session_encrypted
  ).toBeNull()
  const reconnected = await connectApp(
    { ...ctx, idempotencyKey: "reconnect" },
    SHOPIFY_TOOLKIT,
    shop
  )
  expect(reconnected.id).toBe(started.id)
  await disconnectApp(ctx, started.id)
  await rejects(
    beginShopifyAuthorization(
      pool,
      new Request(reconnected.redirectUrl, {
        headers: { "user-agent": userAgent },
      })
    )
  )
}, 30_000)
