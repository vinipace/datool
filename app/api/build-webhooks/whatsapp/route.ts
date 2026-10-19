import { db } from "@/lib/db"
import { createTracerDatabase } from "@/src/server/tracer/db"
import { ingestWhatsAppWebhook } from "@/src/server/build/channels/whatsapp-webhook"
import {
  verifyWhatsAppChallenge,
  verifyWhatsAppSignature,
} from "@/src/server/build/channels/whatsapp-api"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60
const headers = { "Cache-Control": "no-store" }
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams
  if (
    query.get("hub.mode") !== "subscribe" ||
    !verifyWhatsAppChallenge(query.get("hub.verify_token"))
  )
    return new Response("Verification failed", { status: 403, headers })
  const challenge = query.get("hub.challenge")
  if (!challenge || !/^\d{1,100}$/.test(challenge))
    return new Response("Invalid challenge", { status: 400, headers })
  return new Response(challenge, {
    headers: { ...headers, "Content-Type": "text/plain" },
  })
}
export async function POST(request: Request) {
  // Verify the signature over the exact bytes, before parsing or tenant lookup.
  const reader = request.body?.getReader()
  if (!reader) return new Response("Missing body", { status: 400, headers })
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > 4 * 1024 * 1024) {
        await reader.cancel()
        return new Response("Body too large", { status: 413, headers })
      }
      chunks.push(next.value)
    }
    const body = Buffer.concat(chunks)
    if (
      !verifyWhatsAppSignature(body, request.headers.get("x-hub-signature-256"))
    )
      return new Response("Invalid signature", { status: 401, headers })
    let payload: unknown
    try {
      payload = JSON.parse(body.toString("utf8"))
    } catch {
      return new Response("Invalid JSON", { status: 400, headers })
    }
    const result = await ingestWhatsAppWebhook(
      payload,
      async (wabaId, phoneId) => {
        const targets = await db.query<{
          project_id: string
          connection_id: string
          organization_id: string
        }>(
          `SELECT a.project_id,a.connection_id,c.organization_id FROM build_whatsapp_account a JOIN build_channel_connection c ON c.id=a.connection_id WHERE a.waba_id=$1 AND ($2::text IS NULL OR a.phone_number_id=$2)`,
          [wabaId, phoneId]
        )
        return targets.rows.map((row) => ({
          connectionId: row.connection_id,
          context: {
            database: createTracerDatabase(undefined, {
              projectId: row.project_id,
            }),
            projectId: row.project_id,
            organizationId: row.organization_id,
          },
        }))
      }
    )
    return Response.json({ ok: true, ...result }, { headers })
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "name" in error &&
      error.name === "ZodError"
    )
      return new Response("Invalid WhatsApp event", { status: 400, headers })
    const failure = error as { code?: string; cause?: { code?: string } }
    const code = String(failure?.cause?.code ?? failure?.code ?? "UNKNOWN")
      .replace(/[^A-Za-z0-9_]/g, "")
      .slice(0, 50)
    console.error(`[whatsapp-webhook] admission failed (${code})`)
    // Returning 503 asks Meta to retry. Previously admitted events deduplicate.
    return new Response("Webhook admission temporarily unavailable", {
      status: 503,
      headers,
    })
  } finally {
    reader.releaseLock()
  }
}
