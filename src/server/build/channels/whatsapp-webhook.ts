import { sql } from "drizzle-orm"
import { z } from "zod"
import type { BuildContext } from "../context"
import {
  enqueueInboundEnvelope,
  recordExternalChannelMessage,
  findOrCreateContact,
} from "./service"
import { normalizeWhatsAppMessage } from "./whatsapp-api"
import { whatsappRecipientSchema } from "@/src/lib/build/whatsapp"

const object = z.record(z.string(), z.unknown())
export const whatsappWebhookSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z
    .array(
      z.object({
        id: z.string().max(100),
        changes: z
          .array(z.object({ field: z.string().max(100), value: object }))
          .max(100),
      })
    )
    .max(100),
})
type Row = Record<string, unknown>
function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {}
}
function list(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(record) : []
}
function eventTime(value: unknown) {
  const time = Number(value) * 1000
  return Number.isFinite(time) && time > 0 && time <= Date.now() + 60_000
    ? new Date(time).toISOString()
    : null
}

export async function recordWhatsAppReceipt(
  context: BuildContext,
  connectionId: string,
  value: Row
) {
  const status = String(value.status),
    ranks: Record<string, number> = {
      failed: 0,
      sent: 1,
      delivered: 2,
      read: 3,
    }
  if (
    !(status in ranks) ||
    typeof value.id !== "string" ||
    value.id.length > 500
  )
    return
  const occurredAt = eventTime(value.timestamp)
  if (!occurredAt) return
  const errorCode = list(value.errors)[0]?.code
  // Callback data is a correlation hint, never an authorization boundary.
  // Both lookup paths are bound to the signed account's connection and tenant.
  await context.database.transaction(async (tx) => {
    const message = await tx.execute<Row>(
      sql`SELECT id FROM build_channel_message WHERE project_id=${context.projectId} AND connection_id=${connectionId}::uuid AND direction='outbound' AND (provider_message_id=${value.id} OR id=${String(value.biz_opaque_callback_data ?? "")}) LIMIT 1 FOR UPDATE`
    )
    const messageId = message.rows[0]?.id ? String(message.rows[0].id) : null
    await tx.execute(
      sql`INSERT INTO build_whatsapp_receipt(project_id,connection_id,provider_message_id,message_id,status,status_rank,occurred_at,error_code) VALUES(${context.projectId},${connectionId}::uuid,${value.id},${messageId},${status},${ranks[status]},${occurredAt}::timestamptz,${errorCode == null ? null : String(errorCode).slice(0, 40)}) ON CONFLICT(connection_id,provider_message_id) DO UPDATE SET status=EXCLUDED.status,status_rank=EXCLUDED.status_rank,occurred_at=EXCLUDED.occurred_at,error_code=EXCLUDED.error_code,message_id=COALESCE(EXCLUDED.message_id,build_whatsapp_receipt.message_id) WHERE (EXCLUDED.status_rank>build_whatsapp_receipt.status_rank AND (build_whatsapp_receipt.status<>'failed' OR EXCLUDED.occurred_at>=build_whatsapp_receipt.occurred_at)) OR (EXCLUDED.status='failed' AND build_whatsapp_receipt.status='sent' AND EXCLUDED.occurred_at>=build_whatsapp_receipt.occurred_at)`
    )
    if (!messageId) return
    const latest = await tx.execute<Row>(
      sql`SELECT status,error_code,occurred_at FROM build_whatsapp_receipt WHERE connection_id=${connectionId}::uuid AND provider_message_id=${value.id}`
    )
    const current = String(latest.rows[0].status)
    await tx.execute(
      sql`UPDATE build_channel_message SET provider_message_id=${value.id},status=${current === "read" ? "delivered" : current},error_code=${current === "failed" ? `WHATSAPP_${latest.rows[0].error_code ?? "DELIVERY_FAILED"}` : null},error_message=${current === "failed" ? "WhatsApp reported a delivery failure." : null},content_json=jsonb_set(content_json,'{whatsappDelivery}',${JSON.stringify({ status: current, occurredAt: latest.rows[0].occurred_at })}::jsonb) WHERE project_id=${context.projectId} AND id=${messageId}`
    )
  })
}

/** Resolver is shared by the public ingress and isolated end-to-end harness.
 * It must resolve only a server-verified WABA/phone binding, never payload project IDs. */
