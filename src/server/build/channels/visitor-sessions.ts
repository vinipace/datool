import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { sql } from "drizzle-orm"
import { verifyNewVisitorChallenge } from "./challenge"
import type { BuildContext } from "../context"
import {
  channelSigningSecret,
  signVisitorContext,
  verifyVisitorContext,
} from "./visitor"

const lifetime = 30 * 24 * 60 * 60

function browserSignature(value: string) {
  return createHmac("sha256", channelSigningSecret())
    .update(`shopify-browser:${value}`)
    .digest("base64url")
}

/** A browser credential can only be exchanged at a freshly authenticated Shopify proxy. */
function browserId(token: string | undefined, connectionId: string) {
  if (!token) return { id: randomUUID(), version: 1, newVisitor: true }
  const [encoded, signature, extra] = token.split(".")
  if (!encoded || !signature || extra)
    throw new Error("Invalid visitor browser credential.")
  const expected = Buffer.from(browserSignature(encoded))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new Error("Invalid visitor browser credential.")
  const value = JSON.parse(Buffer.from(encoded, "base64url").toString())
  if (
    value.connectionId !== connectionId ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    !Number.isFinite(value.expiresAt) ||
    !Number.isInteger(value.version) ||
    value.version < 1
  )
    throw new Error("Visitor browser credential expired.")
  if (value.expiresAt <= Date.now() / 1000)
    return { id: randomUUID(), version: 1, newVisitor: true }
  return {
    id: value.id as string,
    version: value.version as number,
    newVisitor: false,
  }
}

export async function issueShopifyVisitor(
  context: BuildContext,
  input: {
    connectionId: string
    shop: string
    customerId: string
    browserToken?: string
    challengeToken?: string
    origin: string
  }
) {
  const { id, version, newVisitor } = browserId(
    input.browserToken,
    input.connectionId
  )
  if (newVisitor)
    await verifyNewVisitorChallenge(input.connectionId, input.challengeToken)
  if (newVisitor)
    await context.database.execute(sql`
    DELETE FROM build_shopify_visitor_sessions WHERE id IN (
      SELECT id FROM build_shopify_visitor_sessions WHERE project_id=${context.projectId} AND expires_at<now() LIMIT 100
    )
  `)
  const identity = input.customerId
    ? `customer:${input.shop}:${input.customerId}`
    : `guest:${id}`
  // Keep raw Shopify customer IDs out of public tokens, URLs, and analytics.
  const visitorId = createHmac("sha256", channelSigningSecret())
    .update(`shopify-visitor:${input.connectionId}:${identity}`)
    .digest("hex")
  const expiresAt = Math.floor(Date.now() / 1000) + lifetime
  const result = await context.database.execute<{
    identity_version: number
  }>(sql`
    INSERT INTO build_shopify_visitor_sessions (id,project_id,connection_id,visitor_id,expires_at)
    VALUES (${id}::uuid,${context.projectId},${input.connectionId}::uuid,${visitorId},${new Date(expiresAt * 1000)})
    ON CONFLICT (id) DO UPDATE SET
      identity_version = build_shopify_visitor_sessions.identity_version +
        CASE WHEN build_shopify_visitor_sessions.visitor_id = EXCLUDED.visitor_id THEN 0 ELSE 1 END,
      visitor_id = EXCLUDED.visitor_id, expires_at = EXCLUDED.expires_at, updated_at = now()
    WHERE build_shopify_visitor_sessions.project_id = EXCLUDED.project_id
      AND build_shopify_visitor_sessions.connection_id = EXCLUDED.connection_id
      AND (build_shopify_visitor_sessions.visitor_id=EXCLUDED.visitor_id OR build_shopify_visitor_sessions.identity_version=${version})
    RETURNING identity_version
  `)
  if (!result.rows[0]) throw new Error("Invalid visitor browser credential.")
  const encoded = Buffer.from(
    JSON.stringify({
      id,
      connectionId: input.connectionId,
      expiresAt,
      version: Number(result.rows[0].identity_version),
    })
  ).toString("base64url")
  return {
    browserToken: `${encoded}.${browserSignature(encoded)}`,
    visitorToken: signVisitorContext({
      visitorId,
      connectionId: input.connectionId,
      origin: input.origin,
      browserSessionId: id,
      identityVersion: Number(result.rows[0].identity_version),
      expiresAt: Math.floor(Date.now() / 1000) + 5 * 60,
    }),
    visitorId,
  }
}

export async function verifyChannelVisitor(
  context: BuildContext,
  token: string,
  options: { origin?: string; connectionId: string }
) {
  const visitor = verifyVisitorContext(token, options)
  if (visitor.browserSessionId) {
    const result = await context.database.execute(sql`
      SELECT 1 FROM build_shopify_visitor_sessions v
      JOIN build_channel_connection c ON c.id=v.connection_id AND c.project_id=v.project_id
      JOIN build_shopify_connections s ON s.project_id=v.project_id AND s.shop=c.config_json->>'shopifyShop'
      JOIN build_app_connections a ON a.id=s.connection_id AND a.project_id=s.project_id AND a.status='active'
      WHERE v.id=${visitor.browserSessionId}::uuid AND v.project_id=${context.projectId}
        AND v.connection_id=${options.connectionId}::uuid AND v.visitor_id=${visitor.visitorId}
        AND v.identity_version=${visitor.identityVersion} AND v.expires_at>now()
        AND s.client_id=${process.env.DATOOL_SHOPIFY_CLIENT_ID ?? ""}
    `)
    if (!result.rows.length)
      throw new Error("Visitor context changed. Please reconnect the chat.")
  }
  return visitor
}
