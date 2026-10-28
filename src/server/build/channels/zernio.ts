import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { TracerError } from "@/src/server/tracer/errors"
import type { BuildContext } from "../context"
import type { OutboundEnvelope } from "@/src/lib/build/channels"
import type { WhatsAppMode } from "@/src/lib/build/whatsapp"
import { WhatsAppApiError } from "./whatsapp-api"
import { assertPublicHttpUrl } from "../http"
import { zernioObject, zernioReady, zernioRequest } from "./zernio-api"

type Row = Record<string, unknown>
const invalid = (message: string) =>
  new TracerError("VALIDATION_ERROR", message)
const id = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 200
    ? value
    : null
const path = (value: string) => encodeURIComponent(value)

async function connection(context: BuildContext, connectionId: string) {
  const result = await context.database.execute<Row>(sql`
    SELECT c.*,p.slug AS project_slug FROM build_channel_connection c
    JOIN project p ON p.id=c.project_id
    WHERE c.project_id=${context.projectId} AND c.id=${connectionId}::uuid
      AND c.channel='whatsapp' AND c.config_json->>'provider'='zernio'
  `)
  if (!result.rows[0])
    throw new TracerError("NOT_FOUND", "WhatsApp channel was not found.")
  return result.rows[0]
}

export async function getZernioConnection(
  context: BuildContext,
  connectionId: string
) {
  const channel = await connection(context, connectionId)
  const result = await context.database.execute<Row>(
    sql`SELECT * FROM build_zernio_whatsapp WHERE project_id=${context.projectId} AND connection_id=${connectionId}::uuid`
  )
  const row = result.rows[0]
  return {
    configured: zernioReady(),
    status: String(channel.status),
    account: row?.account_id
      ? {
          displayPhoneNumber: String(row.display_phone_number ?? ""),
          mode: String(row.mode),
          connectedAt: row.connected_at
            ? new Date(String(row.connected_at)).toISOString()
            : null,
        }
      : null,
  }
}

async function profileFor(connectionId: string) {
  const externalId = `datool-whatsapp-${connectionId}`
  const find = async () => {
    const result = await zernioRequest<{ profiles?: Row[] }>(
      `/profiles?${new URLSearchParams({ externalId })}`
    )
    return (result.profiles ?? []).find((p) => p.externalId === externalId)
  }
  let profile = await find()
  if (!profile) {
    try {
      const result = await zernioRequest<{ profile?: Row }>("/profiles", {
        method: "POST",
        body: { name: externalId, externalId },
      })
      profile = result.profile
    } catch (error) {
      // A lost response or a concurrent request can leave the profile created.
      profile = await find()
      if (!profile) throw error
    }
  }
  const profileId = id(profile?._id ?? profile?.id)
  if (!profileId || profile?.externalId !== externalId)
    throw invalid("Could not verify the WhatsApp setup. Try again.")
  return profileId
}

export async function beginZernioSignup(
  context: BuildContext,
  input: { connectionId: string; mode: WhatsAppMode }
) {
  if (!zernioReady())
    throw invalid("WhatsApp is not configured on this installation.")
  const channel = await connection(context, input.connectionId)
  const existing = await context.database.execute<Row>(
    sql`SELECT * FROM build_zernio_whatsapp WHERE project_id=${context.projectId} AND connection_id=${input.connectionId}::uuid`
  )
  if (existing.rows[0]?.account_id && channel.status !== "error")
    throw invalid("Disconnect this number before connecting another.")
  const profileId = existing.rows[0]?.profile_id
    ? String(existing.rows[0].profile_id)
    : await profileFor(input.connectionId)
  const signupId = randomUUID()
  const started = await context.database.execute(sql`
    INSERT INTO build_zernio_whatsapp(connection_id,project_id,profile_id,mode,signup_id,signup_expires_at)
    VALUES(${input.connectionId}::uuid,${context.projectId},${profileId},${input.mode},${signupId}::uuid,now()+interval '30 minutes')
    ON CONFLICT(connection_id) DO UPDATE SET mode=EXCLUDED.mode,signup_id=EXCLUDED.signup_id,signup_expires_at=EXCLUDED.signup_expires_at
    WHERE build_zernio_whatsapp.project_id=${context.projectId} AND (build_zernio_whatsapp.account_id IS NULL OR ${channel.status === "error"})
    RETURNING connection_id
  `)
  if (!started.rows.length) throw invalid("This number is already connected.")
  const origin = new URL(process.env.DATOOL_PUBLIC_URL!).origin
  const redirect = new URL(
    `/p/${encodeURIComponent(String(channel.project_slug))}/build/integrations/${input.connectionId}`,
    origin
  )
  redirect.searchParams.set("agentId", String(channel.agent_id))
  redirect.searchParams.set("zernioSignup", signupId)
  const query = new URLSearchParams({
    profileId,
    redirect_url: redirect.toString(),
    onboarding: input.mode === "cloud" ? "api" : "business_app",
  })
  const result = await zernioRequest<{ authUrl?: string }>(
    `/connect/whatsapp?${query}`
  )
  let url: URL
  try {
    url = new URL(String(result.authUrl))
  } catch {
    throw invalid("WhatsApp setup could not start. Try again.")
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    ![
      "www.facebook.com",
      "web.facebook.com",
      "m.facebook.com",
      "zernio.com",
    ].includes(url.hostname)
  )
    throw invalid("WhatsApp returned an invalid setup address.")
  return { authUrl: url.toString() }
}

