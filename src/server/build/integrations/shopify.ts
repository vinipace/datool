import {
  getChannelConnection,
  updateChannelConnection,
} from "../channels/service"
import { createShopifyInstallIntent } from "./shopify-install"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import type { Pool } from "pg"
import { Session } from "@shopify/shopify-api"
import { z } from "zod"
import { assertBuildProject, type BuildContext } from "../context"
import { getTracerWritePool } from "@/src/server/tracer/db"
import { TracerError } from "@/src/server/tracer/errors"
import {
  encryptProviderKey,
  decryptProviderKey,
} from "@/src/server/model-providers/secrets"
import { composioUserId } from "./provider"
import {
  nativeShopify,
  SHOPIFY_CALLBACK,
  SHOPIFY_SCOPES,
  SHOPIFY_TOOLKIT,
  shopifyDomain,
  shopifyOrigin,
} from "./shopify-provider"
import { runShopifyStoreTool, STORE_QUERY } from "./shopify-catalog"
import { readShopifyOrders } from "./shopify-orders"
import { shopifyShopper } from "./shopify-identity"
import { shopifyToolScopes } from "./shopify-tools"
import { runShopifyCustomerTool } from "./shopify-customers"
import { tagShopifyOrder } from "./shopify-order-tags"
import {
  shopifyActionNeedsConfirmation,
  shopifyActionSettingsSchema,
  type ShopifyActionSettings,
} from "@/src/lib/build/shopify"
import { ShopifyWriteUncertainError } from "./shopify-mutation"
import { isShopifyCartTool } from "@/src/lib/build/shopify-cart"
import { prepareShopifyCart, completeShopifyCart } from "./shopify-cart"
import { claimShopifyInvitation } from "./shopify-invitations"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const unavailable = () =>
  new TracerError(
    "VALIDATION_ERROR",
    "Shopify is unavailable. Check the store connection in Integrations and reconnect if needed."
  )
type StoreRow = {
  connection_id: string
  project_id: string
  shop: string
  client_id: string
  session_encrypted: string | null
  status: string
}
function encrypt(session: Session, projectId: string, id: string) {
  return encryptProviderKey(
    JSON.stringify(session.toPropertyArray()),
    projectId,
    `shopify:${id}`
  )
}
function decrypt(row: StoreRow) {
  return Session.fromPropertyArray(
    JSON.parse(
      decryptProviderKey(
        row.session_encrypted!,
        row.project_id,
        `shopify:${row.connection_id}`
      )
    )
  )
}

export async function connectShopify(context: BuildContext, store: string) {
  if (!store) return createShopifyInstallIntent(context)
  const ctx = await assertBuildProject(context)
  const api = nativeShopify()
  const shop = shopifyDomain(store)
  const start = randomBytes(32).toString("base64url")
  const client = await getTracerWritePool(ctx.database).connect()
  try {
    await client.query("BEGIN")
    // Shopify has one current refresh-token pair per app/store. Never create
    // independent credential copies that rotate each other's token away.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `shopify:${api.config.apiKey}:${shop}`,
    ])
    const existing = await client.query<StoreRow>(
      "SELECT * FROM build_shopify_connections WHERE shop=$1 AND client_id=$2",
      [shop, api.config.apiKey]
    )
    const row = existing.rows[0]
    if (row && row.project_id !== ctx.projectId) throw unavailable()
    const id = row?.connection_id ?? randomUUID()
    const requestKey = ctx.idempotencyKey ?? randomUUID()
    const repeated = await client.query(
      "SELECT id FROM build_app_connections WHERE project_id=$1 AND request_key=$2",
      [ctx.projectId, requestKey]
    )
    if (repeated.rows.length)
      throw new TracerError(
        "VALIDATION_ERROR",
        "This connection was already started. Check its status before trying again."
      )
    if (row) {
      await client.query(
        "UPDATE build_app_connections SET status='pending',request_key=$1,updated_at=now() WHERE id=$2 AND project_id=$3",
        [requestKey, id, ctx.projectId]
      )
      await client.query(
        "UPDATE build_shopify_connections SET start_token_hash=$1,oauth_state_hash=NULL,authorization_expires_at=now()+interval '10 minutes' WHERE connection_id=$2 AND project_id=$3",
        [hash(start), id, ctx.projectId]
      )
    } else {
      await client.query(
        "INSERT INTO build_app_connections(id,project_id,request_key,toolkit,label,provider_user_id,auth_config_id,status) VALUES($1,$2,$3,$4,$5,$6,'shopify-native-v1','pending')",
        [
          id,
          ctx.projectId,
          requestKey,
          SHOPIFY_TOOLKIT,
          shop,
          composioUserId(ctx.organizationId, ctx.projectId),
        ]
      )
      await client.query(
        "INSERT INTO build_shopify_connections(connection_id,project_id,shop,client_id,start_token_hash,authorization_expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')",
        [id, ctx.projectId, shop, api.config.apiKey, hash(start)]
      )
    }
    await client.query("COMMIT")
    return {
      id,
      redirectUrl: `${shopifyOrigin()}/api/shopify/connect?token=${start}`,
    }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

