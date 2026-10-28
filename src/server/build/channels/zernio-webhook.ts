import { sql } from "drizzle-orm"
import type {
  InboundEnvelope,
  NormalizedAttachment,
} from "@/src/lib/build/channels"
import type { BuildContext } from "../context"
import {
  enqueueInboundEnvelope,
  findOrCreateContact,
  recordExternalChannelMessage,
} from "./service"
import { recordWhatsAppReceipt } from "./whatsapp-webhook"
import { zernioObject } from "./zernio-api"

type Row = Record<string, unknown>
const safeId = (v: unknown) =>
  typeof v === "string" && v.length > 0 && v.length <= 500 ? v : null

export async function ingestZernioWebhook(
  context: BuildContext,
  connectionId: string,
  payload: unknown
) {
  const event = zernioObject(payload),
    message = zernioObject(event.message),
    account = zernioObject(event.account),
    conversation = zernioObject(event.conversation)
  const accountId = safeId(account.accountId ?? account.id),
    eventId = safeId(event.id),
    providerMessageId = safeId(message.platformMessageId)
  if (!eventId || !accountId || account.platform !== "whatsapp")
    return { ignored: true }
  const result = await context.database.execute<Row>(
    sql`SELECT b.*,c.status FROM build_zernio_whatsapp b JOIN build_channel_connection c ON c.id=b.connection_id AND c.project_id=b.project_id WHERE b.project_id=${context.projectId} AND b.connection_id=${connectionId}::uuid AND b.account_id=${accountId} AND c.config_json->>'provider'='zernio'`
  )
  const binding = result.rows[0]
  if (
    !binding ||
    (account.profileId && account.profileId !== binding.profile_id)
  )
    return { ignored: true }
  if (event.event === "account.disconnected") {
    await context.database.execute(
      sql`UPDATE build_channel_connection SET status='error',last_error='WhatsApp disconnected. Reconnect this number.' WHERE project_id=${context.projectId} AND id=${connectionId}::uuid AND status IN ('connected','paused')`
    )
    return { accepted: true }
  }
  if (!["connected", "paused"].includes(String(binding.status)))
    return { ignored: true }
  const kind = String(event.event)
  if (
    [
      "message.delivered",
      "message.read",
      "message.failed",
      "message.sent",
    ].includes(kind) &&
    providerMessageId &&
    message.direction === "outgoing"
  ) {
    await recordWhatsAppReceipt(context, connectionId, {
      id: providerMessageId,
      status: kind.slice(8),
      timestamp: String(
        Math.floor(Date.parse(String(event.statusAt ?? event.timestamp)) / 1000)
      ),
      errors: [zernioObject(event.error)],
    })
  }
  if (
    kind !== "message.received" &&
    !(kind === "message.sent" && event.source === "whatsapp_business_app")
  )
    return { ignored: true }
  if (!providerMessageId || message.platform !== "whatsapp")
    return { ignored: true }
  const isInbound = kind === "message.received"
  if (
    (isInbound && message.direction !== "incoming") ||
    (!isInbound && message.direction !== "outgoing")
  )
    return { ignored: true }
  const providerConversationId = safeId(
    conversation.id ?? message.conversationId
  )
  if (
    !providerConversationId ||
    (message.conversationId &&
      message.conversationId !== providerConversationId)
  )
    return { ignored: true }
  const sender = zernioObject(message.sender)
  const rawRecipient = safeId(
    isInbound
      ? (sender.phoneNumber ?? sender.id ?? conversation.participantId)
      : (conversation.participantId ?? conversation.participantUsername)
  )
  if (!rawRecipient) return { ignored: true }
  const recipient = /^\+?[1-9]\d{6,19}$/.test(rawRecipient)
    ? rawRecipient.replace(/^\+/, "")
    : rawRecipient
  const occurred = new Date(String(message.sentAt ?? event.timestamp))
  if (
    !Number.isFinite(occurred.getTime()) ||
    occurred.getTime() > Date.now() + 60_000
  )
    return { ignored: true }
  const attachments: NormalizedAttachment[] = []
  if (Array.isArray(message.attachments))
    for (const raw of message.attachments.slice(0, 10)) {
      const a = zernioObject(raw),
        meta = zernioObject(a.payload),
        mediaId = safeId(meta.id)
      if (
        !mediaId ||
        !["image", "audio", "video", "file"].includes(String(a.type))
      )
        continue
      attachments.push({
        type:
          a.type === "file"
            ? "document"
            : (a.type as "image" | "audio" | "video"),
        fileId: mediaId,
        ...(typeof a.mimeType === "string"
          ? { mimeType: a.mimeType.slice(0, 100) }
          : {}),
      })
    }
  const phone = /^\+?[1-9]\d{6,19}$/.test(recipient)
    ? recipient.replace(/^\+/, "")
    : null
  const ownPhone = String(binding.display_phone_number ?? "").replace(/\D/g, "")
  const externalContactId =
    phone && /^[1-9]\d{6,19}$/.test(ownPhone)
      ? `${ownPhone}:${phone}`
      : `zernio:${accountId}:${recipient}`
  const envelope: InboundEnvelope = {
    connectionId,
    channel: "whatsapp",
    providerEventId: providerMessageId,
    providerMessageId,
    externalConversationId: `${accountId}:${providerConversationId}`,
    externalContactId,
    receivedAt: occurred.toISOString(),
    text:
      typeof message.text === "string" ? message.text.slice(0, 100_000) : "",
    attachments,
    contact: {
      externalId: externalContactId,
      ...(phone ? { phone: `+${phone}` } : {}),
      displayName: String(
        isInbound ? (sender.name ?? "") : (conversation.participantName ?? "")
      ).slice(0, 200),
    },
    metadata: {
      zernio: { recipient, accountId, conversationId: providerConversationId },
    },
  }
  if (!isInbound) {
    await recordExternalChannelMessage(context, envelope, {
      direction: "outbound",
      takeover: true,
    })
    return { accepted: true }
  }
  const optOut = /^(stop|unsubscribe|cancelar|parar|sair)$/i.test(
    envelope.text.trim()
  )
  await context.database.execute(
    sql`INSERT INTO build_whatsapp_recipient(project_id,connection_id,recipient_id,last_customer_message_at,opted_out) VALUES(${context.projectId},${connectionId}::uuid,${recipient},${envelope.receivedAt}::timestamptz,${optOut}) ON CONFLICT(project_id,connection_id,recipient_id) DO UPDATE SET last_customer_message_at=GREATEST(build_whatsapp_recipient.last_customer_message_at,EXCLUDED.last_customer_message_at),opted_out=build_whatsapp_recipient.opted_out OR EXCLUDED.opted_out,updated_at=now()`
  )
  const contactId = await findOrCreateContact(context, envelope)
  const blocked = await context.database.execute(
    sql`SELECT 1 FROM build_contacts WHERE project_id=${context.projectId} AND id=${contactId} AND status IN ('blocked','archived')`
  )
  const consent = await context.database.execute<Row>(
    sql`SELECT opted_out FROM build_whatsapp_recipient WHERE project_id=${context.projectId} AND connection_id=${connectionId}::uuid AND recipient_id=${recipient}`
  )
  if (
    binding.status === "paused" ||
    blocked.rows.length ||
    consent.rows[0]?.opted_out ||
    zernioObject(event.metadata).standby === true ||
    Date.now() - occurred.getTime() >= 86_400_000
  )
    await recordExternalChannelMessage(context, envelope, {
      direction: "inbound",
    })
  else await enqueueInboundEnvelope(context, envelope)
  return { accepted: true }
}
