import { canonicalJson } from "@/src/lib/tracer/resource-document"
import { createHash, randomInt, randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { TracerError } from "@/src/server/tracer/errors"
import type { BuildContext } from "../context"
import {
  metaIdSchema,
  whatsappModeSchema,
  whatsappRecipientSchema,
  whatsappTemplateSchema,
  type WhatsAppMode,
  type WhatsAppPhone,
  type WhatsAppSetup,
  type WhatsAppSignup,
  type WhatsAppTemplate,
} from "@/src/lib/build/whatsapp"
import type { OutboundEnvelope } from "@/src/lib/build/channels"
import { encryptChannelCredentials, decryptChannelCredentials } from "./secrets"
import {
  exchangeWhatsAppCode,
  metaConfig,
  metaRequest,
  WhatsAppApiError,
  whatsappMessage,
} from "./whatsapp-api"

type Row = Record<string, unknown>
const invalid = (message: string) =>
  new TracerError("VALIDATION_ERROR", message)
const iso = (value: unknown) =>
  new Date(value instanceof Date ? value : String(value)).toISOString()
export function getWhatsAppSetup(): WhatsAppSetup {
  const config = metaConfig()
  const required = {
    DATOOL_META_APP_ID: config.appId,
    DATOOL_META_APP_SECRET: config.appSecret,
    DATOOL_META_WHATSAPP_CONFIG_ID: config.configId,
    DATOOL_META_WEBHOOK_VERIFY_TOKEN: config.verifyToken,
    DATOOL_PUBLIC_URL: process.env.DATOOL_PUBLIC_URL,
  }
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name)
  let webhookUrl: string | null = null
  try {
    const base = new URL(process.env.DATOOL_PUBLIC_URL ?? "")
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      /^(localhost|127\.|\[::1\])/.test(base.hostname)
    )
      missing.push("DATOOL_PUBLIC_URL (public HTTPS required)")
    else webhookUrl = `${base.origin}/api/build-webhooks/whatsapp`
  } catch {
    if (!missing.includes("DATOOL_PUBLIC_URL"))
      missing.push("DATOOL_PUBLIC_URL (valid HTTPS URL required)")
  }
  for (const [name, value] of [
    ["DATOOL_META_APP_ID", config.appId],
    ["DATOOL_META_WHATSAPP_CONFIG_ID", config.configId],
  ])
    if (value && !metaIdSchema.safeParse(value).success)
      missing.push(`${name} (invalid ID)`)
  return {
    configured: missing.length === 0,
    missing,
    appId: config.appId || null,
    configId: config.configId || null,
    graphVersion: config.version,
    webhookUrl,
  }
}
async function connection(context: BuildContext, id: string) {
  const result = await context.database.execute<Row>(
    sql`SELECT c.*, p.slug AS project_slug FROM build_channel_connection c JOIN project p ON p.id=c.project_id WHERE c.project_id=${context.projectId} AND c.id=${id}::uuid AND c.channel='whatsapp'`
  )
  if (!result.rows[0])
    throw new TracerError("NOT_FOUND", "WhatsApp channel was not found.")
  return result.rows[0]
}
async function session(context: BuildContext, id: string) {
  const result = await context.database.execute<Row>(
    sql`SELECT * FROM build_whatsapp_signup WHERE id=${id}::uuid AND project_id=${context.projectId}`
  )
  if (!result.rows[0])
    throw new TracerError("NOT_FOUND", "WhatsApp signup was not found.")
  return result.rows[0]
}
export async function getWhatsAppSignup(
  context: BuildContext,
  id: string
): Promise<WhatsAppSignup> {
  const row = await session(context, id),
    channel = await connection(context, String(row.connection_id))
  return {
    id,
    connectionId: String(row.connection_id),
    mode: whatsappModeSchema.parse(row.mode),
    state:
      iso(row.expires_at) <= new Date().toISOString() &&
      row.state !== "complete"
        ? "expired"
        : String(row.state),
    expiresAt: iso(row.expires_at),
    phones: row.phones_json as WhatsAppPhone[],
    setup: getWhatsAppSetup(),
    connectUrl: `/p/${encodeURIComponent(String(channel.project_slug))}/build/integrations/${row.connection_id}?agentId=${encodeURIComponent(String(channel.agent_id))}&signup=${id}`,
  }
}
export async function beginWhatsAppSignup(
  context: BuildContext,
  input: { connectionId: string; mode: WhatsAppMode }
): Promise<WhatsAppSignup> {
  if (!getWhatsAppSetup().configured)
    throw invalid(
      "WhatsApp is not configured on this installation. Ask an administrator to complete the Meta setup."
    )
  await connection(context, input.connectionId)
  const id = randomUUID()
  await context.database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM build_channel_connection WHERE project_id=${context.projectId} AND id=${input.connectionId}::uuid FOR UPDATE`
    )
    const active = await tx.execute(
      sql`SELECT id FROM build_whatsapp_signup WHERE project_id=${context.projectId} AND connection_id=${input.connectionId}::uuid AND state IN ('authorizing','activating') AND expires_at>now()`
    )
    if (active.rows.length)
      throw invalid(
        "A Meta authorization is still in progress. Wait for it to finish before starting again."
      )
    await tx.execute(
      sql`UPDATE build_whatsapp_signup SET state='failed', encrypted_token=NULL WHERE project_id=${context.projectId} AND connection_id=${input.connectionId}::uuid AND state<>'complete'`
    )
    await tx.execute(
      sql`UPDATE build_whatsapp_signup SET encrypted_token=NULL WHERE project_id=${context.projectId} AND expires_at < now() AND encrypted_token IS NOT NULL`
    )
    await tx.execute(
      sql`INSERT INTO build_whatsapp_signup(id,project_id,connection_id,mode) VALUES(${id}::uuid,${context.projectId},${input.connectionId}::uuid,${input.mode})`
    )
  })
  return getWhatsAppSignup(context, id)
}
export async function authorizeWhatsAppSignup(
  context: BuildContext,
  input: { sessionId: string; code: string; wabaId?: string }
) {
  const claimed = await context.database.execute<Row>(
    sql`UPDATE build_whatsapp_signup SET state='authorizing' WHERE id=${input.sessionId}::uuid AND project_id=${context.projectId} AND state='pending' AND expires_at>now() RETURNING *`
  )
  if (!claimed.rows[0]) {
    const existing = await getWhatsAppSignup(context, input.sessionId)
    if (existing.state === "authorized" || existing.state === "complete")
      return existing
    throw invalid(
      "This signup has expired or was already used. Start a new connection attempt."
    )
  }
  const row = claimed.rows[0]
  try {
    const auth = await exchangeWhatsAppCode(input.code)
    const wabaId =
      input.wabaId ?? (auth.wabaIds.length === 1 ? auth.wabaIds[0] : undefined)
    if (!wabaId)
      throw invalid(
        "Meta did not identify one WhatsApp business account. Restart signup and select the account to connect."
      )
    metaIdSchema.parse(wabaId)
    if (auth.wabaIds.length && !auth.wabaIds.includes(wabaId))
      throw invalid(
        "This account was not granted to Datool during Meta signup."
      )
    const result = await metaRequest<{ data: WhatsAppPhone[] }>(
      auth.token,
      `${wabaId}/phone_numbers`,
      {
        query: {
          fields:
            "id,display_phone_number,verified_name,is_on_biz_app,platform_type,quality_rating",
          limit: "100",
        },
      }
    )
    const phones = (Array.isArray(result.data) ? result.data : []).filter(
      (phone) =>
        metaIdSchema.safeParse(phone.id).success &&
        (row.mode === "coexistence"
          ? phone.is_on_biz_app === true
          : phone.is_on_biz_app !== true)
    )
    if (!phones.length)
      throw invalid(
        row.mode === "coexistence"
          ? "Meta did not return an eligible WhatsApp Business App number. Complete the coexistence flow in Meta and try again."
          : "No phone numbers were authorized. Add and verify a business number in Meta."
      )
    const authorized = await context.database.execute(
      sql`UPDATE build_whatsapp_signup SET state='authorized',waba_id=${wabaId},phones_json=${JSON.stringify(phones)}::jsonb,encrypted_token=${encryptChannelCredentials({ token: auth.token }, context.projectId, String(row.connection_id))},token_expires_at=${auth.expiresAt}::timestamptz WHERE id=${input.sessionId}::uuid AND project_id=${context.projectId} AND state='authorizing' AND expires_at>now() RETURNING id`
    )
    if (!authorized.rows.length)
      throw invalid("This signup was cancelled or expired. Restart signup.")
    return getWhatsAppSignup(context, input.sessionId)
  } catch (error) {
    await context.database.execute(
      sql`UPDATE build_whatsapp_signup SET state='failed',encrypted_token=NULL WHERE id=${input.sessionId}::uuid AND project_id=${context.projectId}`
    )
    throw error
  }
}
export async function activateWhatsAppSignup(
  context: BuildContext,
  input: { sessionId: string; phoneNumberId: string; pin?: string }
) {
  const initial = await session(context, input.sessionId)
  if (initial.state === "complete") {
    const current = await getWhatsAppConnection(
      context,
      String(initial.connection_id)
    )
    if (current.account?.phoneNumberId !== input.phoneNumberId)
      throw invalid("This signup connected a different phone number.")
    return current
  }
  const claimed = await context.database.execute<Row>(
    sql`UPDATE build_whatsapp_signup SET state='activating' WHERE id=${input.sessionId}::uuid AND project_id=${context.projectId} AND state='authorized' AND expires_at>now() RETURNING *`
  )
  if (!claimed.rows[0])
    throw invalid("This signup is no longer ready. Restart signup to continue.")
  const row = claimed.rows[0],
    connectionId = String(row.connection_id)
  try {
    const phone = (row.phones_json as WhatsAppPhone[]).find(
      (p) => p.id === input.phoneNumberId
    )
    if (!phone)
      throw invalid("Choose a phone number authorized by this signup.")
    const token = String(
      decryptChannelCredentials(
        String(row.encrypted_token),
        context.projectId,
        connectionId
      ).token
    )
    const pin = input.pin ?? String(randomInt(100000, 1000000))
    await context.database.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM build_channel_connection WHERE project_id=${context.projectId} AND id=${connectionId}::uuid FOR UPDATE`
      )
      const valid = await tx.execute(
        sql`SELECT id FROM build_whatsapp_signup WHERE id=${input.sessionId}::uuid AND project_id=${context.projectId} AND state='activating' AND expires_at>now() FOR UPDATE`
      )
      if (!valid.rows.length)
        throw invalid("This signup was cancelled or expired. Restart signup.")
      // The unique phone constraint applies across tenants; never steal a number.
      const current = await tx.execute<Row>(
        sql`SELECT * FROM build_whatsapp_account WHERE connection_id=${connectionId}::uuid FOR UPDATE`
      )
      if (current.rows[0] && current.rows[0].phone_number_id !== phone.id)
        throw invalid(
          "Disconnect the current number before connecting a different number."
        )
      try {
        await tx.execute(
          sql`INSERT INTO build_whatsapp_account(connection_id,project_id,phone_number_id,waba_id,mode,display_phone_number,verified_name,token_expires_at) VALUES(${connectionId}::uuid,${context.projectId},${phone.id},${String(row.waba_id)},${String(row.mode)},${phone.display_phone_number},${phone.verified_name ?? ""},${row.token_expires_at}::timestamptz) ON CONFLICT(connection_id) DO UPDATE SET activated_at=NULL,connected_at=now(),sync_json='{}'::jsonb,waba_id=EXCLUDED.waba_id,mode=EXCLUDED.mode,token_expires_at=EXCLUDED.token_expires_at,display_phone_number=EXCLUDED.display_phone_number,verified_name=EXCLUDED.verified_name`
        )
      } catch (error) {
        if (
          (error as { cause?: { code?: string }; code?: string }).code ===
            "23505" ||
          (error as { cause?: { code?: string } }).cause?.code === "23505"
        )
          throw invalid(
            "This WhatsApp number is already connected to another channel."
          )
        throw error
      }
      await tx.execute(
        sql`UPDATE build_channel_connection SET status='draft',external_id=${phone.id},encrypted_credentials=${encryptChannelCredentials({ token, pin }, context.projectId, connectionId)},credentials_version='v1',webhook_mode='webhook',last_error=NULL WHERE project_id=${context.projectId} AND id=${connectionId}::uuid`
      )
    })
    const subscribed = await metaRequest<{ success: boolean }>(
      token,
      `${row.waba_id}/subscribed_apps`,
      {
        method: "POST",
        body: {},
      }
    )
    if (subscribed.success !== true)
      throw invalid(
        "Meta did not confirm the webhook subscription. Restart signup."
      )
    // Coexistence numbers are registered by Embedded Signup. Registering them
    // again can disrupt the customer's Business App session.
    if (row.mode === "cloud" && phone.is_on_biz_app !== true) {
      const registered = await metaRequest<{ success: boolean }>(
        token,
        `${phone.id}/register`,
        {
          method: "POST",
          body: { messaging_product: "whatsapp", pin },
        }
      )
      if (registered.success !== true)
        throw invalid(
          "Meta did not confirm phone registration. Restart signup."
        )
    }
    await context.database.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM build_channel_connection WHERE project_id=${context.projectId} AND id=${connectionId}::uuid FOR UPDATE`
      )
      const valid = await tx.execute<Row>(
        sql`SELECT id FROM build_whatsapp_signup WHERE id=${input.sessionId}::uuid AND project_id=${context.projectId} AND state='activating' AND expires_at>now() FOR UPDATE`
      )
      if (!valid.rows.length)
        throw invalid("This signup was cancelled or expired. Restart signup.")
      await tx.execute(
        sql`UPDATE build_whatsapp_account SET activated_at=now() WHERE project_id=${context.projectId} AND connection_id=${connectionId}::uuid`
      )
      await tx.execute(
        sql`UPDATE build_channel_connection SET status='connected',last_error=NULL WHERE project_id=${context.projectId} AND id=${connectionId}::uuid`
      )
      await tx.execute(
        sql`UPDATE build_whatsapp_signup SET state='complete',encrypted_token=NULL WHERE project_id=${context.projectId} AND id=${input.sessionId}::uuid`
      )
    })
    return getWhatsAppConnection(context, connectionId)
  } catch (error) {
    await context.database.execute(
      sql`UPDATE build_whatsapp_signup SET state='failed',encrypted_token=NULL WHERE id=${input.sessionId}::uuid AND project_id=${context.projectId}`
    )
    throw error
  }
}
export async function getWhatsAppConnection(
  context: BuildContext,
  connectionId: string
) {
  const channel = await connection(context, connectionId)
  const rows = await context.database.execute<Row>(
    sql`SELECT phone_number_id,waba_id,mode,display_phone_number,verified_name,token_expires_at,connected_at,sync_json FROM build_whatsapp_account WHERE project_id=${context.projectId} AND connection_id=${connectionId}::uuid`
  )
  const account = rows.rows[0]
  return {
    connectionId,
    status: String(channel.status),
    account: account
      ? {
          phoneNumberId: String(account.phone_number_id),
          wabaId: String(account.waba_id),
          mode: String(account.mode),
          displayPhoneNumber: String(account.display_phone_number),
          verifiedName: String(account.verified_name),
          tokenExpiresAt: account.token_expires_at
            ? iso(account.token_expires_at)
            : null,
          connectedAt: iso(account.connected_at),
          sync: account.sync_json,
        }
      : null,
    setup: getWhatsAppSetup(),
  }
}
export async function whatsappAuthorization(
  context: BuildContext,
  connectionId: string
) {
  const channel = await connection(context, connectionId)
  const rows = await context.database.execute<Row>(
    sql`SELECT * FROM build_whatsapp_account WHERE project_id=${context.projectId} AND connection_id=${connectionId}::uuid`
  )
  const account = rows.rows[0]
  if (!account || !account.activated_at || !channel.encrypted_credentials)
    throw invalid("Connect this WhatsApp number through Meta first.")
  if (
    account.token_expires_at &&
    new Date(iso(account.token_expires_at)).getTime() <= Date.now()
  )
    throw new WhatsAppApiError(
      "INVALID_CREDENTIAL",
      "WhatsApp authorization expired. Reconnect the number."
    )
  const credentials = decryptChannelCredentials(
    String(channel.encrypted_credentials),
    context.projectId,
    connectionId
  )
  if (!credentials.token)
    throw new WhatsAppApiError(
      "INVALID_CREDENTIAL",
      "Reconnect this WhatsApp number."
    )
  return { channel, account, token: String(credentials.token) }
}
export async function disconnectWhatsApp(
  context: BuildContext,
  connectionId: string
) {
  await connection(context, connectionId)
  // Local disconnect never deregisters a customer's phone or removes another
  // connection's shared WABA subscription. Meta can revoke app access separately.
  await context.database.transaction(async (tx) => {
    await tx.execute(
      sql`UPDATE build_channel_connection SET status='disconnected',encrypted_credentials=NULL,external_id=NULL,last_error=NULL WHERE project_id=${context.projectId} AND id=${connectionId}::uuid`
    )
    await tx.execute(
      sql`UPDATE build_whatsapp_signup SET state='failed',encrypted_token=NULL WHERE project_id=${context.projectId} AND connection_id=${connectionId}::uuid`
    )
    await tx.execute(
      sql`DELETE FROM build_whatsapp_account WHERE project_id=${context.projectId} AND connection_id=${connectionId}::uuid`
    )
    await tx.execute(
      sql`UPDATE build_channel_job SET status='failed',last_error='WhatsApp disconnected.' WHERE project_id=${context.projectId} AND connection_id=${connectionId}::uuid AND status='queued'`
    )
  })
  return { disconnected: true }
}
export async function refreshWhatsAppConnection(
  context: BuildContext,
  connectionId: string
) {
  const auth = await whatsappAuthorization(context, connectionId)
  const phone = await metaRequest<WhatsAppPhone>(
    auth.token,
    `${auth.account.phone_number_id}`,
    {
      query: {
        fields:
          "id,display_phone_number,verified_name,quality_rating,is_on_biz_app",
      },
    }
  )
  if (phone.id !== auth.account.phone_number_id)
    throw invalid("WhatsApp returned a different phone number.")
  return {
    ...(await getWhatsAppConnection(context, connectionId)),
    qualityRating: phone.quality_rating ?? null,
  }
}
export async function listWhatsAppTemplates(
  context: BuildContext,
  input: { connectionId: string; after?: string }
) {
  const auth = await whatsappAuthorization(context, input.connectionId)
  const result = await metaRequest<{
    data: unknown[]
    paging?: { cursors?: { after?: string }; next?: string }
  }>(auth.token, `${auth.account.waba_id}/message_templates`, {
    query: {
      fields: "id,name,status,category,language,components",
      limit: "50",
      ...(input.after ? { after: input.after } : {}),
    },
  })
  return {
    items: result.data,
    nextCursor: result.paging?.next
      ? (result.paging.cursors?.after ?? null)
      : null,
  }
}
async function templateMutation(
  context: BuildContext,
  operation: string,
  input: Record<string, unknown>,
  execute: () => Promise<unknown>
) {
  if (!context.idempotencyKey) throw invalid("An idempotency key is required.")
  const hash = createHash("sha256").update(canonicalJson(input)).digest("hex")
  const key = context.idempotencyKey
  const id = randomUUID()
  const claimed = await context.database.execute(
    sql`INSERT INTO build_operation_receipts(id,project_id,operation_name,idempotency_key,input_hash,status,lease_expires_at) VALUES(${id},${context.projectId},${operation},${key},${hash},'pending','infinity'::timestamptz) ON CONFLICT(project_id,operation_name,idempotency_key) DO NOTHING RETURNING id`
  )
  if (!claimed.rows.length) {
    const result = await context.database.execute<Row>(
      sql`SELECT input_hash,status,result_json FROM build_operation_receipts WHERE project_id=${context.projectId} AND operation_name=${operation} AND idempotency_key=${key}`
    )
    const receipt = result.rows[0]
    if (receipt?.input_hash !== hash)
      throw new TracerError(
        "CONFLICT",
        "This idempotency key was already used with different input."
      )
    if (receipt.status === "completed") {
      const saved = receipt.result_json as { result?: unknown; error?: string }
      if (saved.error) throw invalid(saved.error)
      return saved.result
    }
    throw new TracerError(
      "CONFLICT",
      "This template request is in progress or its result is uncertain. Check templates in Meta before submitting a new request."
    )
  }
  try {
    const result = await execute()
    await context.database.execute(
      sql`UPDATE build_operation_receipts SET status='completed',result_json=${JSON.stringify({ result })}::jsonb,completed_at=now() WHERE project_id=${context.projectId} AND id=${id}`
    )
    return result
  } catch (error) {
    if (
      error instanceof WhatsAppApiError &&
      ["WHATSAPP_REJECTED", "INVALID_CREDENTIAL", "RATE_LIMITED"].includes(
        error.code
      )
    )
      await context.database.execute(
        sql`UPDATE build_operation_receipts SET status='completed',result_json=${JSON.stringify({ error: error.message })}::jsonb,completed_at=now() WHERE project_id=${context.projectId} AND id=${id}`
      )
    throw error
  }
}
export async function createWhatsAppTemplate(
  context: BuildContext,
  input: {
    connectionId: string
    name: string
    language: string
    category: string
    components: Record<string, unknown>[]
  }
) {
  const auth = await whatsappAuthorization(context, input.connectionId)
  return templateMutation(
    context,
    "build_create_whatsapp_template",
    input,
    () =>
      metaRequest(auth.token, `${auth.account.waba_id}/message_templates`, {
        method: "POST",
        body: {
          name: input.name,
          language: input.language,
          category: input.category,
          components: input.components,
        },
      })
  )
}
export async function deleteWhatsAppTemplate(
  context: BuildContext,
  input: { connectionId: string; name: string }
) {
  const auth = await whatsappAuthorization(context, input.connectionId)
  return templateMutation(
    context,
    "build_delete_whatsapp_template",
    input,
    () =>
      metaRequest(auth.token, `${auth.account.waba_id}/message_templates`, {
        method: "DELETE",
        query: { name: input.name },
      })
  )
}
export async function setWhatsAppConsent(
  context: BuildContext,
  input: {
    connectionId: string
    recipient: string
    optedOut: boolean
    templateOptIn: boolean
    note: string
  }
) {
  await connection(context, input.connectionId)
  await context.database.execute(
    sql`INSERT INTO build_whatsapp_recipient(project_id,connection_id,recipient_id,opted_out,template_opt_in,consent_note) VALUES(${context.projectId},${input.connectionId}::uuid,${input.recipient},${input.optedOut},${input.templateOptIn},${input.note}) ON CONFLICT(project_id,connection_id,recipient_id) DO UPDATE SET opted_out=EXCLUDED.opted_out,template_opt_in=EXCLUDED.template_opt_in,consent_note=EXCLUDED.consent_note,updated_at=now()`
  )
  return getWhatsAppRecipient(context, input)
}
export async function getWhatsAppRecipient(
  context: BuildContext,
  input: { connectionId: string; recipient: string }
) {
  await connection(context, input.connectionId)
  const rows = await context.database.execute<Row>(
    sql`SELECT * FROM build_whatsapp_recipient WHERE project_id=${context.projectId} AND connection_id=${input.connectionId}::uuid AND recipient_id=${input.recipient}`
  )
  const row = rows.rows[0]
  return {
    recipient: input.recipient,
    templateOptIn: row?.template_opt_in === true,
    optedOut: row?.opted_out === true,
    lastCustomerMessageAt: row?.last_customer_message_at
      ? iso(row.last_customer_message_at)
      : null,
    canReply:
      row?.opted_out !== true &&
      !!row?.last_customer_message_at &&
      Date.now() - new Date(iso(row.last_customer_message_at)).getTime() <
        86_400_000,
  }
}
export async function sendWhatsAppEnvelope(
  context: BuildContext,
  envelope: OutboundEnvelope,
  externalConversationId: string,
  messageId: string
) {
  const auth = await whatsappAuthorization(context, envelope.connectionId)
  if (auth.channel.status !== "connected")
    throw new WhatsAppApiError(
      "WHATSAPP_DISCONNECTED",
      "This WhatsApp channel is not connected."
    )
  const prefix = `${auth.account.phone_number_id}:`
  if (!externalConversationId.startsWith(prefix))
    throw invalid("WhatsApp conversation does not belong to this number.")
  const recipient = whatsappRecipientSchema.parse(
    externalConversationId.slice(prefix.length)
  )
  const permissions = await getWhatsAppRecipient(context, {
    connectionId: envelope.connectionId,
    recipient,
  })
  const blocked = await context.database.execute<Row>(
    sql`SELECT 1 FROM build_conversations c JOIN build_contacts p ON p.project_id=c.project_id AND p.id=c.metadata_json->>'contactId' WHERE c.project_id=${context.projectId} AND c.id=${envelope.conversationId} AND p.status IN ('blocked','archived')`
  )
  if (permissions.optedOut || blocked.rows.length)
    throw new WhatsAppApiError(
      "WHATSAPP_OPTED_OUT",
      "This customer has opted out or is blocked."
    )
  const template = envelope.metadata?.whatsappTemplate
    ? whatsappTemplateSchema.parse(envelope.metadata.whatsappTemplate)
    : undefined
  if (template && !permissions.templateOptIn)
    throw new WhatsAppApiError(
      "WHATSAPP_CONSENT_REQUIRED",
      "Record the customer's permission before sending a template."
    )
  if (!template && !permissions.canReply)
    throw new WhatsAppApiError(
      "WHATSAPP_WINDOW_CLOSED",
      "The 24-hour reply window has closed. Send an approved template."
    )
  const body = whatsappMessage(envelope, recipient, messageId, template)
  const result = await metaRequest<{ messages?: { id: string }[] }>(
    auth.token,
    `${auth.account.phone_number_id}/messages`,
    { method: "POST", body, sending: true }
  )
  const id = result.messages?.[0]?.id
  if (!id)
    throw new WhatsAppApiError(
      "INVALID_PROVIDER_RESPONSE",
      "WhatsApp accepted the request without returning a message ID. Verify delivery before retrying.",
      true
    )
  return [id]
}
export async function syncWhatsAppApp(
  context: BuildContext,
  input: {
    connectionId: string
    type: "history" | "smb_app_state_sync"
    consent: true
  }
) {
  const auth = await whatsappAuthorization(context, input.connectionId)
  if (auth.account.mode !== "coexistence")
    throw invalid("Business App sync requires a coexistence connection.")
  if (
    Date.now() - new Date(iso(auth.account.connected_at)).getTime() >
    86_400_000
  )
    throw invalid(
      "Meta's initial sync window has closed. Reconnect through Embedded Signup to request history again."
    )
  const claim = await context.database.execute<Row>(
    sql`UPDATE build_whatsapp_account SET sync_json=jsonb_set(sync_json,ARRAY[${input.type}], '"requested"'::jsonb) WHERE project_id=${context.projectId} AND connection_id=${input.connectionId}::uuid AND NOT sync_json ? ${input.type} RETURNING connection_id`
  )
  if (!claim.rows.length) return { requested: false, alreadyRequested: true }
  // Requests are deliberately one-shot. A timeout may have reached Meta;
  // repeating it can discard the import opportunity.
  await metaRequest(
    auth.token,
    `${auth.account.phone_number_id}/smb_app_data`,
    {
      method: "POST",
      body: { messaging_product: "whatsapp", sync_type: input.type },
    }
  )
  return { requested: true }
}
export async function sendWhatsAppTemplate(
  context: BuildContext,
  input: {
    connectionId: string
    conversationId: string
    template: WhatsAppTemplate
    idempotencyKey: string
  }
) {
  const auth = await whatsappAuthorization(context, input.connectionId)
  const rows = await context.database.execute<Row>(
    sql`SELECT external_conversation_id,metadata_json FROM build_conversations WHERE project_id=${context.projectId} AND id=${input.conversationId} AND channel='whatsapp' AND metadata_json->>'connectionId'=${input.connectionId}`
  )
  if (!rows.rows[0])
    throw new TracerError("NOT_FOUND", "WhatsApp conversation was not found.")
  const { enqueueOutboundEnvelope } = await import("./service")
  void auth
  return enqueueOutboundEnvelope(
    context,
    {
      connectionId: input.connectionId,
      conversationId: input.conversationId,
      channel: "whatsapp",
      idempotencyKey: input.idempotencyKey,
      text: "",
      metadata: {
        whatsappTemplate: whatsappTemplateSchema.parse(input.template),
      },
    },
    String(rows.rows[0].external_conversation_id)
  )
}

export async function getWhatsAppDelivery(
  context: BuildContext,
  input: { connectionId: string; messageId: string }
) {
  await connection(context, input.connectionId)
  const result = await context.database.execute<Row>(
    sql`SELECT m.id,m.status,m.provider_message_id,m.error_code,m.error_message,m.content_json->'whatsappDelivery' AS receipt,j.status AS job_status FROM build_channel_message m LEFT JOIN build_channel_job j ON j.project_id=m.project_id AND j.message_id=m.id AND j.kind='deliver_outbound' WHERE m.project_id=${context.projectId} AND m.connection_id=${input.connectionId}::uuid AND m.id=${input.messageId} AND m.direction='outbound'`
  )
  const row = result.rows[0]
  if (!row)
    throw new TracerError("NOT_FOUND", "WhatsApp message was not found.")
  return {
    messageId: row.id,
    status: row.status,
    providerMessageId: row.provider_message_id,
    delivery: row.receipt ?? null,
    jobStatus: row.job_status ?? null,
    errorCode: row.error_code,
    error: row.error_message,
  }
}

/** Media IDs are not capabilities: prove they were received on this connection
 * before forwarding its credential to Meta's media host. Never expose that URL. */
export async function getWhatsAppMedia(
  context: BuildContext,
  input: { connectionId: string; mediaId: string }
) {
  const auth = await whatsappAuthorization(context, input.connectionId)
  const received = await context.database.execute(
    sql`SELECT 1 FROM build_channel_message m WHERE m.project_id=${context.projectId} AND m.connection_id=${input.connectionId}::uuid AND m.content_json->'attachments' @> ${JSON.stringify([{ fileId: input.mediaId }])}::jsonb LIMIT 1`
  )
  if (!received.rows.length)
    throw new TracerError(
      "NOT_FOUND",
      "This attachment was not received on this WhatsApp channel."
    )
  const metadata = await metaRequest<{
    url: string
    mime_type: string
    file_size: number
    sha256?: string
  }>(auth.token, input.mediaId, {
    query: { phone_number_id: String(auth.account.phone_number_id) },
  })
  const maxBytes = 5 * 1024 * 1024
  if (
    !Number.isSafeInteger(metadata.file_size) ||
    metadata.file_size < 0 ||
    metadata.file_size > maxBytes
  )
    throw invalid("This attachment exceeds the 5 MiB download limit.")
  let url: URL
  try {
    url = new URL(metadata.url)
  } catch {
    throw invalid("Meta returned an invalid attachment address.")
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "lookaside.fbsbx.com" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw invalid("Meta returned an unsupported attachment address.")
  const { publicHttpRequest } = await import("../http")
  const response = await publicHttpRequest(url.toString(), {
    headers: { Authorization: `Bearer ${auth.token}` },
    maxResponseBytes: maxBytes,
  })
  if (response.status !== 200)
    throw invalid(
      "WhatsApp could not download this attachment. Try again while it is available in Meta."
    )
  return {
    mediaId: input.mediaId,
    mimeType: metadata.mime_type,
    size: response.body.byteLength,
    contentBase64: Buffer.from(response.body).toString("base64"),
  }
}
