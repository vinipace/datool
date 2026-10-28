import { db } from "@/lib/db"
import { buildEnabled } from "@/lib/build/config"
import { createTracerDatabase } from "@/src/server/tracer/db"
import {
  verifyZernioSignature,
  zernioObject,
} from "@/src/server/build/channels/zernio-api"
import { ingestZernioWebhook } from "@/src/server/build/channels/zernio-webhook"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export async function POST(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) return new Response("Missing body", { status: 400 })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4 * 1024 * 1024)
        return new Response("Body too large", { status: 413 })
      chunks.push(value)
    }
    const body = Buffer.concat(chunks)
    if (!verifyZernioSignature(body, request.headers.get("x-zernio-signature")))
      return new Response("Invalid signature", { status: 401 })
    let payload: unknown
    try {
      payload = JSON.parse(body.toString("utf8"))
    } catch {
      return new Response("Invalid JSON", { status: 400 })
    }
    const event = zernioObject(payload)
    if (event.event === "webhook.test" || event.test === true)
      return Response.json({ ok: true })
    const account = zernioObject(event.account),
      accountId = account.accountId ?? account.id
    if (
      typeof accountId !== "string" ||
      accountId.length > 200 ||
      account.platform !== "whatsapp"
    )
      return Response.json({ ok: true })
    const rows = await db.query<{
      project_id: string
      connection_id: string
      organization_id: string
    }>(
      `SELECT b.project_id,b.connection_id,c.organization_id FROM build_zernio_whatsapp b JOIN build_channel_connection c ON c.id=b.connection_id AND c.project_id=b.project_id WHERE b.account_id=$1`,
      [accountId]
    )
    if (!rows.rows.length && typeof account.profileId === "string") {
      const pending = await db.query(
        `SELECT 1 FROM build_zernio_whatsapp WHERE profile_id=$1 AND account_id IS NULL AND signup_expires_at>now()`,
        [account.profileId]
      )
      if (pending.rows.length && event.event === "message.received")
        return new Response("Connection setup is not complete", { status: 503 })
    }
    for (const row of rows.rows) {
      if (!buildEnabled(row.organization_id)) continue
      await ingestZernioWebhook(
        {
          database: createTracerDatabase(undefined, {
            projectId: row.project_id,
          }),
          projectId: row.project_id,
          organizationId: row.organization_id,
        },
        row.connection_id,
        payload
      )
    }
    return Response.json({ ok: true })
  } catch {
    return new Response("Webhook temporarily unavailable", { status: 503 })
  } finally {
    void reader.cancel().catch(() => {})
  }
}
