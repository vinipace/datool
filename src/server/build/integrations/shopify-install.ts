import { createHash, randomBytes, randomUUID } from "node:crypto"
import type { Pool } from "pg"
import { Session } from "@shopify/shopify-api"
import { assertBuildProject, type BuildContext } from "../context"
import { getTracerWritePool } from "@/src/server/tracer/db"
import {
  encryptProviderKey,
  decryptProviderKey,
} from "@/src/server/model-providers/secrets"
import { TracerError } from "@/src/server/tracer/errors"
import { withBillingLock } from "@/src/server/billing/store"
import {
  nativeShopify,
  shopifyDomain,
  shopifyOrigin,
  SHOPIFY_CALLBACK,
  SHOPIFY_SCOPES,
  SHOPIFY_TOOLKIT,
} from "./shopify-provider"
import { composioUserId } from "./provider"

const digest = (s: string) => createHash("sha256").update(s).digest("hex")
const secret = () => randomBytes(32).toString("base64url")
const cookieName = "__Host-datool-shopify-install"
const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
}
const unavailable = () =>
  new TracerError(
    "VALIDATION_ERROR",
    "This Shopify connection has expired or is unavailable. Start again from Shopify or Datool Integrations."
  )
type Intent = {
  id: string
  client_id: string
  shop: string | null
  shop_id: string | null
  project_id: string | null
  source: "datool" | "shopify"
  session_encrypted: string | null
  claimed_project_id: string | null
}
function receipt(request: Request) {
  const value = request.headers
    .get("cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1)
  return value && /^[\w-]{43}$/.test(value) ? value : null
}
function setReceipt(response: Response, value: string) {
  response.headers.append(
    "Set-Cookie",
    `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1800`
  )
  for (const [key, value] of Object.entries(headers))
    response.headers.set(key, value)
  return response
}
function appListing() {
  const handle = process.env.DATOOL_SHOPIFY_APP_HANDLE ?? ""
  if (!/^[a-z0-9][a-z0-9-]*$/.test(handle)) throw unavailable()
  return `https://apps.shopify.com/${handle}`
}

/** A Datool-origin install can only be minted by an authorized project operation. */
export async function createShopifyInstallIntent(context: BuildContext) {
  const ctx = await assertBuildProject(context)
  appListing()
  const id = randomUUID(),
    token = secret()
  await getTracerWritePool(ctx.database).query(
    `INSERT INTO shopify_install_intent(id,client_id,project_id,source,start_hash,browser_hash)
     VALUES($1,$2,$3,'datool',$4,$5)`,
    [
      id,
      nativeShopify().config.apiKey,
      ctx.projectId,
      digest(token),
      digest(secret()),
    ]
  )
  return {
    id,
    redirectUrl: `${shopifyOrigin()}/api/shopify/install?intent=${token}`,
  }
}

/** Shopify's signed app launch authenticates the store before any Datool UI. */
export async function beginShopifyInstall(pool: Pool, request: Request) {
  const api = nativeShopify(),
    query = new URL(request.url).searchParams
  const token = query.get("intent")
  if (token) {
    if (!/^[\w-]{43}$/.test(token)) throw unavailable()
    const browser = secret()
    const result = await pool.query(
      `UPDATE shopify_install_intent SET start_hash=NULL,browser_hash=$1
       WHERE start_hash=$2 AND client_id=$3 AND expires_at>now() RETURNING id`,
      [digest(browser), digest(token), api.config.apiKey]
    )
    if (!result.rowCount) throw unavailable()
    return setReceipt(
      new Response(null, { status: 302, headers: { Location: appListing() } }),
      browser
    )
  }
  const shop = shopifyDomain(query.get("shop") ?? "")
  const timestamp = Number(query.get("timestamp"))
  if (
    !Number.isFinite(timestamp) ||
    Math.abs(Date.now() / 1000 - timestamp) > 300 ||
    query.getAll("shop").length !== 1 ||
    !(await api.utils.validateHmac(query))
  )
    throw unavailable()
  const previous = receipt(request)
  const existing = previous
    ? await pool.query<Intent>(
        `SELECT * FROM shopify_install_intent WHERE browser_hash=$1 AND client_id=$2 AND expires_at>now() AND claimed_project_id IS NULL`,
        [digest(previous), api.config.apiKey]
      )
    : null
  const intent = existing?.rows[0]
  const id = intent?.id ?? randomUUID(),
    browser = previous && intent ? previous : secret()
  const response: Response = await api.auth.begin({
    shop,
    callbackPath: SHOPIFY_CALLBACK,
    isOnline: false,
    rawRequest: request,
  })
  const state = new URL(
    response.headers.get("location") ?? ""
  ).searchParams.get("state")
  if (!state) throw unavailable()
  await pool.query(
    `INSERT INTO shopify_install_intent(id,client_id,shop,source,browser_hash,oauth_state_hash)
     VALUES($1,$2,$3,'shopify',$4,$5) ON CONFLICT(id) DO UPDATE SET
     shop=$3,oauth_state_hash=$5,session_encrypted=NULL,shop_id=NULL,expires_at=now()+interval '30 minutes'`,
    [id, api.config.apiKey, shop, digest(browser), digest(state)]
  )
  await pool.query("DELETE FROM shopify_install_intent WHERE expires_at<now()")
  return setReceipt(response, browser)
}

export async function completeShopifyInstall(
  pool: Pool,
  request: Request
): Promise<Response | null> {
  const query = new URL(request.url).searchParams,
    state = query.get("state")
  if (!state) return null
  const found = await pool.query<Intent>(
    "SELECT * FROM shopify_install_intent WHERE oauth_state_hash=$1 AND expires_at>now()",
    [digest(state)]
  )
  const intent = found.rows[0]
  if (!intent) return null
  const browser = receipt(request),
    api = nativeShopify()
  if (
    !browser ||
    intent.client_id !== api.config.apiKey ||
    intent.shop !== shopifyDomain(query.get("shop") ?? "")
  )
    throw unavailable()
  const { session, headers: oauthHeaders } = await api.auth.callback({
    rawRequest: request,
    expiring: true,
  })
  if (
    session.shop !== intent.shop ||
    session.isOnline ||
    !session.accessToken ||
    !session.refreshToken ||
    !session.expires ||
    !session.isScopeIncluded(SHOPIFY_SCOPES)
  )
    throw unavailable()
  const client = new api.clients.Graphql({ session })
  const result = await client.request<{ shop: { id: string } }>(
    "query DatoolBillingShop { shop { id } }",
    { retries: 0 }
  )
  const shopId = result.data?.shop.id
  if (!shopId || !/^gid:\/\/shopify\/Shop\/\d+$/.test(shopId))
    throw unavailable()
  const saved = await pool.query(
    `UPDATE shopify_install_intent SET session_encrypted=$1,shop_id=$2,oauth_state_hash=NULL
     WHERE id=$3 AND browser_hash=$4 AND oauth_state_hash=$5 AND expires_at>now()`,
    [
      encryptProviderKey(
        JSON.stringify(session.toPropertyArray()),
        intent.id,
        `shopify-install:${intent.client_id}`
      ),
      shopId,
      intent.id,
      digest(browser),
      digest(state),
    ]
  )
  if (!saved.rowCount) throw unavailable()
  const response = new Response(null, { status: 303, headers: oauthHeaders })
  response.headers.set("Location", `${shopifyOrigin()}/shopify/connect`)
  return setReceipt(response, browser)
}

export async function getShopifyInstall(pool: Pool, request: Request) {
  const browser = receipt(request)
  if (!browser) throw unavailable()
  const { rows } = await pool.query<Intent>(
    "SELECT * FROM shopify_install_intent WHERE browser_hash=$1 AND client_id=$2 AND expires_at>now()",
    [digest(browser), nativeShopify().config.apiKey]
  )
  const row = rows[0]
  if (
    !row ||
    !row.shop ||
    !row.shop_id ||
    (!row.session_encrypted && !row.claimed_project_id)
  )
    throw unavailable()
  return row
}

/** Caller identity comes from the Datool session. Shop identity comes only from OAuth. */
export async function claimShopifyInstall(
  pool: Pool,
  request: Request,
  userId: string,
  organizationId: string,
  projectId?: string
) {
  const intent = await getShopifyInstall(pool, request)
  const membership = await pool.query(
    'SELECT role FROM member WHERE "organizationId"=$1 AND "userId"=$2',
    [organizationId, userId]
  )
  if (
    !membership.rows[0]?.role
      .split(",")
      .some((r: string) => ["owner", "admin"].includes(r.trim()))
  )
    throw new TracerError(
      "UNAUTHORIZED",
      "An organization owner or admin must connect Shopify.",
      { status: 403 }
    )
  return withBillingLock(organizationId, async (client, billing) => {
    await client.query("BEGIN")
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `shopify:${intent.client_id}:${intent.shop}`,
      ])
      const { rows } = await client.query<Intent>(
        "SELECT * FROM shopify_install_intent WHERE id=$1 AND expires_at>now() FOR UPDATE",
        [intent.id]
      )
      const current = rows[0]
      if (!current) throw unavailable()
      const existing = await client.query<{
        connection_id: string
        project_id: string
      }>(
        "SELECT s.connection_id,s.project_id FROM build_shopify_connections s JOIN build_app_connections c ON c.id=s.connection_id WHERE s.shop=$1 AND s.client_id=$2 FOR UPDATE OF s,c",
        [current.shop, current.client_id]
      )
      let target =
        current.claimed_project_id ??
        current.project_id ??
        projectId ??
        existing.rows[0]?.project_id
      if (target) {
        const project = await client.query(
          "SELECT id FROM project WHERE id=$1 AND organization_id=$2",
          [target, organizationId]
        )
        if (
          !project.rowCount ||
          (current.project_id && projectId && projectId !== current.project_id)
        )
          throw unavailable()
      }
      if (!target) {
        target = randomUUID()
        await client.query(
          "INSERT INTO project(id,organization_id,name,slug) VALUES($1,$2,$3,$4)",
          [
            target,
            organizationId,
            "Shopify store",
            `shopify-${target.slice(0, 8)}`,
          ]
        )
      }
      if (!current.claimed_project_id) {
        if (existing.rows[0] && existing.rows[0].project_id !== target)
          throw unavailable()
        if (
          billing.provider === "shopify" &&
          (billing.shopify_shop !== current.shop ||
            billing.shopify_client_id !== current.client_id)
        )
          throw new TracerError(
            "CONFLICT",
            "This organization already bills through another Shopify store. Connect this store to a separate organization."
          )
        // External customers keep their existing payment relationship. A pending
        // Stripe checkout also stays external, so it cannot race a second charge.
        if (
          current.source === "shopify" &&
          billing.provider === "stripe" &&
          !billing.customer_id &&
          !billing.subscription_id &&
          !billing.checkout_session_id
        ) {
          await client.query(
            `UPDATE organization_billing SET provider='shopify',shopify_shop=$2,shopify_shop_id=$3,shopify_client_id=$4 WHERE organization_id=$1`,
            [organizationId, current.shop, current.shop_id, current.client_id]
          )
          billing.provider = "shopify"
        }
        if (!current.session_encrypted) throw unavailable()
        const session = Session.fromPropertyArray(
          JSON.parse(
            decryptProviderKey(
              current.session_encrypted,
              current.id,
              `shopify-install:${current.client_id}`
            )
          )
        )
        const connectionId = existing.rows[0]?.connection_id ?? randomUUID()
        await client.query(
          `INSERT INTO build_app_connections(id,project_id,request_key,toolkit,label,provider_user_id,auth_config_id,status)
          VALUES($1,$2,$3,$4,$5,$6,'shopify-native-v1','active') ON CONFLICT(id) DO UPDATE SET status='active',updated_at=now()`,
          [
            connectionId,
            target,
            `shopify-install:${current.id}`,
            SHOPIFY_TOOLKIT,
            current.shop,
            composioUserId(organizationId, target),
          ]
        )
        await client.query(
          `INSERT INTO build_shopify_connections(connection_id,project_id,shop,client_id,authorization_expires_at,session_encrypted,installed_at)
          VALUES($1,$2,$3,$4,now(),$5,now()) ON CONFLICT(connection_id) DO UPDATE SET session_encrypted=$5,oauth_state_hash=NULL,start_token_hash=NULL,installed_at=now()`,
          [
            connectionId,
            target,
            current.shop,
            current.client_id,
            encryptProviderKey(
              JSON.stringify(session.toPropertyArray()),
              target,
              `shopify:${connectionId}`
            ),
          ]
        )
        await client.query(
          "UPDATE shopify_install_intent SET claimed_project_id=$2,session_encrypted=NULL WHERE id=$1",
          [current.id, target]
        )
      }
      await client.query("COMMIT")
      return {
        projectId: target,
        organizationId,
        provider: billing.provider,
        url: billing.provider === "shopify" ? "/billing" : "/projects",
      }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    }
  })
}