/** The callback is untrusted. Verify the selected account belongs to this
 * connection's dedicated profile before binding it to a tenant. */
export async function finishZernioSignup(
  context: BuildContext,
  input: { connectionId: string; signupId: string; accountId: string }
) {
  await connection(context, input.connectionId)
  const found = await context.database.execute<Row>(
    sql`SELECT * FROM build_zernio_whatsapp WHERE project_id=${context.projectId} AND connection_id=${input.connectionId}::uuid AND signup_id=${input.signupId}::uuid AND signup_expires_at>now()`
  )
  const binding = found.rows[0]
  if (!binding) throw invalid("This setup has expired. Start again.")
  const profileId = String(binding.profile_id)
  const response = await zernioRequest<{ accounts?: Row[] }>(
    `/accounts?${new URLSearchParams({ profileId })}`
  )
  const account = (response.accounts ?? []).find((item) => {
    const profile =
      typeof item.profileId === "string"
        ? item.profileId
        : (zernioObject(item.profileId)._id ?? zernioObject(item.profileId).id)
    return (
      (item._id === input.accountId ||
        item.id === input.accountId ||
        item.accountId === input.accountId) &&
      profile === profileId &&
      item.platform === "whatsapp" &&
      item.isActive === true
    )
  })
  if (!account)
    throw invalid(
      "Meta did not confirm this number for the current connection."
    )
  const phone = String(account.username ?? "").slice(0, 50)
  if (!/^[1-9]\d{6,19}$/.test(phone.replace(/\D/g, "")))
    throw invalid("Meta did not return a valid business phone number.")
  await context.database.transaction(async (tx) => {
    const updated = await tx.execute(
      sql`UPDATE build_zernio_whatsapp SET account_id=${input.accountId},display_phone_number=${phone},connected_at=now(),signup_id=NULL,signup_expires_at=NULL WHERE project_id=${context.projectId} AND connection_id=${input.connectionId}::uuid AND signup_id=${input.signupId}::uuid AND signup_expires_at>now() AND (account_id IS NULL OR account_id=${input.accountId}) RETURNING account_id`
    )
    if (!updated.rows.length)
      throw invalid("This setup has expired or was already used.")
    await tx.execute(
      sql`UPDATE build_channel_connection SET status='connected',external_id=${input.accountId},webhook_mode='webhook',last_error=NULL WHERE project_id=${context.projectId} AND id=${input.connectionId}::uuid`
    )
  })
  return getZernioConnection(context, input.connectionId)
}

export async function zernioAccount(
  context: BuildContext,
  connectionId: string
) {
  const channel = await connection(context, connectionId)
  const result = await context.database.execute<Row>(
    sql`SELECT * FROM build_zernio_whatsapp WHERE project_id=${context.projectId} AND connection_id=${connectionId}::uuid`
  )
  const row = result.rows[0]
  if (!row?.account_id) throw invalid("Connect this WhatsApp number first.")
  return { channel, accountId: String(row.account_id), binding: row }
}

