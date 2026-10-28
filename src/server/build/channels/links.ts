import { createHash, randomBytes } from "node:crypto"
import { isIP } from "node:net"
import { sql } from "drizzle-orm"
import { db } from "@/lib/db"
import { buildEnabled } from "@/lib/build/config"
import { createTracerDatabase } from "@/src/server/tracer/db"
import { TracerError } from "@/src/server/tracer/errors"
import type { BuildContext } from "../context"
import { whatsappText } from "./whatsapp-text"

function publicHttps(value: string) {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase().replace(/\.$/, "")
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      value.length > 2048 ||
      isIP(host.replace(/^\[|\]$/g, "")) ||
      !host.includes(".") ||
      /\.(localhost|local|internal|test|invalid)$/.test(host)
    )
      return null
    return url
  } catch {
    return null
  }
}
function origin() {
  return publicHttps(process.env.DATOOL_PUBLIC_URL ?? "")?.origin ?? null
}

/** Called in the outbound admission transaction, after inserting its message. */
export async function prepareWhatsAppText(
  context: BuildContext,
  messageId: string,
  text: string
) {
  const base = origin()
  if (!base) return whatsappText(text)
  const urls = new Map<string, string>()
  whatsappText(text, (target, label) => {
    const url = publicHttps(target)
    if (
      url &&
      !(url.origin === base && url.pathname.startsWith("/l/")) &&
      urls.size < 20
    )
      urls.set(url.href, label === target ? "" : label.slice(0, 200))
    return target
  })
  const replacements = new Map<string, string>()
  for (const [original, label] of urls) {
    const target = new URL(original)
    for (const [name, value] of [
      ["utm_source", "trydatool.com"],
      ["utm_medium", "whatsapp"],
    ]) {
      // Append without reserializing existing checkout query parameters.
      if (!target.searchParams.has(name))
        target.search += `${target.search ? "&" : "?"}${name}=${value}`
    }
    const destination = target.href
    if (destination.length > 2048) continue
    const hash = createHash("sha256").update(destination).digest("hex")
    const result = await context.database.execute<{ token: string }>(sql`
      INSERT INTO build_channel_link(token,project_id,message_id,destination,destination_hash,label)
      VALUES(${randomBytes(18).toString("base64url")},${context.projectId},${messageId},${destination},${hash},${label})
      ON CONFLICT(project_id,message_id,destination_hash) DO UPDATE SET label=build_channel_link.label
      RETURNING token
    `)
    replacements.set(original, `${base}/l/${result.rows[0].token}`)
  }
  return whatsappText(text, (url) => replacements.get(new URL(url).href) ?? url)
}

/** Random tokens are the only public capability; destinations never come from request input. */
export async function publicLinkContext(
  token: string
): Promise<BuildContext | null> {
  if (!/^[A-Za-z0-9_-]{24}$/.test(token)) return null
  const result = await db.query<{
    project_id: string
    organization_id: string
  }>(
    `SELECT l.project_id,p.organization_id FROM build_channel_link l JOIN project p ON p.id=l.project_id WHERE l.token=$1 AND l.expires_at>now()`,
    [token]
  )
  const row = result.rows[0]
  if (!row || !buildEnabled(row.organization_id)) return null
  return {
    projectId: row.project_id,
    organizationId: row.organization_id,
    database: createTracerDatabase(undefined, { projectId: row.project_id }),
  }
}

export async function resolveChannelLink(
  context: BuildContext,
  token: string,
  request: Request
) {
  const found = await context.database.execute<{ destination: string }>(sql`
    SELECT l.destination FROM build_channel_link l JOIN build_channel_message m ON m.project_id=l.project_id AND m.id=l.message_id
    WHERE l.project_id=${context.projectId} AND l.token=${token} AND l.expires_at>now()
      AND m.direction='outbound' AND m.status IN ('sent','delivered')
  `)
  const target = found.rows[0]?.destination
  if (!target || !publicHttps(target)) return null
  if (request.method === "GET") {
    const automatic =
      /bot|crawl|spider|preview|facebookexternalhit|whatsapp|slack|discord|telegram|curl|wget/i.test(
        request.headers.get("user-agent") ?? ""
      ) ||
      /prefetch|preview/i.test(
        [
          request.headers.get("purpose"),
          request.headers.get("sec-purpose"),
        ].join(" ")
      )
    // No IP address, user agent, cookies or visitor fingerprint is retained.
    try {
      await context.database.execute(sql`
        UPDATE build_channel_link SET
          estimated_clicks=estimated_clicks+${automatic ? 0 : 1},
          automated_visits=automated_visits+${automatic ? 1 : 0},
          last_clicked_at=CASE WHEN ${automatic} THEN last_clicked_at ELSE now() END
        WHERE project_id=${context.projectId} AND token=${token}
      `)
    } catch {
      /* Analytics must not prevent an otherwise valid checkout redirect. */
    }
  }
  return target
}

export async function listChannelLinks(
  context: BuildContext,
  connectionId: string
) {
  const connection = await context.database.execute(
    sql`SELECT 1 FROM build_channel_connection WHERE project_id=${context.projectId} AND id=${connectionId}::uuid`
  )
  if (!connection.rows.length)
    throw new TracerError("NOT_FOUND", "Channel was not found.")
  const result = await context.database.execute<{
    token: string
    destination: string
    label: string
    conversation_id: string
    estimated_clicks: string
    automated_visits: string
    created_at: string
    last_clicked_at: string | null
    expires_at: string
  }>(sql`
    SELECT l.*,m.conversation_id FROM build_channel_link l
    JOIN build_channel_message m ON m.project_id=l.project_id AND m.id=l.message_id
    WHERE l.project_id=${context.projectId} AND m.connection_id=${connectionId}::uuid AND m.status IN ('sent','delivered')
    ORDER BY l.created_at DESC,l.token DESC LIMIT 20
  `)
  return {
    items: result.rows.map((row) => ({
      token: row.token,
      destination: row.destination,
      label: row.label,
      conversationId: row.conversation_id,
      clicks: Number(row.estimated_clicks),
      automatedVisits: Number(row.automated_visits),
      createdAt: new Date(row.created_at).toISOString(),
      lastClickedAt: row.last_clicked_at
        ? new Date(row.last_clicked_at).toISOString()
        : null,
      expiresAt: new Date(row.expires_at).toISOString(),
    })),
  }
}
