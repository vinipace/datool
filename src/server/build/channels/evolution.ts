import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { sql } from "drizzle-orm"
import { TracerError } from "@/src/server/tracer/errors"
import { scopedTracerTransaction } from "@/src/server/tracer/db"
import {
  EVOLUTION_ACCEPTANCE_VERSION,
  type EvolutionConnection,
  type EvolutionPairing,
} from "@/src/lib/build/evolution"
import type {
  InboundEnvelope,
  OutboundEnvelope,
} from "@/src/lib/build/channels"
import type { BuildContext } from "../context"
import { decryptChannelCredentials, encryptChannelCredentials } from "./secrets"
import { WhatsAppApiError } from "./whatsapp-api"
import {
  evolutionEnabled,
  evolutionMessage,
  evolutionObject,
  evolutionPhone,
  evolutionRequest,
} from "./evolution-api"
import { enqueueInboundEnvelope, recordExternalChannelMessage } from "./service"

type Row = Record<string, unknown>
const invalid = (message: string) =>
  new TracerError("VALIDATION_ERROR", message)
function enabled(context: BuildContext) {
  if (!evolutionEnabled(context.projectId))
    throw new WhatsAppApiError(
      "WHATSAPP_DISCONNECTED",
      "Evolution is not enabled for this project."
    )
}
async function channel(context: BuildContext, id: string) {
  const result = await context.database.execute<Row>(
    sql`SELECT * FROM build_channel_connection WHERE project_id=${context.projectId} AND id=${id}::uuid AND channel='whatsapp' AND config_json->>'provider'='evolution'`
  )
  if (!result.rows[0])
    throw new TracerError("NOT_FOUND", "Evolution connection was not found.")
  return result.rows[0]
}
async function binding(context: BuildContext, id: string) {
  const result = await context.database.execute<Row>(
    sql`SELECT * FROM build_evolution_instance WHERE project_id=${context.projectId} AND connection_id=${id}::uuid`
  )
  return result.rows[0]
}
async function locked<T>(
  context: BuildContext,
  id: string,
  action: (ctx: BuildContext) => Promise<T>
) {
  return context.database
    .transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM build_channel_connection WHERE project_id=${context.projectId} AND id=${id}::uuid FOR UPDATE`
      )
      return action({
        ...context,
        database: scopedTracerTransaction(context.database, tx),
      })
    })
    .catch((error) => {
      let cause: unknown = error
      for (
        let depth = 0;
        depth < 5 && cause && typeof cause === "object";
        depth++
      ) {
        if ("code" in cause && cause.code === "23505")
          throw invalid(
            "This number is already connected to Datool. Disconnect its existing connection first."
          )
        cause = "cause" in cause ? cause.cause : null
      }
      throw error
    })
}
function credentials(row: Row, context: BuildContext) {
  return decryptChannelCredentials(
    String(row.encrypted_credentials),
    context.projectId,
    String(row.id)
  ) as { token: string; webhook: string }
}
const iso = (value: unknown) =>
  value == null ? null : new Date(String(value)).toISOString()
export async function getEvolutionConnection(
  context: BuildContext,
  id: string
): Promise<EvolutionConnection> {
  const c = await channel(context, id),
    b = await binding(context, id)
  return {
    enabled: evolutionEnabled(context.projectId),
    connectionId: id,
    status: String(c.status),
    state: String(b?.state ?? "not_connected"),
    phone: b?.phone ? String(b.phone) : null,
    checkedAt: iso(b?.checked_at),
    cleanupPending: b?.desired_state === "disconnected",
  }
}
async function remoteInstance(b: Row, token?: string) {
  const list = await evolutionRequest<Row[]>(
    `/instance/fetchInstances?instanceName=${encodeURIComponent(String(b.instance_name))}`,
    { token }
  )
  return Array.isArray(list)
    ? list.find((x) => x.name === b.instance_name)
    : undefined
}
async function refresh(context: BuildContext, id: string) {
  const c = await channel(context, id),
    b = await binding(context, id)
  if (!b || b.desired_state === "disconnected") return
  const remote = await remoteInstance(b, credentials(c, context).token)
  const state =
    remote?.connectionStatus === "open"
      ? "open"
      : remote?.connectionStatus === "connecting"
        ? "connecting"
        : "close"
  const phone = evolutionPhone(remote?.ownerJid)
  if (state === "open" && !phone)
    throw invalid("Evolution did not confirm this number's identity.")
  if (b.phone && phone && b.phone !== phone)
    throw invalid(
      "This session changed numbers. Disconnect it before connecting another number."
    )
  // Shared unique number binding also protects concurrent Meta activation.
  await context.database.execute(
    sql`UPDATE build_evolution_instance SET state=${state},phone=COALESCE(${phone},phone),checked_at=now() WHERE connection_id=${id}::uuid AND project_id=${context.projectId}`
  )
  await context.database.execute(
    sql`UPDATE build_channel_connection SET status=${b.desired_state === "paused" ? "paused" : state === "open" ? "connected" : "disconnected"},last_error=NULL WHERE project_id=${context.projectId} AND id=${id}::uuid`
  )
}
export async function refreshEvolutionConnection(
  context: BuildContext,
  id: string
) {
  enabled(context)
  await locked(context, id, (ctx) => refresh(ctx, id))
  return getEvolutionConnection(context, id)
}
export async function beginEvolutionConnection(
  context: BuildContext,
  input: { connectionId: string; acceptanceVersion: string }
): Promise<EvolutionPairing> {
  enabled(context)
  if (
    input.acceptanceVersion !== EVOLUTION_ACCEPTANCE_VERSION ||
    !context.actorId
  )
    throw invalid(
      "Accept the current unofficial connection notice before pairing."
    )
  const id = input.connectionId
  // Commit credentials before external work so retries use the same instance and token.
  await context.database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('datool-evolution-provision'))`
    )
    const ctx = {
      ...context,
      database: scopedTracerTransaction(context.database, tx),
    }
    await channel(ctx, id)
    if (await binding(ctx, id)) return
    const count = await tx.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM build_evolution_instance`
    )
    const limit = Math.max(
      1,
      Math.min(
        100,
        Number(process.env.DATOOL_EVOLUTION_MAX_INSTANCES ?? 3) || 3
      )
    )
    if (Number(count.rows[0].count) >= limit)
      throw invalid("The Evolution pilot has reached its connection limit.")
    const secret = {
      token: randomBytes(32).toString("hex"),
      webhook: randomBytes(32).toString("hex"),
    }
    await tx.execute(
      sql`INSERT INTO build_evolution_instance(connection_id,project_id,instance_name,accepted_by,accepted_version) VALUES(${id}::uuid,${context.projectId},${`dt-${randomUUID()}`},${context.actorId!},${input.acceptanceVersion})`
    )
    await tx.execute(
      sql`UPDATE build_channel_connection SET encrypted_credentials=${encryptChannelCredentials(secret, context.projectId, id)},credentials_version='v1',status='draft' WHERE project_id=${context.projectId} AND id=${id}::uuid`
    )
  })
  return getEvolutionPairing(context, id)
}
export async function getEvolutionPairing(
  context: BuildContext,
  id: string
): Promise<EvolutionPairing> {
  enabled(context)
  const qr = await locked(context, id, async (ctx) => {
    const c = await channel(ctx, id),
      b = await binding(ctx, id)
    if (!b || b.desired_state === "disconnected")
      throw invalid("Finish disconnecting this session before pairing again.")
    const secret = credentials(c, ctx)
    const origin = new URL(process.env.DATOOL_PUBLIC_URL ?? "")
    if (origin.protocol !== "https:")
      throw invalid("Evolution webhooks require a configured HTTPS Datool URL.")
    const webhook = {
      enabled: true,
      url: `${origin.origin}/api/build-webhooks/evolution/${id}`,
      headers: { "x-datool-evolution-secret": secret.webhook },
      webhookByEvents: false,
      webhookBase64: false,
      events: [
        "CONNECTION_UPDATE",
        "MESSAGES_UPSERT",
        "MESSAGES_UPDATE",
        "SEND_MESSAGE",
      ],
    }
    try {
      if (!(await remoteInstance(b)))
        throw new WhatsAppApiError("EVOLUTION_NOT_FOUND", "Session not found.")
    } catch (error) {
      if (
        !(error instanceof WhatsAppApiError) ||
        error.code !== "EVOLUTION_NOT_FOUND"
      )
        throw error
      await evolutionRequest("/instance/create", {
        method: "POST",
        body: {
          instanceName: b.instance_name,
          integration: "WHATSAPP-BAILEYS",
          token: secret.token,
          qrcode: false,
          groupsIgnore: true,
          readMessages: false,
          readStatus: false,
          syncFullHistory: false,
          webhook,
        },
      })
    }
    await evolutionRequest(`/webhook/set/${b.instance_name}`, {
      method: "POST",
      token: secret.token,
      body: { webhook },
    })
    await refresh(ctx, id)
    const current = await binding(ctx, id)
    if (current?.state === "open") return null
    const result = await evolutionRequest(
      `/instance/connect/${b.instance_name}`,
      { token: secret.token }
    )
    const qr =
      typeof result.base64 === "string" &&
      /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(result.base64) &&
      result.base64.length < 250_000
        ? result.base64
        : null
    if (qr)
      await ctx.database.execute(
        sql`UPDATE build_evolution_instance SET state='connecting',checked_at=now() WHERE project_id=${ctx.projectId} AND connection_id=${id}::uuid`
      )
    return qr
  })
  return {
    ...(await getEvolutionConnection(context, id)),
    qr,
    expiresAt: qr ? new Date(Date.now() + 30_000).toISOString() : null,
  }
}
export async function disconnectEvolution(context: BuildContext, id: string) {
  // Local revocation commits before external cleanup, even if Evolution is down.
  await locked(context, id, async (ctx) => {
    await channel(ctx, id)
    await ctx.database.execute(
      sql`UPDATE build_evolution_instance SET desired_state='disconnected',state='cleanup_pending' WHERE project_id=${ctx.projectId} AND connection_id=${id}::uuid`
    )
    await ctx.database.execute(
      sql`UPDATE build_channel_connection SET status='disconnected' WHERE project_id=${ctx.projectId} AND id=${id}::uuid`
    )
    await ctx.database.execute(
      sql`UPDATE build_channel_job SET status='failed',last_error='Evolution disconnected.' WHERE project_id=${ctx.projectId} AND connection_id=${id}::uuid AND status='queued'`
    )
  })
  await locked(context, id, async (ctx) => {
    const c = await channel(ctx, id),
      b = await binding(ctx, id)
    if (!b) return
    const token = credentials(c, ctx).token
    let exists = true
    try {
      exists = !!(await remoteInstance(b))
    } catch (error) {
      if (
        error instanceof WhatsAppApiError &&
        error.code === "EVOLUTION_NOT_FOUND"
      )
        exists = false
      else throw error
    }
    for (const endpoint of ["logout", "delete"]) {
      if (!exists) break
      try {
        const result = await evolutionRequest(
          `/instance/${endpoint}/${b.instance_name}`,
          { method: "DELETE", token }
        )
        if (result.error || result.status === "ERROR")
          throw new WhatsAppApiError(
            "WHATSAPP_REJECTED",
            "Evolution did not confirm session removal."
          )
      } catch (error) {
        if (
          !(error instanceof WhatsAppApiError) ||
          error.code !== "EVOLUTION_NOT_FOUND"
        ) {
          // Deleting an already closed instance is still required when logout returns 400.
          if (
            endpoint !== "logout" ||
            !(error instanceof WhatsAppApiError) ||
            error.code !== "WHATSAPP_REJECTED"
          )
            throw error
        }
      }
    }
    await ctx.database.execute(
      sql`DELETE FROM build_evolution_instance WHERE project_id=${ctx.projectId} AND connection_id=${id}::uuid`
    )
    await ctx.database.execute(
      sql`UPDATE build_channel_connection SET encrypted_credentials=NULL,credentials_version=NULL WHERE project_id=${ctx.projectId} AND id=${id}::uuid`
    )
  })
  return getEvolutionConnection(context, id)
}
export async function setEvolutionStatus(
  context: BuildContext,
  id: string,
  status: string
) {
  if (status === "disconnected") return disconnectEvolution(context, id)
  if (!["connected", "paused"].includes(status))
    throw invalid("Evolution status is managed by its connection.")
  enabled(context)
  await locked(context, id, async (ctx) => {
    await refresh(ctx, id)
    const b = await binding(ctx, id)
    if (!b || b.desired_state === "disconnected" || b.state !== "open")
      throw invalid("Reconnect WhatsApp before changing its status.")
    await ctx.database.execute(
      sql`UPDATE build_evolution_instance SET desired_state=${status === "paused" ? "paused" : "active"} WHERE project_id=${ctx.projectId} AND connection_id=${id}::uuid`
    )
    await ctx.database.execute(
      sql`UPDATE build_channel_connection SET status=${status} WHERE project_id=${ctx.projectId} AND id=${id}::uuid`
    )
  })
  return getEvolutionConnection(context, id)
}
export async function assertEvolutionOutbound(
  context: BuildContext,
  envelope: OutboundEnvelope,
  externalId: string
) {
  enabled(context)
  const c = await channel(context, envelope.connectionId),
    b = await binding(context, envelope.connectionId)
  if (
    !b ||
    b.desired_state !== "active" ||
    b.state !== "open" ||
    c.status !== "connected"
  )
    throw new WhatsAppApiError(
      "WHATSAPP_DISCONNECTED",
      "Reconnect or resume this Evolution connection."
    )
  const recipient = externalId.slice(String(b.phone).length + 1)
  if (
    !b.phone ||
    externalId !== `${b.phone}:${recipient}` ||
    !/^[1-9][0-9]{6,19}$/.test(recipient) ||
    !envelope.text.trim() ||
    envelope.text.length > 16000 ||
    envelope.attachments?.length ||
    envelope.metadata?.whatsappTemplate ||
    envelope.metadata?.campaignId
  )
    throw new WhatsAppApiError(
      "WHATSAPP_INVALID_MESSAGE",
      "Evolution supports individual text replies only."
    )
  const allowed = await context.database.execute(
    sql`SELECT 1 FROM build_whatsapp_recipient r JOIN build_conversations v ON v.project_id=r.project_id AND v.id=${envelope.conversationId} LEFT JOIN build_contacts p ON p.project_id=v.project_id AND p.id=v.metadata_json->>'contactId' WHERE r.project_id=${context.projectId} AND r.connection_id=${envelope.connectionId}::uuid AND r.recipient_id=${recipient} AND NOT r.opted_out AND r.last_customer_message_at>now()-interval '24 hours' AND v.status<>'closed' AND v.metadata_json->>'connectionId'=${envelope.connectionId} AND v.external_conversation_id=${externalId} AND COALESCE(p.status,'active') NOT IN ('blocked','archived')`
  )
  if (!allowed.rows.length)
    throw new WhatsAppApiError(
      "WHATSAPP_WINDOW_CLOSED",
      "Evolution only replies to open conversations started by a customer in the last 24 hours."
    )
  return { c, b, recipient }
}
export async function sendEvolutionEnvelope(
  context: BuildContext,
  envelope: OutboundEnvelope,
  externalId: string,
  messageId: string
) {
  let accepted = false
  return locked(context, envelope.connectionId, async (ctx) => {
    const { c, b, recipient } = await assertEvolutionOutbound(
      ctx,
      envelope,
      externalId
    )
    const owner = await ctx.database.execute<Row>(
      sql`SELECT m.content_json,m.provider_message_id,m.status,v.owner_fence,v.owner_type FROM build_channel_message m JOIN build_conversations v ON v.project_id=m.project_id AND v.id=m.conversation_id WHERE m.project_id=${ctx.projectId} AND m.id=${messageId} AND m.connection_id=${envelope.connectionId}::uuid AND m.conversation_id=${envelope.conversationId} AND m.direction='outbound' FOR UPDATE OF v`
    )
    const row = owner.rows[0],
      content = evolutionObject(row?.content_json)
    if (!row)
      throw new TracerError("NOT_FOUND", "Outbound message was not found.")
    if (
      row.provider_message_id &&
      ["sent", "delivered"].includes(String(row.status))
    )
      return [String(row.provider_message_id)]
    if (row.provider_message_id && row.status === "failed")
      throw new WhatsAppApiError(
        "WHATSAPP_REJECTED",
        "WhatsApp rejected this reply. Resolve the delivery error before sending a new message."
      )
    if (
      content.expectedOwnerFence !== undefined &&
      (Number(content.expectedOwnerFence) !== Number(row.owner_fence) ||
        content.expectedOwnerType !== row.owner_type)
    )
      throw new WhatsAppApiError(
        "WHATSAPP_REJECTED",
        "Conversation ownership changed before delivery."
      )
    if (
      b.last_send_at &&
      Date.now() - new Date(String(b.last_send_at)).getTime() < 1000
    )
      throw new WhatsAppApiError(
        "RATE_LIMITED",
        "Wait before the next reply.",
        false,
        2
      )
    // Only a received message on this conversation and provider instance may
    // supply an alternate address. Outbound caller metadata is not routing authority.
    const address = await ctx.database.execute<Row>(sql`
      SELECT id, provider_message_id,
        content_json->'metadata'->'evolution'->>'replyJid' AS reply_jid,
        content_json->'metadata'->'evolution'->>'addressingMode' AS addressing_mode,
        content_json->'metadata'->'evolution'->>'observedAt' AS observed_at
      FROM build_channel_message
      WHERE project_id=${ctx.projectId} AND connection_id=${envelope.connectionId}::uuid
        AND conversation_id=${envelope.conversationId} AND direction='inbound'
        AND content_json->'metadata'->'evolution'->>'instance'=${b.instance_name}
      ORDER BY content_json->'metadata'->'evolution'->>'observedAt' DESC NULLS LAST, created_at DESC
      LIMIT 1
    `)
    const source = address.rows[0]
    let replyJid =
      typeof source?.reply_jid === "string" &&
      /^[0-9]{5,20}@lid$/.test(source.reply_jid)
        ? source.reply_jid
        : null
    // Evolution 2.3.7 saves the original key, then overwrites remoteJid with
    // remoteJidAlt in its webhook. Recover only this inbound message, using the
    // instance credential, and verify its phone, direction, ID and timestamp.
    // Pre-fix inbound rows have no addressingMode and need the same lookup.
    if (source && !replyJid && source.addressing_mode !== "pn") {
      const lookup = await evolutionRequest(
        `/chat/findMessages/${b.instance_name}`,
        {
          token: credentials(c, ctx).token,
          method: "POST",
          body: {
            where: { key: { id: source.provider_message_id } },
            offset: 2,
            page: 1,
          },
        }
      )
      const found = evolutionObject(lookup.messages)
      const records = Array.isArray(found.records) ? found.records : []
      const original =
        records.length === 1 ? evolutionMessage(records[0]) : null
      if (
        found.total !== 1 ||
        !original ||
        original.fromMe ||
        original.id !== source.provider_message_id ||
        original.phone !== recipient ||
        original.receivedAt !== source.observed_at ||
        ((source.addressing_mode === "lid" ||
          original.addressingMode === "lid") &&
          !original.replyJid)
      )
        throw new WhatsAppApiError(
          "INVALID_PROVIDER_RESPONSE",
          "Evolution could not verify the reply address for this incoming message."
        )
      replyJid = original.replyJid
      if (replyJid)
        await ctx.database.execute(sql`
          UPDATE build_channel_message
          SET content_json=jsonb_set(content_json,'{metadata,evolution,replyJid}',${JSON.stringify(replyJid)}::jsonb)
          WHERE project_id=${ctx.projectId} AND id=${source.id}
        `)
    }
    const result = await evolutionRequest(
      `/message/sendText/${b.instance_name}`,
      {
        token: credentials(c, ctx).token,
        method: "POST",
        sending: true,
        body: {
          number: replyJid ?? recipient,
          text: envelope.text,
          linkPreview: false,
        },
      }
    )
    accepted = true
    const key = evolutionObject(result.key)
    if (typeof key.id !== "string")
      throw new WhatsAppApiError(
        "INVALID_PROVIDER_RESPONSE",
        "Evolution did not confirm the message identifier.",
        true
      )
    // Persist provider ID while holding the same connection lock used by webhooks.
    // A network success followed by DB failure must remain uncertain, never retry blindly.
    try {
      await ctx.database.execute(
        sql`UPDATE build_channel_message SET provider_message_id=${key.id},status='sent' WHERE project_id=${ctx.projectId} AND id=${messageId}`
      )
      await ctx.database.execute(
        sql`UPDATE build_evolution_instance SET last_send_at=now() WHERE project_id=${ctx.projectId} AND connection_id=${envelope.connectionId}::uuid`
      )
    } catch {
      throw new WhatsAppApiError(
        "INVALID_PROVIDER_RESPONSE",
        "Evolution accepted the reply but its receipt could not be saved.",
        true
      )
    }
    return [key.id]
  }).catch((error) => {
    if (accepted && !(error instanceof WhatsAppApiError && error.uncertain))
      throw new WhatsAppApiError(
        "INVALID_PROVIDER_RESPONSE",
        "The reply outcome could not be committed.",
        true
      )
    throw error
  })
}
export async function ingestEvolutionWebhook(
  context: BuildContext,
  id: string,
  supplied: string | null,
  payload: unknown
) {
  return locked(context, id, async (ctx) => {
    let c = await channel(ctx, id),
      b = await binding(ctx, id)
    if (!b || b.desired_state === "disconnected" || !c.encrypted_credentials)
      throw new TracerError("UNAUTHORIZED", "Webhook authentication failed.")
    const secret = credentials(c, ctx).webhook
    if (
      !supplied ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(secret) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))
    )
      throw new TracerError("UNAUTHORIZED", "Webhook authentication failed.")
    const event = evolutionObject(payload)
    if (event.instance !== b.instance_name)
      throw invalid("Webhook instance does not match this connection.")
    const kind = String(event.event).toUpperCase().replaceAll(".", "_")
    // Re-read provider state instead of allowing stale events to reactivate a session.
    if (kind === "CONNECTION_UPDATE") {
      await refresh(ctx, id)
      return { accepted: true }
    }
    if (kind === "MESSAGES_UPDATE") {
      const updates = Array.isArray(event.data)
        ? event.data.slice(0, 100)
        : [event.data]
      for (const value of updates) {
        const update = evolutionObject(value)
        const status = (
          {
            ERROR: "failed",
            SERVER_ACK: "sent",
            DELIVERY_ACK: "delivered",
            READ: "read",
            PLAYED: "read",
          } as Record<string, string>
        )[String(update.status)]
        if (
          !status ||
          typeof update.keyId !== "string" ||
          update.fromMe !== true
        )
          continue
        await ctx.database.execute(
          sql`UPDATE build_channel_message
          SET status=CASE WHEN ${status}='failed' THEN 'failed' WHEN ${status} IN ('delivered','read') THEN 'delivered' ELSE status END,
            error_code=CASE WHEN ${status}='failed' THEN 'WHATSAPP_DELIVERY_FAILED' ELSE NULL END,
            error_message=CASE WHEN ${status}='failed' THEN 'WhatsApp rejected this reply.' ELSE NULL END,
            content_json=jsonb_set(content_json,'{whatsappDelivery}',${JSON.stringify({ status })}::jsonb)
          WHERE project_id=${ctx.projectId} AND connection_id=${id}::uuid
            AND direction='outbound' AND provider_message_id=${update.keyId}
            AND (
              (${status}='failed' AND status<>'delivered') OR
              (${status}<>'failed' AND NOT (${status}='sent' AND status='failed') AND
                (CASE content_json->'whatsappDelivery'->>'status' WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END)
                  <${status === "read" ? 3 : status === "delivered" ? 2 : 1})
            )`
        )
      }
      return { accepted: true }
    }
    if (kind !== "MESSAGES_UPSERT") return { ignored: true }
    // A message can reach us before the provider's asynchronous connection event.
    if (b.state !== "open") {
      await refresh(ctx, id)
      c = await channel(ctx, id)
      b = await binding(ctx, id)
      if (!b) return { ignored: true }
    }
    if (
      b.state !== "open" ||
      !b.phone ||
      !["connected", "paused"].includes(String(c.status))
    )
      return { ignored: true }
    const msg = evolutionMessage(event.data)
    if (
      !msg ||
      new Date(msg.receivedAt).getTime() <
        Math.floor(new Date(String(b.started_at)).getTime() / 1000) * 1000
    )
      return { ignored: true }
    const identity = `${b.phone}:${msg.phone}`
    const envelope: InboundEnvelope = {
      connectionId: id,
      channel: "whatsapp",
      providerEventId: msg.id,
      providerMessageId: msg.id,
      externalConversationId: identity,
      externalContactId: identity,
      receivedAt: msg.receivedAt,
      text: msg.text,
      attachments: [],
      contact: { externalId: identity, displayName: msg.name },
      metadata: {
        provider: "evolution",
        evolution: {
          instance: b.instance_name,
          replyJid: msg.replyJid,
          addressingMode: msg.addressingMode,
          observedAt: msg.receivedAt,
        },
      },
    }
    if (msg.fromMe) {
      const existing = await ctx.database.execute(
        sql`SELECT 1 FROM build_channel_message WHERE project_id=${ctx.projectId} AND connection_id=${id}::uuid AND provider_message_id=${msg.id}`
      )
      if (existing.rows.length) return { deduplicated: true }
      // Unknown outgoing messages transfer ownership, including uncertain echoes:
      // conservative takeover is preferable to an accidental duplicate AI reply.
      return recordExternalChannelMessage(ctx, envelope, {
        direction: "outbound",
        takeover: true,
      })
    }
    const optedOut = /^(stop|unsubscribe|cancelar|parar|sair)$/i.test(
      msg.text.trim()
    )
    await ctx.database.execute(
      sql`INSERT INTO build_whatsapp_recipient(project_id,connection_id,recipient_id,last_customer_message_at,opted_out) VALUES(${ctx.projectId},${id}::uuid,${msg.phone},${msg.receivedAt}::timestamptz,${optedOut}) ON CONFLICT(project_id,connection_id,recipient_id) DO UPDATE SET last_customer_message_at=GREATEST(build_whatsapp_recipient.last_customer_message_at,EXCLUDED.last_customer_message_at),opted_out=build_whatsapp_recipient.opted_out OR EXCLUDED.opted_out`
    )
    const blocked = await ctx.database.execute(
      sql`SELECT 1 FROM build_whatsapp_recipient WHERE project_id=${ctx.projectId} AND connection_id=${id}::uuid AND recipient_id=${msg.phone} AND opted_out`
    )
    if (
      !evolutionEnabled(ctx.projectId) ||
      b.desired_state === "paused" ||
      !msg.supported ||
      blocked.rows.length ||
      Date.now() - new Date(msg.receivedAt).getTime() >= 86400000
    )
      return recordExternalChannelMessage(ctx, envelope, {
        direction: "inbound",
      })
    return enqueueInboundEnvelope(ctx, envelope)
  })
}

/** Worker recovery also runs for revoked projects so cleanup is never gated off. */
export async function reconcileEvolutionConnection(
  context: BuildContext,
  id: string
) {
  const b = await binding(context, id)
  if (!b) return
  if (
    b.desired_state === "disconnected" ||
    (!b.phone &&
      Date.now() - new Date(String(b.started_at)).getTime() > 30 * 60_000)
  ) {
    await disconnectEvolution(context, id)
  } else if (evolutionEnabled(context.projectId)) {
    await refreshEvolutionConnection(context, id)
  }
}