export async function ingestWhatsAppWebhook(
  payload: unknown,
  resolve: (
    wabaId: string,
    phoneId: string | null
  ) => Promise<Array<{ context: BuildContext; connectionId: string }>>
) {
  const parsed = whatsappWebhookSchema.parse(payload)
  let accepted = 0
  for (const entry of parsed.entry)
    for (const change of entry.changes) {
      const value = change.value,
        phoneId = record(value.metadata).phone_number_id
      const targets = await resolve(
        entry.id,
        typeof phoneId === "string" ? phoneId : null
      )
      for (const { context, connectionId } of targets) {
        const binding = await context.database.execute<Row>(
          sql`SELECT a.*,c.status FROM build_whatsapp_account a JOIN build_channel_connection c ON c.id=a.connection_id AND c.project_id=a.project_id WHERE a.project_id=${context.projectId} AND a.connection_id=${connectionId}::uuid AND a.waba_id=${entry.id} ${typeof phoneId === "string" ? sql`AND a.phone_number_id=${phoneId}` : sql``}`
        )
        const account = binding.rows[0]
        if (!account) continue
        if (!account.activated_at) {
          const activating = await context.database.execute(
            sql`SELECT 1 FROM build_whatsapp_signup WHERE project_id=${context.projectId} AND connection_id=${connectionId}::uuid AND state='activating' AND expires_at>now()`
          )
          if (activating.rows.length)
            throw Object.assign(
              new Error("WhatsApp connection is activating."),
              { code: "WHATSAPP_ACTIVATING" }
            )
          continue
        }
        if (change.field === "account_update") {
          if (
            [
              "PARTNER_REMOVED",
              "ACCOUNT_DELETED",
              "DISABLED",
              "BANNED",
            ].includes(String(value.event))
          )
            await context.database.execute(
              sql`UPDATE build_channel_connection SET status='error',encrypted_credentials=NULL,last_error='Meta disconnected or restricted this account. Reconnect after resolving it in Meta.' WHERE project_id=${context.projectId} AND id=${connectionId}::uuid`
            )
          continue
        }
        if (
          typeof phoneId !== "string" ||
          !["connected", "paused"].includes(String(account.status))
        )
          continue
        for (const status of list(value.statuses))
          await recordWhatsAppReceipt(context, connectionId, status)
        if (change.field === "messages")
          for (const raw of list(value.messages)) {
            const profile = list(value.contacts).find(
              (c) => c.wa_id === raw.from
            )
            const envelope = normalizeWhatsAppMessage(
              connectionId,
              phoneId,
              raw,
              String(record(profile?.profile).name ?? "")
            )
            if (!envelope) continue
            const recipient = String(raw.from)
            const optOut = /^(stop|unsubscribe|cancelar|parar|sair)$/i.test(
              envelope.text.trim()
            )
            await context.database.execute(
              sql`INSERT INTO build_whatsapp_recipient(project_id,connection_id,recipient_id,last_customer_message_at,opted_out) VALUES(${context.projectId},${connectionId}::uuid,${recipient},${envelope.receivedAt}::timestamptz,${optOut}) ON CONFLICT(project_id,connection_id,recipient_id) DO UPDATE SET last_customer_message_at=GREATEST(build_whatsapp_recipient.last_customer_message_at,EXCLUDED.last_customer_message_at),opted_out=build_whatsapp_recipient.opted_out OR EXCLUDED.opted_out,updated_at=now()`
            )
            const consent = await context.database.execute<Row>(
              sql`SELECT opted_out FROM build_whatsapp_recipient WHERE project_id=${context.projectId} AND connection_id=${connectionId}::uuid AND recipient_id=${recipient}`
            )
            const contactId = await findOrCreateContact(context, envelope)
            const blocked = await context.database.execute(
              sql`SELECT 1 FROM build_contacts WHERE project_id=${context.projectId} AND id=${contactId} AND status IN ('blocked','archived')`
            )
            // Late deliveries should enter the inbox without executing an agent
            // whose eventual reply is already forbidden by the service window.
            if (
              account.status === "paused" ||
              blocked.rows.length > 0 ||
              consent.rows[0]?.opted_out ||
              Date.now() - new Date(envelope.receivedAt).getTime() >= 86_400_000
            )
              await recordExternalChannelMessage(context, envelope, {
                direction: "inbound",
              })
            else await enqueueInboundEnvelope(context, envelope)
            accepted++
          }
        if (account.mode !== "coexistence") continue
        if (change.field === "smb_message_echoes")
          for (const raw of list(value.message_echoes)) {
            const envelope = normalizeWhatsAppMessage(connectionId, phoneId, {
              ...raw,
              from: raw.to,
            })
            if (envelope) {
              await recordExternalChannelMessage(context, envelope, {
                direction: "outbound",
                takeover: true,
              })
              accepted++
            }
          }
        const sync = record(account.sync_json)
        if (change.field === "history" && sync.history) {
          for (const chunk of list(value.history)) {
            for (const thread of list(chunk.threads))
              for (const raw of list(thread.messages)) {
                const envelope = normalizeWhatsAppMessage(
                  connectionId,
                  phoneId,
                  { ...raw, from: thread.id }
                )
                if (envelope) {
                  await recordExternalChannelMessage(context, envelope, {
                    direction: raw.from === thread.id ? "inbound" : "outbound",
                    historical: true,
                  })
                  accepted++
                }
              }
            await context.database.execute(
              sql`UPDATE build_whatsapp_account SET sync_json=jsonb_set(sync_json,'{history}',${JSON.stringify({ status: list(chunk.errors).length ? "declined" : "receiving", progress: record(chunk.metadata).progress ?? null })}::jsonb) WHERE project_id=${context.projectId} AND connection_id=${connectionId}::uuid`
            )
          }
        }
        if (change.field === "smb_app_state_sync" && sync.smb_app_state_sync) {
          for (const item of list(value.state_sync)) {
            if (
              item.type !== "contact" ||
              ["remove", "delete"].includes(String(item.action))
            )
              continue
            const contact = record(item.contact),
              recipient = String(contact.phone_number ?? "").replace(/^\+/, "")
            if (!whatsappRecipientSchema.safeParse(recipient).success) continue
            const envelope = normalizeWhatsAppMessage(
              connectionId,
              phoneId,
              {
                from: recipient,
                id: `contact:${recipient}`,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: "text",
                text: { body: "" },
              },
              String(contact.full_name ?? contact.first_name ?? "")
            )
            if (envelope) await findOrCreateContact(context, envelope)
          }
          await context.database.execute(
            sql`UPDATE build_whatsapp_account SET sync_json=jsonb_set(sync_json,'{smb_app_state_sync}', '"receiving"'::jsonb) WHERE project_id=${context.projectId} AND connection_id=${connectionId}::uuid`
          )
        }
      }
    }
  return { accepted }
}