/** Public entry accepts only a short-lived intent minted by a project member. */
export async function beginShopifyAuthorization(pool: Pool, request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? ""
  if (!/^[\w-]{43}$/.test(token)) throw unavailable()
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const result = await client.query<StoreRow>(
      "SELECT s.* FROM build_shopify_connections s JOIN build_app_connections c ON c.id=s.connection_id WHERE s.start_token_hash=$1 AND s.authorization_expires_at>now() AND c.status='pending' FOR UPDATE OF s,c",
      [hash(token)]
    )
    const row = result.rows[0]
    const api = nativeShopify()
    if (!row || row.client_id !== api.config.apiKey) throw unavailable()
    const response: Response = await api.auth.begin({
      shop: shopifyDomain(row.shop),
      callbackPath: SHOPIFY_CALLBACK,
      isOnline: false,
      rawRequest: request,
    })
    const state = new URL(
      response.headers.get("location") || ""
    ).searchParams.get("state")
    if (!state) throw unavailable()
    await client.query(
      "UPDATE build_shopify_connections SET start_token_hash=NULL,oauth_state_hash=$1 WHERE connection_id=$2",
      [hash(state), row.connection_id]
    )
    await client.query("COMMIT")
    response.headers.set("Cache-Control", "no-store")
    response.headers.set("Referrer-Policy", "no-referrer")
    return response
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function completeShopifyAuthorization(
  pool: Pool,
  request: Request
) {
  const query = new URL(request.url).searchParams
  const state = query.get("state") ?? ""
  if (!state || state.length > 200) throw unavailable()
  const api = nativeShopify()
  const found = await pool.query<StoreRow>(
    "SELECT s.* FROM build_shopify_connections s JOIN build_app_connections c ON c.id=s.connection_id WHERE s.oauth_state_hash=$1 AND s.authorization_expires_at>now() AND c.status='pending'",
    [hash(state)]
  )
  const row = found.rows[0]
  if (
    !row ||
    row.shop !== shopifyDomain(query.get("shop") ?? "") ||
    row.client_id !== api.config.apiKey
  )
    throw unavailable()
  // The official library verifies the signed browser cookie, state and Shopify HMAC.
  const { session, headers } = await api.auth.callback({
    rawRequest: request,
    expiring: true,
  })
  if (
    session.shop !== row.shop ||
    session.isOnline ||
    !session.accessToken ||
    !session.refreshToken ||
    !session.expires ||
    !session.isScopeIncluded(SHOPIFY_SCOPES)
  )
    throw unavailable()
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const active = await client.query(
      "SELECT c.id FROM build_app_connections c JOIN build_shopify_connections s ON s.connection_id=c.id WHERE c.id=$1 AND c.status='pending' AND s.oauth_state_hash=$2 AND s.authorization_expires_at>now() FOR UPDATE OF c,s",
      [row.connection_id, hash(state)]
    )
    if (!active.rows.length) throw unavailable()
    await client.query(
      "UPDATE build_shopify_connections SET session_encrypted=$1,oauth_state_hash=NULL,start_token_hash=NULL WHERE connection_id=$2 AND project_id=$3",
      [
        encrypt(session, row.project_id, row.connection_id),
        row.connection_id,
        row.project_id,
      ]
    )
    await client.query(
      "UPDATE build_app_connections SET status='active',updated_at=now() WHERE id=$1 AND project_id=$2",
      [row.connection_id, row.project_id]
    )
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
  return new Response(
    "Shopify is connected. Return to Datool, check the connection, and choose your agent's tools in Actions.",
    {
      headers: {
        ...Object.fromEntries(new Headers(headers)),
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    }
  )
}

async function authorizedSession(context: BuildContext, id: string) {
  await assertBuildProject(context)
  const client = await getTracerWritePool(context.database).connect()
  try {
    await client.query("BEGIN")
    const result = await client.query<StoreRow>(
      "SELECT s.*,c.status FROM build_shopify_connections s JOIN build_app_connections c ON c.id=s.connection_id AND c.project_id=s.project_id WHERE s.connection_id=$1 AND s.project_id=$2 FOR UPDATE OF s,c",
      [id, context.projectId]
    )
    const row = result.rows[0]
    const api = nativeShopify()
    if (
      !row ||
      row.status !== "active" ||
      !row.session_encrypted ||
      row.client_id !== api.config.apiKey
    )
      throw unavailable()
    let session = decrypt(row)
    if (
      session.shop !== shopifyDomain(row.shop) ||
      !session.isScopeIncluded(SHOPIFY_SCOPES)
    )
      throw unavailable()
    if (session.isExpired(60_000)) {
      if (
        !session.refreshToken ||
        !session.refreshTokenExpires ||
        session.refreshTokenExpires.getTime() <= Date.now()
      )
        throw unavailable()
      // Serialize refresh across web/buildworker processes; Shopify rotates refresh tokens.
      session = (
        await api.auth.refreshToken({
          shop: row.shop,
          refreshToken: session.refreshToken,
        })
      ).session
      if (!session.accessToken || !session.isScopeIncluded(SHOPIFY_SCOPES))
        throw unavailable()
      await client.query(
        "UPDATE build_shopify_connections SET session_encrypted=$1 WHERE connection_id=$2 AND project_id=$3",
        [encrypt(session, context.projectId, id), id, context.projectId]
      )
    }
    await client.query("COMMIT")
    return session
  } catch {
    await client.query("ROLLBACK")
    throw unavailable()
  } finally {
    client.release()
  }
}

export async function refreshShopifyConnection(
  context: BuildContext,
  id: string
) {
  const session = await authorizedSession(context, id)
  const client = new (nativeShopify().clients.Graphql)({ session })
  try {
    const result = await client.request<{ shop: { myshopifyDomain: string } }>(
      STORE_QUERY,
      { retries: 0 }
    )
    if (result.data?.shop.myshopifyDomain !== session.shop) throw unavailable()
  } catch {
    throw unavailable()
  }
}

export async function executeShopifyTool(
  context: BuildContext,
  id: string,
  slug: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
  execution?: {
    conversationId: string
    turnId: string
    confirmed?: boolean
    cartResult?: unknown
    settings?: ShopifyActionSettings
  }
) {
  const product = slug === "SHOPIFY_SEARCH_PRODUCTS"
  const orders = slug === "SHOPIFY_GET_ORDERS"
  const commerce = slug in shopifyToolScopes
  if (!product && !commerce && slug !== "SHOPIFY_READ_POLICIES")
    throw unavailable()
  const args = product
    ? z
        .object({ query: z.string().max(160) })
        .strict()
        .parse(input)
    : commerce
      ? input
      : z.object({}).strict().parse(input)
  const session = await authorizedSession(context, id)
  if (commerce && !session.isScopeIncluded(shopifyToolScopes[slug]))
    throw new TracerError(
      "VALIDATION_ERROR",
      "Reconnect Shopify in Integrations and grant the permissions required by this action."
    )
  const shopper =
    commerce && execution
      ? await shopifyShopper(context, {
          ...execution,
          connectionId: id,
          shop: session.shop,
        })
      : null
  if (commerce && !shopper) throw unavailable()
  if (shopifyActionNeedsConfirmation(slug) && !execution?.confirmed)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Confirm this change in the chat before it can be applied."
    )
  signal?.throwIfAborted()
  if (isShopifyCartTool(slug)) {
    const command = prepareShopifyCart(slug, input)
    if (execution?.cartResult !== undefined)
      return completeShopifyCart(execution.cartResult)
    return { cartCommand: command }
  }
  const client = new (nativeShopify().clients.Graphql)({ session })
  try {
    const graphql: import("./shopify-catalog").ShopifyGraphqlClient = async (
      query,
      options
    ) => {
      signal?.throwIfAborted()
      const result = await client.request(query, {
        variables: options?.variables,
        retries: 0,
      })
      return Response.json(result)
    }
    if (commerce && shopper && execution) {
      const beforeWrite = async () => {
        signal?.throwIfAborted()
        const current = await shopifyShopper(context, {
          ...execution,
          connectionId: id,
          shop: session.shop,
        })
        if (current.customerId !== shopper.customerId) throw unavailable()
      }
      if (orders) return await readShopifyOrders(args, shopper, graphql)
      if (slug === "SHOPIFY_TAG_ORDER")
        return await tagShopifyOrder(
          args,
          shopper,
          shopifyActionSettingsSchema.parse(execution.settings ?? {}),
          graphql,
          beforeWrite
        )
      return await runShopifyCustomerTool(
        slug,
        args,
        shopper,
        graphql,
        beforeWrite,
        (email) => claimShopifyInvitation(context, id, email)
      )
    }
    return await runShopifyStoreTool(
      product ? "products" : "policies",
      args,
      graphql
    )
  } catch (error) {
    if (
      error instanceof ShopifyWriteUncertainError ||
      error instanceof TracerError
    )
      throw error
    throw new TracerError(
      "VALIDATION_ERROR",
      "Shopify could not read the store data. Check app permissions or reconnect in Integrations."
    )
  }
}

/** Bind the app-owned theme embed to a project-owned web channel. */
export async function configureShopifyChat(
  context: BuildContext,
  connectionId: string,
  channelId: string
) {
  const { connection } = await getChannelConnection(context, channelId)
  if (connection.channel !== "web" || connection.status !== "connected")
    throw new TracerError(
      "VALIDATION_ERROR",
      "Enable this chat bubble before connecting it to Shopify."
    )
  const session = await authorizedSession(context, connectionId)
  if (!session.isScopeIncluded("write_app_proxy"))
    throw new TracerError(
      "VALIDATION_ERROR",
      "Reconnect Shopify to authorize secure storefront chat."
    )
  const client = new (nativeShopify().clients.Graphql)({ session })
  const query = `query DatoolChatInstallation {
    currentAppInstallation { id metafield(namespace: "datool", key: "widget") { value } }
    shop { primaryDomain { url } }
  }`
  const installation = await client.request<{
    currentAppInstallation: { id: string; metafield: { value: string } | null }
    shop: { primaryDomain: { url: string } }
  }>(query, { retries: 0 })
  const ownerId = installation.data?.currentAppInstallation.id
  const primaryDomain = installation.data?.shop.primaryDomain.url
  if (!ownerId || !primaryDomain) throw unavailable()
  const value = JSON.stringify({
    enabled: true,
    channelId,
    baseUrl: shopifyOrigin(),
  })
  const mutation = await client.request<{
    metafieldsSet: { userErrors: { message: string }[] }
  }>(
    `
    mutation DatoolChatConfigure($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { message } }
    }
  `,
    {
      variables: {
        metafields: [
          { ownerId, namespace: "datool", key: "widget", type: "json", value },
        ],
      },
      retries: 0,
    }
  )
  if (
    !mutation.data?.metafieldsSet ||
    mutation.data.metafieldsSet.userErrors.length
  )
    throw new TracerError(
      "VALIDATION_ERROR",
      "Shopify could not save the chat configuration. Please retry."
    )
  const verified = await client.request<{
    currentAppInstallation: { metafield: { value: string } | null }
  }>(query, { retries: 0 })
  if (verified.data?.currentAppInstallation.metafield?.value !== value)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Shopify chat configuration could not be verified. Please retry."
    )
  await updateChannelConnection(context, {
    connectionId: channelId,
    shopifyShop: session.shop,
    originAllowlist: [
      ...new Set([
        ...((connection.config.originAllowlist as string[]) ?? []),
        new URL(primaryDomain).origin,
        `https://${session.shop}`,
      ]),
    ],
  })
  return {
    shop: session.shop,
    channelId,
    themeEditorUrl: `https://${session.shop}/admin/themes/current/editor?context=apps`,
  }
}