export async function disconnectZernio(
  context: BuildContext,
  connectionId: string
) {
  await connection(context, connectionId)
  const found = await context.database.execute<Row>(
    sql`SELECT account_id FROM build_zernio_whatsapp WHERE project_id=${context.projectId} AND connection_id=${connectionId}::uuid`
  )
  const accountId = id(found.rows[0]?.account_id)
  // Pause delivery before contacting the provider. A failed disconnect remains
  // paused with its binding intact so the owner can safely retry.
  await context.database.execute(
    sql`UPDATE build_channel_connection SET status='paused' WHERE project_id=${context.projectId} AND id=${connectionId}::uuid`
  )
  if (accountId)
    await zernioRequest(`/accounts/${path(accountId)}`, {
      method: "DELETE",
      allowMissing: true,
    })
  await context.database.transaction(async (tx) => {
    await tx.execute(
      sql`UPDATE build_channel_connection SET status='disconnected',external_id=NULL,last_error=NULL WHERE project_id=${context.projectId} AND id=${connectionId}::uuid`
    )
    await tx.execute(
      sql`UPDATE build_zernio_whatsapp SET account_id=NULL,signup_id=NULL,signup_expires_at=NULL,connected_at=NULL WHERE project_id=${context.projectId} AND connection_id=${connectionId}::uuid`
    )
    await tx.execute(
      sql`UPDATE build_channel_job SET status='failed',last_error='WhatsApp disconnected.' WHERE project_id=${context.projectId} AND connection_id=${connectionId}::uuid AND status='queued'`
    )
  })
  return { disconnected: true }
}

export async function sendZernioEnvelope(
  context: BuildContext,
  envelope: OutboundEnvelope,
  externalConversationId: string,
  messageId: string
) {
  const { channel, accountId } = await zernioAccount(
    context,
    envelope.connectionId
  )
  if (channel.status !== "connected")
    throw new WhatsAppApiError(
      "WHATSAPP_DISCONNECTED",
      "This WhatsApp channel is not connected."
    )
  const prefix = `${accountId}:`
  if (!externalConversationId.startsWith(prefix))
    throw invalid("WhatsApp conversation does not belong to this number.")
  const conversationId = externalConversationId.slice(prefix.length)
  if (!id(conversationId)) throw invalid("WhatsApp conversation is invalid.")
  const record = await context.database.execute<Row>(sql`
    SELECT m.content_json->'metadata'->'zernio'->>'recipient' AS recipient, r.last_customer_message_at,r.opted_out,r.template_opt_in,p.status AS contact_status
    FROM build_conversations c
    LEFT JOIN LATERAL (SELECT content_json FROM build_channel_message WHERE project_id=c.project_id AND connection_id=${envelope.connectionId}::uuid AND conversation_id=c.id AND direction='inbound' ORDER BY created_at DESC LIMIT 1) m ON true
    LEFT JOIN build_whatsapp_recipient r ON r.project_id=c.project_id AND r.connection_id=${envelope.connectionId}::uuid AND r.recipient_id=m.content_json->'metadata'->'zernio'->>'recipient'
    LEFT JOIN build_contacts p ON p.project_id=c.project_id AND p.id=c.metadata_json->>'contactId'
    WHERE c.project_id=${context.projectId} AND c.id=${envelope.conversationId} AND c.external_conversation_id=${externalConversationId} AND c.metadata_json->>'connectionId'=${envelope.connectionId}
  `)
  const recipient = record.rows[0]
  if (
    !recipient?.recipient ||
    recipient.opted_out ||
    ["blocked", "archived"].includes(String(recipient.contact_status))
  )
    throw new WhatsAppApiError(
      "WHATSAPP_OPTED_OUT",
      "This customer has opted out or is blocked."
    )
  const template = zernioObject(envelope.metadata?.whatsappTemplate)
  const hasTemplate = typeof template.name === "string"
  if (hasTemplate && !recipient.template_opt_in)
    throw new WhatsAppApiError(
      "WHATSAPP_CONSENT_REQUIRED",
      "Record the customer's permission before sending a template."
    )
  if (
    !hasTemplate &&
    (!recipient.last_customer_message_at ||
      Date.now() -
        new Date(String(recipient.last_customer_message_at)).getTime() >=
        86_400_000)
  )
    throw new WhatsAppApiError(
      "WHATSAPP_WINDOW_CLOSED",
      "The 24-hour reply window has closed. Send an approved template."
    )
  let body: Record<string, unknown>
  if (hasTemplate) {
    body = {
      accountId,
      template: {
        elements: [
          { ...template, language: zernioObject(template.language).code },
        ],
      },
    }
  } else if (envelope.attachments?.length) {
    const attachment = envelope.attachments[0]
    if (
      envelope.attachments.length !== 1 ||
      !["image", "audio", "video", "document"].includes(attachment.type) ||
      !attachment.url ||
      envelope.text.length > 1024 ||
      (attachment.type === "audio" && envelope.text)
    )
      throw invalid("Send one supported attachment with a public HTTPS URL.")
    try {
      if (assertPublicHttpUrl(attachment.url).protocol !== "https:")
        throw new Error("HTTPS required")
    } catch {
      throw invalid("Use a public HTTPS URL for WhatsApp attachments.")
    }
    body = {
      accountId,
      attachmentUrl: attachment.url,
      attachmentType: attachment.type === "document" ? "file" : attachment.type,
      ...(envelope.text ? { message: envelope.text } : {}),
      ...(attachment.type === "document" && attachment.name
        ? { attachmentName: attachment.name }
        : {}),
    }
  } else body = { accountId, message: envelope.text }
  const result = await zernioRequest<{
    success?: boolean
    data?: { messageId?: string; partialFailure?: unknown }
  }>(`/inbox/conversations/${path(conversationId)}/messages`, {
    method: "POST",
    body,
    sending: true,
    idempotencyKey: envelope.idempotencyKey,
  })
  const providerId = id(result.data?.messageId)
  if (!result.success || !providerId || result.data?.partialFailure)
    throw new WhatsAppApiError(
      "INVALID_PROVIDER_RESPONSE",
      "WhatsApp could not confirm the reply.",
      true
    )
  try {
    await context.database.execute(
      sql`UPDATE build_channel_message SET provider_message_id=${providerId},status='sent' WHERE project_id=${context.projectId} AND connection_id=${envelope.connectionId}::uuid AND id=${messageId}`
    )
  } catch {
    throw new WhatsAppApiError(
      "INVALID_PROVIDER_RESPONSE",
      "WhatsApp accepted the reply but it could not be saved.",
      true
    )
  }
  return [providerId]
}

