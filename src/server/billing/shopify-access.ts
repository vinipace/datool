import { createHash } from "node:crypto"
import type { Pool, PoolClient } from "pg"

export const SHOPIFY_INSTALL_COOKIE = "__Host-datool-shopify-install"

export function shopifyInstallReceipt(headers: Headers) {
  const value = headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SHOPIFY_INSTALL_COOKIE}=`))
    ?.slice(SHOPIFY_INSTALL_COOKIE.length + 1)
  return value && /^[\w-]{43}$/.test(value) ? value : null
}

/** Resolve billing from verified installation history, never a URL's shop parameter.
 * Keep this independent of the billing store so it can run under its lock. */
export async function shopifyBillingDestination(
  pool: Pool | PoolClient,
  context: {
    organizationId?: string | null
    userId?: string
    headers?: Headers
  }
): Promise<"/billing" | "/shopify/connect" | null> {
  const receipt = context.headers && shopifyInstallReceipt(context.headers)
  if (receipt && process.env.DATOOL_SHOPIFY_CLIENT_ID) {
    const pending = await pool.query(
      `SELECT 1 FROM shopify_install_intent
       WHERE browser_hash=$1 AND client_id=$2 AND expires_at>now()
         AND shop_id IS NOT NULL AND session_encrypted IS NOT NULL
         AND claimed_project_id IS NULL`,
      [
        createHash("sha256").update(receipt).digest("hex"),
        process.env.DATOOL_SHOPIFY_CLIENT_ID,
      ]
    )
    if (pending.rowCount) return "/shopify/connect"
  }
  if (context.organizationId) {
    const current = await pool.query<{ provider: string }>(
      "SELECT provider FROM organization_billing WHERE organization_id=$1",
      [context.organizationId]
    )
    if (current.rows[0]?.provider === "shopify") return "/billing"
  }
  // Include disconnected installations: disconnecting must not unlock Stripe.
  const linked = await pool.query(
    `SELECT 1 FROM organization o
     WHERE (o.id=$1 OR EXISTS (
       SELECT 1 FROM member m WHERE m."organizationId"=o.id AND m."userId"=$2
     )) AND (
       EXISTS (SELECT 1 FROM organization_billing b WHERE b.organization_id=o.id AND b.provider='shopify')
       OR EXISTS (SELECT 1 FROM project p JOIN build_shopify_connections c ON c.project_id=p.id WHERE p.organization_id=o.id)
     ) LIMIT 1`,
    [context.organizationId ?? null, context.userId ?? null]
  )
  return linked.rowCount ? "/shopify/connect" : null
}