/** Retrieve only an attachment already admitted to this tenant's message ledger. */
export async function downloadZernioMedia(
  context: BuildContext,
  messageId: string
) {
  const rows = await context.database.execute<Row>(
    sql`SELECT m.connection_id,m.content_json FROM build_channel_message m WHERE m.project_id=${context.projectId} AND m.id=${messageId} AND m.direction='inbound'`
  )
  const row = rows.rows[0]
  if (!row) throw invalid("Media message was not found.")
  const { channel, accountId } = await zernioAccount(
    context,
    String(row.connection_id)
  )
  if (channel.status !== "connected")
    throw invalid("The WhatsApp connection is unavailable.")
  const content = zernioObject(row.content_json)
  const attachment = Array.isArray(content.attachments)
    ? zernioObject(content.attachments[0])
    : {}
  const mediaId = id(attachment.fileId),
    type = attachment.type
  if (!mediaId || !["image", "audio"].includes(String(type)))
    throw invalid("Media is not supported.")
  const key = process.env.DATOOL_ZERNIO_API_KEY
  if (!key) throw invalid("WhatsApp is not configured.")
  const response = await fetch(
    `https://zernio.com/api/v1/whatsapp/media/${path(mediaId)}?${new URLSearchParams({ accountId })}`,
    {
      headers: { Authorization: `Bearer ${key}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    }
  )
  if (!response.ok || !response.body) throw invalid("Media is unavailable.")
  const max = type === "image" ? 5_000_000 : 16_000_000
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) throw invalid("Media exceeds the supported size.")
      chunks.push(value)
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
  if (!size) throw invalid("Media is empty.")
  return {
    bytes: Buffer.concat(chunks),
    mime: response.headers.get("content-type") ?? "",
    type: type as "image" | "audio",
  }
}
