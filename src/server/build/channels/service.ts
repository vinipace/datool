import { createHmac, randomUUID } from "node:crypto"
import { isIP } from "node:net"

import { sql } from "drizzle-orm"
import {
  chatBubbleOverridesSchema,
  resolveChatBubbleSettings,
  type ChatBubbleOverrides,
} from "@/src/lib/build/chat-bubble"

import {
  buildChannelSchema,
  type BuildChannel,
} from "@/src/lib/build/contracts"
import {
  CHANNEL_DESCRIPTORS,
  redactConfig,
  type AgentTurnRunner,
  type ChannelConnection,
  type ChannelId,
  type InboundEnvelope,
  type OutboundEnvelope,
  type NormalizedAttachment,
} from "@/src/lib/build/channels"
import {
  channelSigningSecret,
  signVisitorContext,
  verifyVisitorContext,
} from "./visitor"
import { db } from "@/lib/db"
import {
  createTracerDatabase,
  scopedTracerTransaction,
  type TracerDatabase,
} from "@/src/server/tracer/db"
import { operationId, type BuildContext } from "../context"
import { assertPublicHttpUrl } from "../http"
import { TracerError } from "@/src/server/tracer/errors"
import {
  pinContinuationWidgets,
  runtimeMessageMetadata,
} from "../runtime/continuations"
import type { RunAgentTurnResult, RuntimeContinuation } from "../runtime"
import {
  ConversationOwnershipLostError,
  ConversationService,
} from "../conversations"
import { resolveRoutingWithExecutor } from "../operations/teams"
import { reconcileCampaignStatus } from "../operations/campaign-status"
import { decryptChannelCredentials, encryptChannelCredentials } from "./secrets"
import {
  sendWhatsAppEnvelope,
  whatsappAuthorization,
  disconnectWhatsApp,
} from "./whatsapp"
import { WhatsAppApiError } from "./whatsapp-api"
import {
  createTelegramApi,
  newTelegramWebhookSecret,
  normalizeTelegramUpdate,
  sendTelegramEnvelope,
  TelegramApiError,
  type TelegramUpdate,
} from "./telegram"

type BuildDatabase = TracerDatabase
type Row = Record<string, unknown>
const connectionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function requireConnectionId(value: string) {
  if (!connectionIdPattern.test(value))
    throw new Error("Channel connection was not found.")
  return value
}

function database(context: BuildContext): BuildDatabase {
  return context.database
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === "string") {
    try {
      return jsonObject(JSON.parse(value))
    } catch {
      return {}
    }
  }
  if (typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>
  return {}
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function asRuntimeContinuation(value: unknown): RuntimeContinuation | null {
  const candidate = jsonValue(value)
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    return null
  const type = (candidate as { type?: unknown }).type
  if (
    type !== "client_action" &&
    type !== "widget" &&
    type !== "form" &&
    type !== "handoff" &&
    type !== "approval_required" &&
    type !== "wait"
  )
    return null
  return candidate as RuntimeContinuation
}

function persistedHandoffFence(snapshot: Record<string, unknown>) {
  const marker = snapshot.handoff
  if (!marker || typeof marker !== "object" || Array.isArray(marker))
    return null
  const record = marker as Record<string, unknown>
  if (record.ownerType !== "human") return null
  const fence = Number(record.ownerFence)
  return Number.isSafeInteger(fence) && fence >= 0 ? fence : null
}

function timestamp(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value ?? "")
}

function channelErrorCode(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code.replace(/[^A-Za-z0-9_]/g, "").slice(0, 80) || "UNKNOWN"
  if (error instanceof Error && error.name)
    return error.name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 80) || "UNKNOWN"
  return "UNKNOWN"
}

/** Provider responses and arbitrary runner errors must never enter ledgers. */
function safeChannelError(error: unknown) {
  // TelegramApiError messages are authored by our adapter; raw provider
  // descriptions, transport errors and credential-bearing URLs are discarded.
  if (error instanceof TelegramApiError || error instanceof WhatsAppApiError)
    return error.message
  const code = channelErrorCode(error)
  const messages: Record<string, string> = {
    RATE_LIMITED: "Provider rate limit reached.",
    INVALID_CREDENTIAL: "Provider rejected the channel credential.",
    NETWORK_ERROR: "The provider request could not be completed.",
    INVALID_PROVIDER_RESPONSE: "The provider returned an invalid response.",
    UNSUPPORTED_ATTACHMENT: "The channel does not support this attachment.",
    CONVERSATION_HUMAN_OWNED: "A human currently owns this conversation.",
    MODEL_REQUEST_FAILED: "Agent execution failed.",
    CHANNEL_LEASE_LOST:
      "The channel job lease was lost; delivery outcome is uncertain.",
  }
  return messages[code] ?? `Channel operation failed (${code}).`
}

function isTerminalChannelError(error: { code?: string; uncertain?: boolean }) {
  return (
    Boolean(error.uncertain) ||
    new Set([
      "INVALID_CREDENTIAL",
      "INVALID_WEBHOOK",
      "INVALID_WEBHOOK_SECRET",
      "UNSUPPORTED_ATTACHMENT",
      "WHATSAPP_WINDOW_CLOSED",
      "WHATSAPP_CONSENT_REQUIRED",
      "WHATSAPP_OPTED_OUT",
      "WHATSAPP_INVALID_MESSAGE",
      "WHATSAPP_REJECTED",
      "WHATSAPP_DISCONNECTED",
    ]).has(error.code ?? "")
  )
}

function assertConnectedConnection(connection: ChannelConnection) {
  if (connection.status !== "connected") {
    throw new Error("Channel connection is not connected.")
  }
}

/** Public callers have no authenticated project context, so the browser
 * session and message guards are deliberately scoped to one deployment. A
 * reverse proxy may provide a trustworthy client address when the operator
 * explicitly enables DATOOL_TRUSTED_PROXY; otherwise requests share one
 * conservative anonymous bucket because Origin is caller controlled. */
export function publicRequestClientKey(request: Request) {
  const trustedProxy = /^(?:1|true|yes)$/i.test(
    process.env.DATOOL_TRUSTED_PROXY ?? ""
  )
  if (trustedProxy) {
    const realIp = request.headers.get("x-real-ip")?.trim()
    if (realIp && isIP(realIp)) return `ip:${realIp}`
    const forwarded = request.headers
      .get("x-forwarded-for")
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .reverse()
      .find((value) => isIP(value))
    if (forwarded) return `ip:${forwarded}`
  }
  return "anonymous"
}

export class PublicAdmissionRateLimitError extends Error {
  readonly code = "PUBLIC_ADMISSION_RATE_LIMITED"
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number) {
    super("Public admission rate limit reached. Try again shortly.")
    this.name = "PublicAdmissionRateLimitError"
    this.retryAfterSeconds = retryAfterSeconds
  }
}

type PublicAdmissionScope = "session" | "message" | "feedback"

const PUBLIC_ADMISSION_DEFAULTS: Record<
  PublicAdmissionScope,
  { maxRequests: number; windowSeconds: number }
> = {
  // Session creation is the expensive anonymous path: it creates contact and
  // conversation rows, so keep this burst deliberately smaller than messages.
  session: { maxRequests: 30, windowSeconds: 60 },
  message: { maxRequests: 120, windowSeconds: 60 },
  feedback: { maxRequests: 120, windowSeconds: 60 },
}

function publicAdmissionPolicy(
  connection: ChannelConnection,
  scope: PublicAdmissionScope
) {
  const defaults = PUBLIC_ADMISSION_DEFAULTS[scope]
  const configured = jsonObject(jsonObject(connection.config).publicAdmission)
  const value = jsonObject(configured[scope])
  const maxRequests = Number(value.maxRequests)
  const windowSeconds = Number(value.windowSeconds)
  return {
    maxRequests: Number.isInteger(maxRequests)
      ? Math.min(10_000, Math.max(1, maxRequests))
      : defaults.maxRequests,
    windowSeconds: Number.isInteger(windowSeconds)
      ? Math.min(3_600, Math.max(10, windowSeconds))
      : defaults.windowSeconds,
  }
}

function publicAdmissionKey(clientKey: string | undefined) {
  const source = (clientKey?.trim() || "anonymous").slice(0, 512)
  return createHmac("sha256", channelSigningSecret())
    .update(`build-public-admission:${source}`)
    .digest("hex")
}

/**
 * Atomically admits one anonymous public request before contact, conversation,
 * or channel jobs are created. The key is intentionally independent of the
 * signed visitor id so fresh visitor tokens cannot evade the guard.
 */
export async function enforcePublicAdmission(
  context: BuildContext,
  connection: ChannelConnection,
  scope: PublicAdmissionScope,
  clientKey?: string
) {
  const policy = publicAdmissionPolicy(connection, scope)
  const now = Date.now()
  const windowMs = policy.windowSeconds * 1_000
  const windowStartedAt = new Date(Math.floor(now / windowMs) * windowMs)
  const hashedClientKey = publicAdmissionKey(clientKey)
  const databaseHandle = database(context)

  // Keep the anonymous ledger bounded without requiring a separate cleanup
  // worker. Only old buckets for this connection are touched on a request.
  await databaseHandle.execute(sql`
    DELETE FROM build_public_admission_bucket
    WHERE project_id = ${context.projectId}
      AND connection_id = ${connection.id}::uuid
      AND window_started_at < ${new Date(now - Math.max(windowMs * 2, 120_000))}
  `)
  const result = await databaseHandle.execute<{
    request_count: number | string
    window_started_at: Date | string
  }>(sql`
    INSERT INTO build_public_admission_bucket
      (project_id, connection_id, scope, client_key, window_started_at, request_count)
    VALUES (${context.projectId}, ${connection.id}::uuid, ${scope}, ${hashedClientKey}, ${windowStartedAt}, 1)
    ON CONFLICT (project_id, connection_id, scope, client_key, window_started_at)
    DO UPDATE SET request_count = LEAST(build_public_admission_bucket.request_count + 1, 2147483647)
    RETURNING request_count, window_started_at
  `)
  const requestCount = Number(result.rows[0]?.request_count ?? 0)
  if (requestCount <= policy.maxRequests) return
  const bucket =
    result.rows[0]?.window_started_at instanceof Date
      ? result.rows[0].window_started_at.getTime()
      : Date.parse(
          String(
            result.rows[0]?.window_started_at ?? windowStartedAt.toISOString()
          )
        )
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((bucket + windowMs - now) / 1_000)
  )
  throw new PublicAdmissionRateLimitError(retryAfterSeconds)
}

function connectionFromRow(row: Row): ChannelConnection {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    organizationId:
      row.organization_id == null ? null : String(row.organization_id),
    agentId: String(row.agent_id),
    channel: String(row.channel) as ChannelId,
    label: String(row.label),
    status: String(row.status) as ChannelConnection["status"],
    externalId: row.external_id == null ? null : String(row.external_id),
    config: redactConfig(jsonObject(row.config_json)),
    lastError: row.last_error == null ? null : String(row.last_error),
    lastInboundAt:
      row.last_inbound_at == null ? null : timestamp(row.last_inbound_at),
    lastOutboundAt:
      row.last_outbound_at == null ? null : timestamp(row.last_outbound_at),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  }
}

export type ChannelCredentialInput = Record<string, unknown>
export type CreateChannelInput = {
  id?: string
  agentId: string
  channel: BuildChannel
  label: string
  config?: Record<string, unknown>
  credentials?: ChannelCredentialInput
  mode?: "webhook" | "polling"
}

export async function getChannelConnection(
  context: BuildContext,
  connectionId: string,
  options: { includeSecret?: boolean } = {}
) {
  requireConnectionId(connectionId)
  const result = await database(context).execute<Row>(sql`
    SELECT id, project_id, organization_id, agent_id, channel, label, status,
           external_id, config_json, last_error, last_inbound_at,
           last_outbound_at, created_at, updated_at,
           encrypted_credentials, encrypted_webhook_secret, webhook_mode,
           polling_offset
    FROM build_channel_connection
    WHERE project_id = ${context.projectId} AND id = ${connectionId}::uuid
    LIMIT 1
  `)
  const row = result.rows[0]
  if (!row) throw new Error("Channel connection was not found.")
  return {
    connection: connectionFromRow(row),
    ...(options.includeSecret
      ? {
          credentials: row.encrypted_credentials
            ? decryptChannelCredentials(
                String(row.encrypted_credentials),
                context.projectId,
                String(row.id)
              )
            : {},
          webhookSecret: row.encrypted_webhook_secret
            ? (decryptChannelCredentials(
                String(row.encrypted_webhook_secret),
                context.projectId,
                String(row.id)
              ).value as string)
            : null,
          mode: row.webhook_mode as "webhook" | "polling" | null,
          pollingOffset:
            row.polling_offset == null ? null : Number(row.polling_offset),
        }
      : {}),
  }
}

/** Public edge lookup: only returns a project-scoped context, never credentials. */
export async function publicConnectionContext(
  connectionId: string
): Promise<BuildContext> {
  requireConnectionId(connectionId)
  const result = await db.query<{
    project_id: string
    organization_id: string
  }>(
    "SELECT project_id, organization_id FROM build_channel_connection WHERE id = $1::uuid LIMIT 1",
    [connectionId]
  )
  const row = result.rows[0]
  if (!row) throw new Error("Channel connection was not found.")
  const scoped = createTracerDatabase(undefined, { projectId: row.project_id })
  return {
    database: scoped,
    projectId: row.project_id,
    organizationId: row.organization_id,
  }
}

export async function listChannelConnections(
  context: BuildContext,
  agentId?: string
) {
  const rows = await database(context).execute<Row>(sql`
    SELECT id, project_id, organization_id, agent_id, channel, label, status,
           external_id, config_json, last_error, last_inbound_at,
           last_outbound_at, created_at, updated_at
    FROM build_channel_connection
    WHERE project_id = ${context.projectId}
      ${agentId ? sql`AND agent_id = ${agentId}` : sql``}
    ORDER BY updated_at DESC, id
  `)
  return rows.rows.map(connectionFromRow)
}

export async function createChannelConnection(
  context: BuildContext,
  input: CreateChannelInput
) {
  const channel = buildChannelSchema.parse(input.channel)
  if (channel === "whatsapp" && input.credentials)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Connect WhatsApp through Embedded Signup; credentials cannot be supplied manually."
    )
  const descriptor = CHANNEL_DESCRIPTORS[channel]
  const config = descriptor.connectionSchema.parse(
    input.config ?? {}
  ) as Record<string, unknown>
  const id = input.id ?? randomUUID()
  requireConnectionId(id)
  const mode = input.mode ?? (channel === "telegram" ? "webhook" : null)
  const encrypted = input.credentials
    ? encryptChannelCredentials(input.credentials, context.projectId, id)
    : null
  await database(context).execute(sql`
    INSERT INTO build_channel_connection
      (id, project_id, organization_id, agent_id, channel, label, status,
       config_json, encrypted_credentials, credentials_version, webhook_mode)
    VALUES
      (${id}::uuid, ${context.projectId}, ${context.organizationId ?? null},
       ${input.agentId}, ${channel}, ${input.label.trim()}, 'draft',
       ${JSON.stringify(config)}::jsonb, ${encrypted},
       ${encrypted ? "v1" : null}, ${mode})
  `)
  return (await getChannelConnection(context, id)).connection
}

/** Edit connection settings without touching identity, credentials or delivery state. */
export async function updateChannelConnection(
  context: BuildContext,
  input: {
    connectionId: string
    label?: string
    originAllowlist?: string[]
    bubble?: ChatBubbleOverrides
  }
) {
  const { connection } = await getChannelConnection(context, input.connectionId)
  if (input.originAllowlist !== undefined && connection.channel !== "web")
    throw new Error("Allowed origins apply only to website channels.")
  if (input.bubble !== undefined && connection.channel !== "web")
    throw new Error("Chat bubble settings apply only to website channels.")
  const bubble =
    input.bubble === undefined
      ? undefined
      : chatBubbleOverridesSchema.parse(input.bubble)
  const origins = input.originAllowlist?.map((value) => {
    const url = new URL(value)
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Enter website origins such as https://example.com, without a path."
      )
    return url.origin
  })
  if (
    input.label !== undefined &&
    (!input.label.trim() || input.label.trim().length > 200)
  )
    throw new Error(
      "Connection name must contain between 1 and 200 characters."
    )
  const patch = {
    ...(origins === undefined
      ? {}
      : { originAllowlist: [...new Set(origins)] }),
  }
  await database(context).execute(sql`
    UPDATE build_channel_connection
    SET label = ${input.label === undefined ? sql`label` : input.label.trim()},
        config_json = config_json || ${JSON.stringify(patch)}::jsonb || ${bubble === undefined ? sql`'{}'::jsonb` : sql`jsonb_build_object('bubble', COALESCE(config_json->'bubble', '{}'::jsonb) || ${JSON.stringify(bubble)}::jsonb)`},
        updated_at = now()
    WHERE project_id = ${context.projectId} AND id = ${connection.id}::uuid
  `)
  return (await getChannelConnection(context, connection.id)).connection
}

export async function updateChannelStatus(
  context: BuildContext,
  connectionId: string,
  status: ChannelConnection["status"],
  error?: string
) {
  requireConnectionId(connectionId)
  const loaded = await getChannelConnection(context, connectionId)
  if (loaded.connection.channel === "whatsapp") {
    if (status === "disconnected") {
      await disconnectWhatsApp(context, connectionId)
      return (await getChannelConnection(context, connectionId)).connection
    }
    if (status === "connected")
      await whatsappAuthorization(context, connectionId)
  }
  await database(context).execute(sql`
    UPDATE build_channel_connection
    SET status = ${status}, last_error = ${error ?? null}
    WHERE project_id = ${context.projectId} AND id = ${connectionId}::uuid
  `)
  return (await getChannelConnection(context, connectionId)).connection
}

function webhookUrl(connectionId: string) {
  const base = process.env.DATOOL_PUBLIC_URL ?? process.env.BETTER_AUTH_URL
  try {
    const url = assertPublicHttpUrl(base ?? "")
    if (url.protocol !== "https:") throw new Error("HTTPS required")
    return `${url.origin}/api/build-webhooks/telegram/${connectionId}`
  } catch {
    throw new TelegramApiError({
      code: "INVALID_WEBHOOK",
      message:
        "Webhooks need a public HTTPS URL. Use Polling worker for local development.",
    })
  }
}

export async function registerTelegramConnection(
  context: BuildContext,
  connectionId: string,
  options: { mode?: "webhook" | "polling"; dropPendingUpdates?: boolean } = {}
) {
  const loaded = await getChannelConnection(context, connectionId, {
    includeSecret: true,
  })
  if (loaded.connection.channel !== "telegram")
    throw new Error("This connection is not Telegram.")
  const token = String(
    loaded.credentials?.token ?? loaded.credentials?.botToken ?? ""
  )
  const api = createTelegramApi(token)
  const mode = options.mode ?? loaded.mode ?? "webhook"
  try {
    // Reject impossible local webhooks before contacting Telegram.
    const url = mode === "webhook" ? webhookUrl(connectionId) : null
    const me = await api.getMe()
    let secret = loaded.webhookSecret
    if (!secret) secret = newTelegramWebhookSecret()
    if (url) {
      await api.setWebhook({
        url,
        secretToken: secret,
        dropPendingUpdates: options.dropPendingUpdates,
      })
    } else {
      await api.deleteWebhook(options.dropPendingUpdates ?? false)
    }
    await database(context).execute(sql`
      UPDATE build_channel_connection
      SET external_id = ${String(me.id)},
          config_json = config_json || ${JSON.stringify({ mode, botUsername: me.username ?? null, botName: me.first_name })}::jsonb,
          encrypted_webhook_secret = ${encryptChannelCredentials({ value: secret }, context.projectId, connectionId)},
          webhook_mode = ${mode}, status = 'connected', last_error = NULL
      WHERE project_id = ${context.projectId} AND id = ${connectionId}::uuid
    `)
    return (await getChannelConnection(context, connectionId)).connection
  } catch (error) {
    await database(context)
      .execute(
        sql`
      UPDATE build_channel_connection
      SET status = 'error', last_error = ${safeChannelError(error)},
          webhook_mode = CASE WHEN external_id IS NULL THEN ${mode} ELSE webhook_mode END,
          config_json = CASE WHEN external_id IS NULL
            THEN config_json || ${JSON.stringify({ mode })}::jsonb ELSE config_json END
      WHERE project_id = ${context.projectId} AND id = ${connectionId}::uuid
    `
      )
      .catch(() => undefined)
    if (error instanceof TelegramApiError) {
      throw new TracerError(
        isTerminalChannelError(error) ? "VALIDATION_ERROR" : "INTERNAL_ERROR",
        safeChannelError(error),
        {
          status: isTerminalChannelError(error) ? 400 : 502,
          details: { reason: error.code },
        }
      )
    }
    throw error
  }
}

export async function unregisterTelegramConnection(
  context: BuildContext,
  connectionId: string,
  dropPendingUpdates = false
) {
  const loaded = await getChannelConnection(context, connectionId, {
    includeSecret: true,
  })
  if (loaded.connection.channel !== "telegram")
    throw new Error("This connection is not Telegram.")
  await createTelegramApi(
    String(loaded.credentials?.token ?? loaded.credentials?.botToken ?? "")
  ).deleteWebhook(dropPendingUpdates)
  await updateChannelStatus(context, connectionId, "disconnected")
  return (await getChannelConnection(context, connectionId)).connection
}

export async function findOrCreateContact(
  context: BuildContext,
  envelope: InboundEnvelope
) {
  // WhatsApp's sender ID is stable across business numbers. Derive it from
  // the provider identity, never a phone supplied by a public chat visitor.
  const whatsappSender = envelope.channel === "whatsapp"
    ? /^[0-9]+:([1-9][0-9]{6,19})$/.exec(envelope.externalContactId)?.[1]
    : undefined
  const externalId = whatsappSender
    ? `whatsapp:${whatsappSender}`
    : `${envelope.channel}:${envelope.connectionId}:${envelope.externalContactId}`
  const identityKey = `${envelope.connectionId}:${envelope.externalContactId}`
  const phone = whatsappSender ? `+${whatsappSender}` : envelope.contact.phone ?? null
  const metadata = JSON.stringify({ ...envelope.contact.metadata, username: envelope.contact.username, locale: envelope.contact.locale, channel: envelope.channel })

  return database(context).transaction(async (tx) => {
    const knownIdentity = await tx.execute<{ contact_id: string }>(sql`
      select contact_id from build_contact_identities
      where project_id=${context.projectId} and channel=${envelope.channel} and identity_key=${identityKey}
      limit 1
    `)
    let contactId = knownIdentity.rows[0]?.contact_id
    if (!contactId && whatsappSender) {
      // Reuse contacts created before sender-based IDs, retaining their IDs,
      // attributes and restrictions. Connection identities still own routing.
      const legacy = await tx.execute<{ id: string }>(sql`
        select c.id from build_contacts c
        where c.project_id=${context.projectId} and (
          c.external_id=${externalId} or exists (
            select 1 from build_contact_identities i
            where i.project_id=c.project_id and i.contact_id=c.id and i.channel='whatsapp'
              and i.identity_key ~ '^[0-9a-f-]{36}:[0-9]+:[1-9][0-9]{6,19}$'
              and split_part(i.identity_key,':',3)=${whatsappSender}
          )
        )
        order by case when c.status='blocked' then 0 when c.status='archived' then 1 else 2 end,c.created_at,c.id
        limit 1
      `)
      contactId = legacy.rows[0]?.id
    }
    if (contactId) {
      await tx.execute(sql`
        update build_contacts
        set display_name=case when ${envelope.contact.displayName ?? ""}<>'' then ${envelope.contact.displayName ?? ""} else display_name end,
            phone=coalesce(${phone},phone),metadata_json=metadata_json || ${metadata}::jsonb,
            last_seen_at=now(),updated_at=now()
        where project_id=${context.projectId} and id=${contactId}
      `)
    } else {
      // The project/external-ID unique index also arbitrates simultaneous
      // first messages arriving through different WhatsApp connections.
      const result = await tx.execute<{ id: string }>(sql`
        INSERT INTO build_contacts
          (id, project_id, external_id, display_name, phone, metadata_json, last_seen_at)
        VALUES (${randomUUID()}, ${context.projectId}, ${externalId},
          ${envelope.contact.displayName ?? ""}, ${phone}, ${metadata}::jsonb, now())
        ON CONFLICT (project_id, external_id) WHERE external_id IS NOT NULL
        DO UPDATE SET display_name = CASE WHEN EXCLUDED.display_name <> '' THEN EXCLUDED.display_name ELSE build_contacts.display_name END,
                      phone = COALESCE(EXCLUDED.phone, build_contacts.phone),
                      metadata_json = build_contacts.metadata_json || EXCLUDED.metadata_json,
                      last_seen_at = now(),updated_at=now()
        RETURNING id
      `)
      contactId = result.rows[0].id
    }
    await tx.execute(sql`
      INSERT INTO build_contact_identities
        (id, project_id, contact_id, channel, identity_key, display_name, metadata_json)
      VALUES (${randomUUID()}, ${context.projectId}, ${contactId}, ${envelope.channel},
        ${identityKey}, ${envelope.contact.displayName ?? null}, ${JSON.stringify(envelope.contact.metadata ?? {})}::jsonb)
      ON CONFLICT (project_id, channel, identity_key)
      DO UPDATE SET contact_id = EXCLUDED.contact_id,
                    display_name = COALESCE(EXCLUDED.display_name, build_contact_identities.display_name),
                    metadata_json = build_contact_identities.metadata_json || EXCLUDED.metadata_json,
                    updated_at = now()
    `)
    return contactId
  })
}

async function findOrCreateConversation(
  context: BuildContext,
  envelope: InboundEnvelope,
  contactId: string
) {
  const id = randomUUID()
  const result = await database(context).execute<Row>(sql`
    INSERT INTO build_conversations
      (id, project_id, agent_id, channel, external_conversation_id, metadata_json, last_message_at)
    SELECT ${id}, ${context.projectId}, c.agent_id, ${envelope.channel}, ${envelope.externalConversationId},
      ${JSON.stringify({ connectionId: envelope.connectionId, contactId })}::jsonb, ${envelope.receivedAt}::timestamptz
    FROM build_channel_connection c
    WHERE c.project_id = ${context.projectId}
      AND c.id = ${envelope.connectionId}::uuid
      AND c.channel = ${envelope.channel}
    ON CONFLICT DO NOTHING
    RETURNING id, owner_type, agent_id
  `)
  const row =
    result.rows[0] ??
    (
      await database(context).execute<Row>(sql`
    SELECT id, owner_type, agent_id
    FROM build_conversations
    WHERE project_id = ${context.projectId}
      AND agent_id = (SELECT agent_id FROM build_channel_connection WHERE project_id = ${context.projectId} AND id = ${envelope.connectionId}::uuid)
      AND channel = ${envelope.channel}
      AND external_conversation_id = ${envelope.externalConversationId}
      AND metadata_json->>'connectionId' = ${envelope.connectionId}
    LIMIT 1
  `)
    ).rows[0]
  if (!row) throw new Error("Channel connection is unavailable.")
  await database(context).execute(sql`
    UPDATE build_conversations
    SET metadata_json = metadata_json || ${JSON.stringify({ connectionId: envelope.connectionId, contactId })}::jsonb,
        last_message_at = GREATEST(last_message_at, ${envelope.receivedAt}::timestamptz), updated_at = now()
    WHERE project_id = ${context.projectId} AND id = ${String(row.id)}
  `)
  return {
    id: String(row.id),
    ownership: String(row.owner_type) as "ai" | "human",
    agentId: String(row.agent_id),
    contactId,
  }
}

/**
 * Persists an inbound update before acknowledging the provider. The provider
 * event key is unique, so Telegram retries are accepted exactly once.
 */
export async function enqueueTelegramUpdate(
  context: BuildContext,
  connectionId: string,
  update: TelegramUpdate
) {
  const connection = await getChannelConnection(context, connectionId)
  assertConnectedConnection(connection.connection)
  const envelope = normalizeTelegramUpdate(connectionId, update)
  if (!envelope) return { accepted: false, ignored: true, deduplicated: false }
  return enqueueInboundEnvelope(context, envelope)
}

async function admitInboundTicket(
  executor: Pick<BuildDatabase, "execute">,
  projectId: string,
  envelope: InboundEnvelope,
  conversationId: string,
  contactId: string
) {
  const contact = await executor.execute<{ status: string }>(sql`
    select status from build_contacts where project_id=${projectId} and id=${contactId} limit 1
  `)
  const assignment = await resolveRoutingWithExecutor(executor, projectId, {
    channel: envelope.channel,
    priority: "normal",
    tags: [],
    contactStatus: contact.rows[0]?.status,
  })
  const subject = envelope.text.trim().replace(/\s+/g, " ").slice(0, 500)
  const result = await executor.execute<{
    id: string
    conversation_id: string
    contact_id: string | null
    channel: string
    team_id: string | null
    assignee_user_id: string | null
    inserted: boolean
  }>(sql`
    insert into build_inbox_tickets
      (id,project_id,conversation_id,contact_id,channel,subject,status,priority,tags_json,assignee_user_id,team_id,last_message_at)
    values
      (${operationId("ticket")},${projectId},${conversationId},${contactId},${envelope.channel},${subject},'open','normal','[]'::jsonb,${assignment.assigneeUserId},${assignment.teamId},now())
    on conflict (project_id,conversation_id) do update set
      contact_id=coalesce(excluded.contact_id,build_inbox_tickets.contact_id),
      channel=excluded.channel,
      status=case when build_inbox_tickets.status in ('solved','closed') then 'open' else build_inbox_tickets.status end,
      resolved_at=case when build_inbox_tickets.status in ('solved','closed') then null else build_inbox_tickets.resolved_at end,
      assignee_user_id=coalesce(build_inbox_tickets.assignee_user_id,excluded.assignee_user_id),
      team_id=coalesce(build_inbox_tickets.team_id,excluded.team_id),
      subject=case when nullif(build_inbox_tickets.subject,'') is null then excluded.subject else build_inbox_tickets.subject end,
      last_message_at=now(),
      updated_at=now()
    returning id,conversation_id,contact_id,channel,team_id,assignee_user_id,xmax=0 as inserted
  `)
  const row = result.rows[0]
  if (!row) throw new Error("Inbound message could not create an inbox ticket.")
  await executor.execute(sql`
    insert into build_ticket_events(id,project_id,ticket_id,event_type,actor_id,payload_json)
    values (${operationId("ticket_event")},${projectId},${row.id},${row.inserted ? "created" : "message_received"},null,${JSON.stringify({ channel: envelope.channel, providerEventId: envelope.providerEventId, ruleId: assignment.ruleId })}::jsonb)
  `)
  if (row.inserted) {
    await executor.execute(sql`
      insert into build_operation_events(id,project_id,event_type,conversation_id,contact_id,channel,payload_json)
      values (${operationId("event")},${projectId},'ticket_created',${row.conversation_id},${row.contact_id},${row.channel},${JSON.stringify({ ticketId: row.id, ruleId: assignment.ruleId, teamId: row.team_id, assigneeUserId: row.assignee_user_id })}::jsonb)
    `)
  }
  return { ticketId: row.id, assignment }
}

export async function enqueueInboundEnvelope(
  context: BuildContext,
  envelope: InboundEnvelope
) {
  const connection = await getChannelConnection(context, envelope.connectionId)
  if (connection.connection.channel !== envelope.channel)
    throw new Error("Channel envelope does not match its connection.")
  assertConnectedConnection(connection.connection)
  const contactId = await findOrCreateContact(context, envelope)
  const conversation = await findOrCreateConversation(
    context,
    envelope,
    contactId
  )
  const messageId = randomUUID()
  const jobKey = `inbound:${envelope.connectionId}:${envelope.providerEventId}`
  const admission = await database(context).transaction(async (tx) => {
    const inserted = await tx.execute<Row>(sql`
      INSERT INTO build_channel_message
        (id, project_id, connection_id, conversation_id, contact_id, direction,
         provider_message_id, idempotency_key, content_json, status)
      VALUES (${messageId}, ${context.projectId}, ${envelope.connectionId}::uuid,
        ${conversation.id}, ${conversation.contactId}, 'inbound', ${envelope.providerMessageId},
        ${`${envelope.channel}:${envelope.providerEventId}`},
        ${JSON.stringify({ text: envelope.text, attachments: envelope.attachments, metadata: envelope.metadata })}::jsonb,
        'accepted')
      ON CONFLICT DO NOTHING
      RETURNING id
    `)
    if (!inserted.rows.length) return { inserted: false }
    await tx.execute(sql`
      INSERT INTO build_channel_job
        (id, project_id, connection_id, kind, message_id, payload_json, idempotency_key)
      VALUES (${randomUUID()}::uuid, ${context.projectId}, ${envelope.connectionId}::uuid,
        'process_inbound', ${messageId}, ${JSON.stringify(envelope)}::jsonb, ${jobKey})
      ON CONFLICT (project_id, idempotency_key) DO NOTHING
    `)
    await tx.execute(sql`
      UPDATE build_channel_connection SET last_inbound_at = now(), status = CASE WHEN status = 'error' THEN 'connected' ELSE status END
      WHERE project_id = ${context.projectId} AND id = ${envelope.connectionId}::uuid
    `)
    await admitInboundTicket(
      tx,
      context.projectId,
      envelope,
      conversation.id,
      contactId
    )
    await tx.execute(sql`
      INSERT INTO build_operation_events
        (id, project_id, event_type, conversation_id, contact_id, channel, payload_json, occurred_at)
      VALUES
        (${operationId("event")}, ${context.projectId}, 'message_received', ${conversation.id}, ${contactId}, ${envelope.channel},
         ${JSON.stringify({ providerEventId: envelope.providerEventId, providerMessageId: envelope.providerMessageId })}::jsonb,
         ${envelope.receivedAt})
    `)
    return { inserted: true }
  })
  if (!admission.inserted)
    return {
      accepted: false,
      ignored: false,
      deduplicated: true,
      conversationId: conversation.id,
      ...(conversation.ownership === "human" ? { humanOwned: true } : {}),
    }
  await reconcileCampaignReply(
    database(context),
    context.projectId,
    contactId,
    envelope.channel,
    conversation.id
  )
  return {
    accepted: true,
    ignored: false,
    deduplicated: false,
    conversationId: conversation.id,
    messageId,
    ...(conversation.ownership === "human" ? { humanOwned: true } : {}),
  }
}

export type ClaimedChannelJob = {
  id: string
  projectId: string
  connectionId: string
  kind: "process_inbound" | "deliver_outbound" | "telegram_poll" | "resume_wait"
  messageId: string | null
  payload: Record<string, unknown>
  attempts: number
  lockToken: string
}

/** Internal worker boundary for an authenticated durable wait continuation. */
export type ResumeWaitRunner = (input: {
  agentId: string
  channel: ChannelId
  conversationId: string
  externalConversationId?: string
  continuationId: string
  requestKey: string
}) => Promise<RunAgentTurnResult>

export class ChannelLeaseLostError extends Error {
  readonly code = "CHANNEL_LEASE_LOST"
  readonly uncertain = true

  constructor() {
    super("The channel job lease is no longer active.")
    this.name = "ChannelLeaseLostError"
  }
}

/** Refreshes a running lease only when this worker still owns its token. */
export async function renewChannelJobLease(
  database: TracerDatabase,
  job: ClaimedChannelJob
) {
  const result = await database.execute(sql`
    UPDATE build_channel_job
    SET locked_at = now()
    WHERE project_id = ${job.projectId}
      AND connection_id = ${job.connectionId}::uuid
      AND id = ${job.id}::uuid
      AND status = 'running'
      AND lock_token = ${job.lockToken}::uuid
  `)
  return Boolean(result.rowCount)
}

async function assertChannelJobReady(
  database: TracerDatabase,
  job: ClaimedChannelJob,
  expected?: { agentId?: string; channel?: string }
) {
  const result = await database.execute<Row>(sql`
    SELECT j.id,
           c.status AS connection_status,
           c.agent_id AS connection_agent_id,
           c.channel AS connection_channel
    FROM build_channel_job j
    JOIN build_channel_connection c
      ON c.project_id = j.project_id AND c.id = j.connection_id
    WHERE j.project_id = ${job.projectId}
      AND j.connection_id = ${job.connectionId}::uuid
      AND j.id = ${job.id}::uuid
      AND j.status = 'running'
      AND j.lock_token = ${job.lockToken}::uuid
    LIMIT 1
  `)
  const row = result.rows[0]
  if (!row) throw new ChannelLeaseLostError()
  if (String(row.connection_status) !== "connected")
    throw new Error("Channel connection is not connected.")
  if (expected?.agentId && String(row.connection_agent_id) !== expected.agentId)
    throw new Error("Channel job agent no longer matches its connection.")
  if (expected?.channel && String(row.connection_channel) !== expected.channel)
    throw new Error("Channel job channel no longer matches its connection.")
}

export async function claimNextChannelJob(
  database: TracerDatabase
): Promise<ClaimedChannelJob | null> {
  const lockToken = randomUUID()
  const result = await database.execute<Row>(sql`
    WITH stale_outbound AS (
      UPDATE build_channel_job
      SET status = 'uncertain', locked_at = NULL, lock_token = NULL,
          last_error = 'The channel job lease was lost; delivery outcome is uncertain.'
      WHERE status = 'running'
        AND kind = 'deliver_outbound'
        AND locked_at < now() - interval '5 minutes'
      RETURNING id, project_id, message_id
    ),
    stale_messages AS (
      UPDATE build_channel_message m
      SET status = 'uncertain', error_code = 'CHANNEL_LEASE_LOST',
          error_message = 'The channel job lease was lost; delivery outcome is uncertain.'
      FROM stale_outbound s
      WHERE m.project_id = s.project_id AND m.id = s.message_id
      RETURNING m.id
    ),
    candidate AS (
      SELECT j.id
      FROM build_channel_job j
      JOIN build_channel_connection c
        ON c.project_id = j.project_id AND c.id = j.connection_id
      WHERE c.status = 'connected'
        AND NOT EXISTS (
          SELECT 1 FROM stale_outbound s
          WHERE s.project_id = j.project_id AND s.id = j.id
        )
        AND ((j.status = 'queued' AND j.run_after <= now())
         OR (j.status = 'running' AND j.locked_at < now() - interval '5 minutes'))
        AND (j.kind <> 'telegram_poll' OR NOT EXISTS (
          SELECT 1 FROM build_channel_job active
          WHERE active.project_id = j.project_id AND active.connection_id = j.connection_id
            AND active.kind = 'telegram_poll' AND active.status = 'running'
            AND active.locked_at >= now() - interval '5 minutes' AND active.id <> j.id
        ))
      ORDER BY (j.kind = 'telegram_poll'), j.run_after, j.created_at, j.id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE build_channel_job j
    SET status = 'running', attempts = j.attempts + 1,
        locked_at = now(), lock_token = ${lockToken}::uuid
    FROM candidate
    WHERE j.id = candidate.id
    RETURNING j.id, j.project_id, j.connection_id, j.kind, j.message_id,
              j.payload_json, j.attempts, j.lock_token
  `)
  const row = result.rows[0]
  if (!row) return null
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    connectionId: String(row.connection_id),
    kind: String(row.kind) as ClaimedChannelJob["kind"],
    messageId: row.message_id == null ? null : String(row.message_id),
    payload: jsonObject(row.payload_json),
    attempts: Number(row.attempts),
    lockToken: String(row.lock_token),
  }
}

export async function completeChannelJob(
  database: TracerDatabase,
  job: ClaimedChannelJob
) {
  await database.execute(sql`
    UPDATE build_channel_job SET status = 'succeeded', locked_at = NULL, lock_token = NULL, last_error = NULL
    WHERE project_id = ${job.projectId}
      AND connection_id = ${job.connectionId}::uuid
      AND id = ${job.id}::uuid
      AND status = 'running'
      AND lock_token = ${job.lockToken}::uuid
  `)
}

export async function failChannelJob(
  database: TracerDatabase,
  job: ClaimedChannelJob,
  error: {
    message: string
    code?: string
    retryAfterSeconds?: number
    uncertain?: boolean
  },
  maxAttempts = 12
) {
  const terminal = job.attempts >= maxAttempts || isTerminalChannelError(error)
  const retryAfterSeconds =
    typeof error.retryAfterSeconds === "number" &&
    Number.isFinite(error.retryAfterSeconds) &&
    error.retryAfterSeconds >= 0
      ? error.retryAfterSeconds
      : 2 ** Math.min(job.attempts, 8)
  const delay = Math.min(300, Math.max(2, retryAfterSeconds))
  const safeMessage = safeChannelError(error)
  const updated = await database.execute(sql`
    UPDATE build_channel_job
    SET status = ${error.uncertain ? "uncertain" : terminal ? "failed" : "queued"},
        run_after = now() + (${delay} || ' seconds')::interval,
        locked_at = NULL, lock_token = NULL,
        last_error = ${safeMessage}
    WHERE project_id = ${job.projectId}
      AND connection_id = ${job.connectionId}::uuid
      AND id = ${job.id}::uuid
      AND status = 'running'
      AND lock_token = ${job.lockToken}::uuid
  `)
  if (updated.rowCount && job.messageId) {
    await database.execute(sql`
      UPDATE build_channel_message
      SET status = ${error.uncertain ? "uncertain" : terminal ? "failed" : "queued"},
          error_code = ${error.code ?? null},
          error_message = ${safeMessage}
      WHERE project_id = ${job.projectId}
        AND connection_id = ${job.connectionId}::uuid
        AND id = ${job.messageId}
    `)
  }
  if (updated.rowCount)
    await reconcileCampaignDeliveryFailure(
      database,
      job,
      safeMessage,
      terminal,
      delay
    )
  return { terminal, delaySeconds: delay }
}

export async function enqueueOutboundEnvelope(
  context: BuildContext,
  envelope: OutboundEnvelope,
  externalConversationId: string,
  options: {
    expectedOwnerFence?: number
    expectedOwnerType?: "ai" | "human"
    runtimeMessageId?: string
  } = {}
) {
  const loaded = await getChannelConnection(context, envelope.connectionId)
  if (loaded.connection.channel !== envelope.channel) {
    throw new Error("Outbound envelope does not match its connection.")
  }
  const consistency = await database(context).execute<Row>(sql`
    SELECT c.agent_id AS conversation_agent_id,
           c.channel AS conversation_channel,
           c.external_conversation_id,
           c.metadata_json->>'connectionId' AS conversation_connection_id,
           cc.agent_id AS connection_agent_id,
           cc.channel AS connection_channel
    FROM build_conversations c
    JOIN build_channel_connection cc
      ON cc.project_id = c.project_id AND cc.id = ${envelope.connectionId}::uuid
    WHERE c.project_id = ${context.projectId}
      AND c.id = ${envelope.conversationId}
      AND cc.project_id = ${context.projectId}
    LIMIT 1
  `)
  const match = consistency.rows[0]
  if (!match)
    throw new Error("Conversation or channel connection was not found.")
  if (String(match.conversation_agent_id) !== loaded.connection.agentId) {
    throw new Error("Outbound envelope agent does not match its connection.")
  }
  if (
    String(match.conversation_connection_id ?? "") !== envelope.connectionId
  ) {
    throw new Error(
      "Outbound envelope connection does not match its conversation channel."
    )
  }
  if (
    String(match.conversation_channel) !== envelope.channel ||
    String(match.connection_channel) !== envelope.channel
  ) {
    throw new Error(
      "Outbound envelope channel does not match its conversation."
    )
  }
  if (String(match.external_conversation_id ?? "") !== externalConversationId) {
    throw new Error(
      "Outbound envelope conversation identity does not match its ledger."
    )
  }
  if (envelope.contactId) {
    const contact = await database(context).execute<Row>(sql`
      SELECT 1
      FROM build_contacts
      WHERE project_id = ${context.projectId} AND id = ${envelope.contactId}
      LIMIT 1
    `)
    if (!contact.rows[0])
      throw new Error(
        "Outbound envelope contact does not belong to its project."
      )
  }
  const messageId = randomUUID()
  const admission = await database(context).transaction(async (tx) => {
    if (
      options.expectedOwnerFence !== undefined ||
      options.expectedOwnerType !== undefined
    ) {
      const expectedOwnerType = options.expectedOwnerType ?? "ai"
      const ownership = await tx.execute<Row>(sql`
        SELECT owner_type, owner_fence FROM build_conversations
        WHERE project_id = ${context.projectId} AND id = ${envelope.conversationId}
        FOR UPDATE
      `)
      const owner = ownership.rows[0]
      if (
        !owner ||
        String(owner.owner_type) !== expectedOwnerType ||
        (options.expectedOwnerFence !== undefined &&
          Number(owner.owner_fence) !== options.expectedOwnerFence)
      )
        return { inserted: false, ignored: true, channelJobId: undefined }
    }
    const inserted = await tx.execute<Row>(sql`
      INSERT INTO build_channel_message
        (id, project_id, connection_id, conversation_id, contact_id, direction,
         idempotency_key, content_json, status, runtime_message_id)
      VALUES (${messageId}, ${context.projectId}, ${envelope.connectionId}::uuid,
        ${envelope.conversationId}, ${envelope.contactId ?? null}, 'outbound', ${envelope.idempotencyKey},
        ${JSON.stringify({ text: envelope.text, attachments: envelope.attachments ?? [], metadata: envelope.metadata ?? {}, externalConversationId, expectedOwnerFence: options.expectedOwnerFence, expectedOwnerType: options.expectedOwnerType })}::jsonb,
        'queued', ${options.runtimeMessageId ?? null})
      ON CONFLICT (project_id, connection_id, idempotency_key)
      DO NOTHING RETURNING id
    `)
    if (!inserted.rows.length)
      return { inserted: false, channelJobId: undefined as string | undefined }
    const jobResult = await tx.execute<Row>(sql`
      INSERT INTO build_channel_job
        (id, project_id, connection_id, kind, message_id, payload_json, idempotency_key)
      VALUES (${randomUUID()}::uuid, ${context.projectId}, ${envelope.connectionId}::uuid,
        'deliver_outbound', ${messageId},
        ${JSON.stringify({ ...envelope, externalConversationId })}::jsonb,
        ${`outbound:${envelope.connectionId}:${envelope.idempotencyKey}`})
        ON CONFLICT (project_id, idempotency_key) DO NOTHING
        RETURNING id
    `)
    return {
      inserted: true,
      channelJobId:
        jobResult.rows[0]?.id == null
          ? undefined
          : String(jobResult.rows[0].id),
    }
  })
  if (admission.ignored)
    return {
      queued: false,
      deduplicated: false,
      reason: "ownership_changed" as const,
    }
  if (!admission.inserted) {
    const existing = await database(context).execute<Row>(sql`
      select m.id, j.id as job_id
      from build_channel_message m
      left join build_channel_job j on j.project_id=m.project_id and j.message_id=m.id
      where m.project_id=${context.projectId}
        and m.connection_id=${envelope.connectionId}::uuid
        and m.idempotency_key=${envelope.idempotencyKey}
      order by j.created_at desc nulls last
      limit 1
    `)
    return {
      queued: false,
      deduplicated: true,
      messageId:
        existing.rows[0]?.id == null ? undefined : String(existing.rows[0].id),
      channelJobId:
        existing.rows[0]?.job_id == null
          ? undefined
          : String(existing.rows[0].job_id),
    }
  }
  return {
    queued: true,
    deduplicated: false,
    messageId,
    channelJobId: admission.channelJobId,
  }
}

async function pinRuntimeContinuations(
  context: BuildContext,
  result: RunAgentTurnResult
) {
  return pinContinuationWidgets(context, {
    channel: result.conversation.channel,
    agentId: result.conversation.agentId,
    agentRevision: result.turn.snapshot.agentRevision,
    continuations: result.continuations,
  })
}

/**
 * Repair the small crash window after a runtime handoff commits ownership but
 * before the channel worker can enqueue its reply. The marker is written by
 * ConversationService.claim in the same transaction as the owner fence, and
 * is bound to this job's request key and the exact preceding AI fence. A
 * current human owner by itself is never sufficient to replay an AI result.
 */
async function recoverRuntimeHandoff(
  context: BuildContext,
  loaded: Awaited<ReturnType<typeof getChannelConnection>>,
  job: ClaimedChannelJob,
  database: TracerDatabase,
  target: {
    conversationId: string
    externalConversationId: string
    contactId?: string
    messageId?: string
    idempotencyKey: string
  }
): Promise<
  | { outputMessages: number }
  | { ignored: true; reason: "human_ownership" }
  | null
> {
  const result = await database.execute<Row>(sql`
    SELECT t.id AS turn_id,
           t.output_message_id,
           t.owner_fence AS turn_owner_fence,
           t.snapshot_json,
           m.content_json,
           c.owner_fence AS conversation_owner_fence,
           c.owner_type AS conversation_owner_type,
           c.agent_id,
           c.external_conversation_id
    FROM build_conversation_turns t
    JOIN build_conversation_messages m
      ON m.project_id = t.project_id AND m.id = t.output_message_id
    JOIN build_conversations c
      ON c.project_id = t.project_id AND c.id = t.conversation_id
    WHERE t.project_id = ${job.projectId}
      AND t.conversation_id = ${target.conversationId}
      AND t.request_key = ${`channel:${job.id}`}
      AND t.status = 'awaiting_client'
      AND c.owner_type = 'human'
      AND c.owner_fence = t.owner_fence + 1
      AND t.snapshot_json->'handoff'->>'ownerType' = 'human'
      AND t.snapshot_json->'handoff'->>'ownerFence' = c.owner_fence::text
      AND EXISTS (
        SELECT 1
        FROM build_conversation_tool_calls tc
        WHERE tc.project_id = t.project_id
          AND tc.turn_id = t.id
          AND tc.continuation_json->>'type' = 'handoff'
      )
    LIMIT 1
  `)
  const row = result.rows[0]
  if (!row) return null

  const content = jsonValue(row.content_json)
  let text = ""
  const contentContinuations: RuntimeContinuation[] = []
  if (typeof content === "string") text = content
  else if (content && typeof content === "object" && !Array.isArray(content)) {
    const record = content as Record<string, unknown>
    if (typeof record.text === "string") text = record.text
    if (Array.isArray(record.continuations)) {
      for (const item of record.continuations) {
        const continuation = asRuntimeContinuation(item)
        if (continuation) contentContinuations.push(continuation)
      }
    }
  }
  const toolCalls = await database.execute<Row>(sql`
    SELECT continuation_json
    FROM build_conversation_tool_calls
    WHERE project_id = ${job.projectId}
      AND turn_id = ${String(row.turn_id)}
      AND continuation_json IS NOT NULL
    ORDER BY created_at, id
  `)
  const continuations = [...contentContinuations]
  for (const toolCall of toolCalls.rows) {
    const continuation = asRuntimeContinuation(toolCall.continuation_json)
    if (continuation) continuations.push(continuation)
  }
  const uniqueContinuations = [
    ...new Map(
      continuations.map((continuation, index) => [
        continuation.continuationId ?? `${continuation.type}:${index}`,
        continuation,
      ])
    ).values(),
  ]
  if (!text && loaded.connection.channel !== "web") {
    text = uniqueContinuations
      .map((item) => item.message ?? item.submitLabel ?? item.eventName ?? "")
      .filter(Boolean)
      .join("\n")
  }
  if (!text && !uniqueContinuations.length) return null
  const continuationsWithWidgets = await pinContinuationWidgets(context, {
    channel: loaded.connection.channel,
    agentId: String(row.agent_id),
    agentRevision: jsonObject(row.snapshot_json).agentRevision,
    continuations: uniqueContinuations,
  })
  await assertChannelJobReady(database, job, {
    agentId: loaded.connection.agentId,
    channel: loaded.connection.channel,
  })
  const admission = await enqueueOutboundEnvelope(
    context,
    {
      connectionId: job.connectionId,
      conversationId: target.conversationId,
      contactId: target.contactId,
      channel: loaded.connection.channel,
      idempotencyKey: target.idempotencyKey,
      text,
      attachments: [],
      metadata:
        loaded.connection.channel === "web" && continuationsWithWidgets.length
          ? { continuations: continuationsWithWidgets }
          : undefined,
    },
    target.externalConversationId || String(row.external_conversation_id ?? ""),
    {
      expectedOwnerFence: Number(row.conversation_owner_fence),
      expectedOwnerType: "human",
      runtimeMessageId: String(row.output_message_id),
    }
  )
  if ("reason" in admission && admission.reason === "ownership_changed") {
    if (target.messageId)
      await database.execute(sql`
        UPDATE build_channel_message
        SET status = 'ignored'
        WHERE project_id = ${job.projectId} AND id = ${target.messageId}
      `)
    return { ignored: true, reason: "human_ownership" }
  }
  await assertChannelJobReady(database, job, {
    agentId: loaded.connection.agentId,
    channel: loaded.connection.channel,
  })
  if (target.messageId)
    await database.execute(sql`
      UPDATE build_channel_message
      SET status = 'delivered'
      WHERE project_id = ${job.projectId} AND id = ${target.messageId}
    `)
  return { outputMessages: 1 }
}

/**
 * Deliver an authenticated operator turn through the same durable channel
 * outbox used by inbound adapters. The operation key is reused for the
 * envelope, so a retry after the turn commits but before enqueueing repairs
 * the outbox without creating a second customer message.
 */
export async function enqueueAgentTurnResult(
  context: BuildContext,
  result: RunAgentTurnResult,
  idempotencyKey: string
) {
  const connectionIdValue = result.conversation.metadata.connectionId
  if (typeof connectionIdValue !== "string" || !connectionIdValue.trim())
    return {
      queued: false,
      deduplicated: false,
      reason: "no_channel_connection" as const,
    }
  const connectionId = requireConnectionId(connectionIdValue.trim())
  const externalConversationId = result.conversation.externalConversationId
  if (!externalConversationId)
    throw new Error(
      "The channel conversation has no external conversation identity."
    )
  const continuations = await pinRuntimeContinuations(context, result)
  const continuationText = continuations
    .map(
      (item: RuntimeContinuation) =>
        item.message ?? item.submitLabel ?? item.eventName ?? ""
    )
    .filter(Boolean)
    .join("\n")
  const text =
    result.text ||
    (result.conversation.channel === "web" ? "" : continuationText)
  if (!text && !continuations.length)
    return {
      queued: false,
      deduplicated: false,
      reason: "empty_result" as const,
    }
  const metadata =
    result.conversation.channel === "web"
      ? runtimeMessageMetadata(result, continuations)
      : undefined
  const contactId = result.conversation.metadata.contactId
  const replayedHandoffFence =
    result.status === "replayed"
      ? persistedHandoffFence(result.turn.snapshot)
      : null
  const handedOff =
    result.conversation.ownerType === "human" &&
    (result.status === "handed_off" || replayedHandoffFence !== null)
  return enqueueOutboundEnvelope(
    context,
    {
      connectionId,
      conversationId: result.conversation.id,
      contactId: typeof contactId === "string" ? contactId : undefined,
      channel: result.conversation.channel,
      idempotencyKey,
      text,
      attachments: [],
      metadata,
    },
    externalConversationId,
    {
      expectedOwnerFence:
        replayedHandoffFence !== null
          ? replayedHandoffFence
          : handedOff
            ? result.conversation.ownerFence
            : result.turn.ownerFence,
      expectedOwnerType: handedOff ? "human" : "ai",
      runtimeMessageId: result.message?.id,
    }
  )
}

export async function enqueueTelegramPollingJobs(database: TracerDatabase) {
  const bucket = Math.floor(Date.now() / 5_000)
  const result = await database.execute<Row>(sql`
    WITH due AS (
      SELECT c.id,c.project_id FROM build_channel_connection c
      WHERE c.channel = 'telegram' AND c.status = 'connected' AND c.webhook_mode = 'polling'
        AND NOT EXISTS (
          SELECT 1 FROM build_channel_job j
          WHERE j.project_id=c.project_id AND j.connection_id=c.id
            AND j.kind='telegram_poll' AND j.status IN ('queued','running')
        )
      FOR UPDATE SKIP LOCKED
    )
    INSERT INTO build_channel_job
      (id, project_id, connection_id, kind, payload_json, idempotency_key)
    SELECT md5(id::text || ':' || ${bucket})::uuid, project_id, id, 'telegram_poll', '{}'::jsonb,
      'telegram-poll:' || id::text || ':' || ${bucket}
    FROM due
    ON CONFLICT (project_id, idempotency_key) DO NOTHING
    RETURNING id
  `)
  return result.rows.length
}

/**
 * Materialize due and future procedure waits into the durable channel queue.
 * The continuation itself remains the source of truth; the job is only a
 * crash-recoverable timer and is keyed by the one-shot continuation id.
 */
export async function enqueueConversationWaitJobs(
  database: TracerDatabase,
  options: { limit?: number } = {}
) {
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)))
  const pending = await database.execute<Row>(sql`
    SELECT tc.project_id,
           tc.conversation_id,
           tc.continuation_json,
           c.agent_id,
           c.channel,
           c.external_conversation_id,
           c.metadata_json
    FROM build_conversation_tool_calls tc
    JOIN build_conversations c
      ON c.project_id = tc.project_id AND c.id = tc.conversation_id
    JOIN build_channel_connection cc
      ON cc.project_id = c.project_id
     AND cc.id::text = c.metadata_json->>'connectionId'
    WHERE tc.status = 'awaiting_client'
      AND tc.continuation_json->>'type' = 'wait'
      AND nullif(tc.continuation_json->>'continuationId', '') IS NOT NULL
      AND (
        nullif(tc.continuation_json->>'resumeAt', '') IS NULL
        OR tc.continuation_json->>'resumeAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,3})?Z$'
      )
      AND c.owner_type = 'ai'
      AND cc.status = 'connected'
      AND NOT EXISTS (
        SELECT 1
        FROM build_channel_job j
        WHERE j.project_id = tc.project_id
          AND j.kind = 'resume_wait'
          AND j.idempotency_key =
            'wait:' || tc.conversation_id || ':' ||
            (tc.continuation_json->>'continuationId')
      )
    ORDER BY tc.created_at,
      tc.id
    LIMIT ${limit}
  `)
  let inserted = 0
  for (const row of pending.rows) {
    const continuation = jsonObject(row.continuation_json)
    const conversationId = String(row.conversation_id ?? "")
    const continuationId = String(continuation.continuationId ?? "")
    const connectionId = jsonObject(row.metadata_json).connectionId
    if (
      !conversationId ||
      !continuationId ||
      typeof connectionId !== "string" ||
      !connectionIdPattern.test(connectionId)
    )
      continue
    const rawResumeAt = continuation.resumeAt
    const resumeAt =
      typeof rawResumeAt === "string" &&
      Number.isFinite(Date.parse(rawResumeAt))
        ? new Date(rawResumeAt)
        : new Date(0)
    const payload = {
      conversationId,
      continuationId,
      agentId: String(row.agent_id),
      channel: String(row.channel),
      ...(row.external_conversation_id == null
        ? {}
        : { externalConversationId: String(row.external_conversation_id) }),
    }
    const result = await database.execute<Row>(sql`
      INSERT INTO build_channel_job
        (id, project_id, connection_id, kind, payload_json, idempotency_key, run_after)
      VALUES
        (md5(${`wait:${conversationId}:${continuationId}`})::uuid,
         ${String(row.project_id)}, ${connectionId}::uuid, 'resume_wait',
         ${JSON.stringify(payload)}::jsonb,
         ${`wait:${conversationId}:${continuationId}`}, ${resumeAt})
      ON CONFLICT (project_id, idempotency_key) DO NOTHING
      RETURNING id
    `)
    inserted += result.rows.length
  }
  return inserted
}

function messageContent(row: Row) {
  const content = jsonObject(row.content_json)
  return {
    text: String(content.text ?? ""),
    attachments: Array.isArray(content.attachments)
      ? (content.attachments as NormalizedAttachment[])
      : [],
    metadata: jsonObject(content.metadata),
    externalConversationId: content.externalConversationId
      ? String(content.externalConversationId)
      : undefined,
  }
}

function publicMessageMetadata(metadata: Record<string, unknown>) {
  const allowed = new Set([
    "widget",
    "widgetDefinition",
    "ui",
    "widgetId",
    "items",
    "continuations",
    "completedContinuationId",
  ])
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => allowed.has(key))
  )
}

async function reconcileCampaignReply(
  database: TracerDatabase,
  projectId: string,
  contactId: string,
  channel: string,
  conversationId: string
) {
  const result = await database.execute<{
    id: string
    audience_id: string
    campaign_id: string
  }>(sql`
    update build_campaign_deliveries d
    set state='replied',updated_at=now()
    where d.project_id=${projectId}
      and d.channel=${channel}
      and d.state in ('sent','delivered','read')
      and d.id=(
        select d2.id
        from build_campaign_deliveries d2
        join build_campaign_audience a2 on a2.project_id=d2.project_id and a2.id=d2.audience_id
        where d2.project_id=${projectId} and d2.channel=${channel}
          and a2.contact_id=${contactId} and d2.state in ('sent','delivered','read')
        order by d2.sent_at desc nulls last,d2.created_at desc,d2.id desc
        limit 1
      )
    returning d.id,d.audience_id,d.campaign_id
  `)
  const row = result.rows[0]
  if (!row) return false
  await database.execute(sql`
    update build_campaign_audience set state='replied',updated_at=now()
    where project_id=${projectId} and id=${row.audience_id}
  `)
  await database.execute(sql`
    insert into build_operation_events
      (id,project_id,event_type,conversation_id,contact_id,channel,payload_json)
    values (${operationId("event")},${projectId},'campaign_replied',${conversationId},${contactId},${channel},${JSON.stringify({ deliveryId: row.id })}::jsonb)
  `)
  await reconcileCampaignStatus(database, projectId, row.campaign_id)
  return true
}

async function reconcileCampaignDeliverySuccess(
  database: TracerDatabase,
  projectId: string,
  messageId: string,
  providerMessageId: string | null
) {
  const message = await database.execute<{
    delivery_id: string | null
    campaign_id: string | null
    contact_id: string | null
    conversation_id: string
    channel: string
  }>(sql`
    select m.content_json->'metadata'->>'campaignDeliveryId' as delivery_id,
           m.content_json->'metadata'->>'campaignId' as campaign_id,
           m.contact_id,m.conversation_id,c.channel
    from build_channel_message m
    join build_channel_connection c on c.project_id=m.project_id and c.id=m.connection_id
    where m.project_id=${projectId} and m.id=${messageId}
    limit 1
  `)
  const messageRow = message.rows[0]
  if (!messageRow) return
  const delivery = messageRow.delivery_id
    ? await database.execute<{
        id: string
        audience_id: string
        campaign_id: string
      }>(sql`
        update build_campaign_deliveries
        set state='sent',provider_message_id=coalesce(${providerMessageId},provider_message_id),sent_at=coalesce(sent_at,now()),updated_at=now(),last_error=null
        where project_id=${projectId} and id=${messageRow.delivery_id} and state='sending'
        returning id,audience_id,campaign_id
      `)
    : {
        rows: [] as Array<{
          id: string
          audience_id: string
          campaign_id: string
        }>,
      }
  const deliveryRow = delivery.rows[0]
  if (deliveryRow) {
    await database.execute(sql`
      update build_campaign_audience set state='sent',updated_at=now()
      where project_id=${projectId} and id=${deliveryRow.audience_id}
    `)
    await database.execute(sql`
      insert into build_operation_events
        (id,project_id,event_type,conversation_id,contact_id,channel,payload_json)
      values (${operationId("event")},${projectId},'campaign_sent',${messageRow.conversation_id},${messageRow.contact_id},${messageRow.channel},${JSON.stringify({ deliveryId: deliveryRow.id, providerMessageId })}::jsonb)
    `)
  }
  await database.execute(sql`
    insert into build_operation_events
      (id,project_id,event_type,conversation_id,contact_id,channel,payload_json)
    values (${operationId("event")},${projectId},'message_sent',${messageRow.conversation_id},${messageRow.contact_id},${messageRow.channel},${JSON.stringify({ messageId, providerMessageId, campaignDeliveryId: messageRow.delivery_id })}::jsonb)
  `)
  if (deliveryRow)
    await reconcileCampaignStatus(database, projectId, deliveryRow.campaign_id)
}

async function reconcileCampaignDeliveryFailure(
  database: TracerDatabase,
  job: ClaimedChannelJob,
  message: string,
  terminal: boolean,
  delaySeconds: number
) {
  if (job.kind !== "deliver_outbound" || !job.messageId) return
  const source = await database.execute<{
    delivery_id: string | null
    campaign_id: string | null
    audience_id: string | null
    conversation_id: string
    contact_id: string | null
    channel: string
  }>(sql`
    select m.content_json->'metadata'->>'campaignDeliveryId' as delivery_id,
           d.campaign_id,
           a.id as audience_id,m.conversation_id,m.contact_id,c.channel
    from build_channel_message m
    join build_channel_connection c on c.project_id=m.project_id and c.id=m.connection_id
    left join build_campaign_deliveries d on d.project_id=m.project_id and d.id=(m.content_json->'metadata'->>'campaignDeliveryId')
    left join build_campaign_audience a on a.project_id=d.project_id and a.id=d.audience_id
    where m.project_id=${job.projectId} and m.id=${job.messageId}
    limit 1
  `)
  const row = source.rows[0]
  if (!row?.delivery_id) return
  const state = terminal ? "failed" : "queued"
  const updated = await database.execute(sql`
    update build_campaign_deliveries
    set state=${state},last_error=${message.slice(0, 4_000)},next_attempt_at=now()+(${delaySeconds} || ' seconds')::interval,updated_at=now()
    where project_id=${job.projectId} and id=${row.delivery_id} and state='sending'
  `)
  if (!updated.rowCount) return
  if (row.audience_id) {
    await database.execute(
      sql`update build_campaign_audience set state=${state},updated_at=now() where project_id=${job.projectId} and id=${row.audience_id}`
    )
  }
  await database.execute(sql`
    insert into build_operation_events
      (id,project_id,event_type,conversation_id,contact_id,channel,payload_json)
    values (${operationId("event")},${job.projectId},'agent_failed',${row.conversation_id},${row.contact_id},${row.channel},${JSON.stringify({ deliveryId: row.delivery_id, error: message.slice(0, 500), terminal })}::jsonb)
  `)
  if (row.campaign_id)
    await reconcileCampaignStatus(database, job.projectId, row.campaign_id)
}

/**
 * Runtime owns the canonical agent_failed event. A channel worker still needs
 * a durable fallback when a custom runner fails before it can enter the
 * runtime, but retries of the same inbound job must never add another event.
 */
async function recordChannelAgentFailure(
  database: TracerDatabase,
  job: ClaimedChannelJob,
  message: Row,
  error: unknown
) {
  const requestKey = `channel:${job.id}`
  const turnResult = await database.execute<{ id: string }>(sql`
    SELECT id
    FROM build_conversation_turns
    WHERE project_id = ${job.projectId}
      AND conversation_id = ${String(message.conversation_id)}
      AND request_key = ${requestKey}
    LIMIT 1
  `)
  const turnId = turnResult.rows[0]?.id ?? null
  if (turnId) {
    const canonical = await database.execute<{ id: string }>(sql`
      SELECT id
      FROM build_operation_events
      WHERE project_id = ${job.projectId}
        AND event_type = 'agent_failed'
        AND conversation_id = ${String(message.conversation_id)}
        AND payload_json->>'turnId' = ${turnId}
      LIMIT 1
    `)
    if (canonical.rows[0]) return
  }
  await database.execute(sql`
    INSERT INTO build_operation_events
      (id, project_id, event_type, conversation_id, contact_id, channel, payload_json)
    VALUES
      (${`channel_agent_failed_${job.id}`}, ${job.projectId}, 'agent_failed',
       ${String(message.conversation_id)}, ${message.contact_id ?? null},
       ${String(message.channel)},
       ${JSON.stringify({
         jobId: job.id,
         requestKey,
         turnId,
         error: safeChannelError(error),
         code: channelErrorCode(error),
       })}::jsonb)
    ON CONFLICT (id) DO NOTHING
  `)
}

async function processWaitJob(
  context: BuildContext,
  loaded: Awaited<ReturnType<typeof getChannelConnection>>,
  job: ClaimedChannelJob,
  database: TracerDatabase,
  resumeWait: ResumeWaitRunner
) {
  if (job.messageId)
    throw new Error("A wait job cannot reference a channel message.")
  const conversationId =
    typeof job.payload.conversationId === "string"
      ? job.payload.conversationId.trim()
      : ""
  const continuationId =
    typeof job.payload.continuationId === "string"
      ? job.payload.continuationId.trim()
      : ""
  if (!conversationId || !continuationId)
    throw new Error("A wait job is missing its conversation continuation.")
  const conversationResult = await database.execute<Row>(sql`
    SELECT c.id,
           c.agent_id,
           c.channel,
           c.owner_type,
           c.external_conversation_id,
           c.metadata_json
    FROM build_conversations c
    WHERE c.project_id = ${job.projectId}
      AND c.id = ${conversationId}
    LIMIT 1
  `)
  const conversation = conversationResult.rows[0]
  if (!conversation) throw new Error("Wait conversation was not found.")
  const metadata = jsonObject(conversation.metadata_json)
  if (String(metadata.connectionId ?? "") !== job.connectionId)
    throw new Error("Wait job connection no longer matches its conversation.")
  if (String(conversation.agent_id) !== loaded.connection.agentId)
    throw new Error("Wait job agent no longer matches its connection.")
  if (String(conversation.channel) !== loaded.connection.channel)
    throw new Error("Wait job channel no longer matches its connection.")
  await assertChannelJobReady(database, job, {
    agentId: String(conversation.agent_id),
    channel: loaded.connection.channel,
  })
  // Human takeover is an authoritative fence. Do not resume an AI procedure
  // while an operator owns the conversation; the durable continuation remains
  // available for an authenticated handback/resume operation.
  if (String(conversation.owner_type) === "human") {
    const recovered = await recoverRuntimeHandoff(
      context,
      loaded,
      job,
      database,
      {
        conversationId,
        externalConversationId: String(
          conversation.external_conversation_id ?? ""
        ),
        idempotencyKey: `wait:${conversationId}:${continuationId}`,
      }
    )
    if (recovered && "outputMessages" in recovered)
      return { ...recovered, status: "handed_off" as const }
    if (recovered) return { skipped: true, reason: "human_ownership" as const }
    return { skipped: true, reason: "human_ownership" as const }
  }
  const result = await resumeWait({
    agentId: String(conversation.agent_id),
    channel: loaded.connection.channel,
    conversationId,
    ...(conversation.external_conversation_id == null
      ? {}
      : {
          externalConversationId: String(conversation.external_conversation_id),
        }),
    continuationId,
    requestKey: `channel:${job.id}`,
  })
  if (result.status === "busy")
    throw Object.assign(
      new Error("The conversation is processing another turn."),
      {
        code: "CONVERSATION_BUSY",
        retryAfterSeconds: 2,
      }
    )
  await assertChannelJobReady(database, job, {
    agentId: String(conversation.agent_id),
    channel: loaded.connection.channel,
  })
  return {
    ...(await enqueueAgentTurnResult(
      context,
      result,
      `wait:${conversationId}:${continuationId}`
    )),
    status: result.status,
  }
}

export async function processChannelJob(
  job: ClaimedChannelJob,
  runner: AgentTurnRunner,
  database: TracerDatabase,
  options: { resumeWait?: ResumeWaitRunner } = {}
) {
  const context = { database, projectId: job.projectId } satisfies BuildContext
  const loaded = await getChannelConnection(context, job.connectionId, {
    includeSecret: true,
  })
  await assertChannelJobReady(database, job, {
    agentId: loaded.connection.agentId,
    channel: loaded.connection.channel,
  })
  if (job.kind === "telegram_poll")
    return processTelegramPoll(context, loaded, job, database)
  if (job.kind === "resume_wait") {
    if (!options.resumeWait)
      throw new Error("A wait job requires the authenticated wait runner.")
    return processWaitJob(context, loaded, job, database, options.resumeWait)
  }
  if (!job.messageId) throw new Error("Channel job is missing its message.")
  const messageResult = await database.execute<Row>(sql`
    SELECT m.*, c.agent_id, c.channel, c.owner_type, c.owner_fence,
           c.external_conversation_id AS conversation_external_id,
           c.metadata_json AS conversation_metadata_json
    FROM build_channel_message m
    JOIN build_conversations c ON c.project_id = m.project_id AND c.id = m.conversation_id
    WHERE m.project_id = ${job.projectId} AND m.id = ${job.messageId}
    LIMIT 1
  `)
  const message = messageResult.rows[0]
  if (!message) throw new Error("Channel message was not found.")
  if (String(message.connection_id) !== job.connectionId) {
    throw new Error("Channel job connection no longer matches its message.")
  }
  if (
    String(message.agent_id) !== loaded.connection.agentId ||
    String(message.channel) !== loaded.connection.channel
  ) {
    throw new Error(
      "Channel job agent or channel no longer matches its connection."
    )
  }
  if (
    String(
      jsonObject(message.conversation_metadata_json).connectionId ?? ""
    ) !== job.connectionId
  ) {
    throw new Error(
      "Channel job connection no longer matches its conversation."
    )
  }
  await assertChannelJobReady(database, job, {
    agentId: String(message.agent_id),
    channel: loaded.connection.channel,
  })
  if (job.kind === "deliver_outbound") {
    if (
      ["sent", "delivered"].includes(String(message.status)) &&
      message.provider_message_id != null
    ) {
      return {
        sentMessageIds: [String(message.provider_message_id)],
        deduplicated: true,
      }
    }
    const content = messageContent(message)
    let ids: string[] = []
    if (loaded.connection.channel === "whatsapp") {
      const source = jsonObject(message.content_json)
      if (
        source.expectedOwnerFence !== undefined &&
        (Number(source.expectedOwnerFence) !== Number(message.owner_fence) ||
          String(source.expectedOwnerType ?? "ai") !==
            String(message.owner_type))
      ) {
        await database.execute(
          sql`UPDATE build_channel_message SET status='ignored',error_code='OWNERSHIP_CHANGED',error_message='Conversation ownership changed before delivery.' WHERE project_id=${job.projectId} AND id=${job.messageId}`
        )
        return { ignored: true, reason: "human_ownership" }
      }
    }
    if (loaded.connection.channel === "telegram") {
      await assertChannelJobReady(database, job, {
        agentId: String(message.agent_id),
        channel: loaded.connection.channel,
      })
      const token = String(
        loaded.credentials?.token ?? loaded.credentials?.botToken ?? ""
      )
      ids = await sendTelegramEnvelope(
        createTelegramApi(token),
        {
          connectionId: job.connectionId,
          conversationId: String(message.conversation_id),
          channel: "telegram",
          idempotencyKey: String(message.idempotency_key),
          contactId:
            message.contact_id == null ? undefined : String(message.contact_id),
          text: content.text,
          attachments: content.attachments,
        },
        String(
          content.externalConversationId ?? message.conversation_external_id
        )
      )
    } else if (loaded.connection.channel === "whatsapp") {
      ids = await sendWhatsAppEnvelope(
        context,
        {
          connectionId: job.connectionId,
          conversationId: String(message.conversation_id),
          channel: "whatsapp",
          idempotencyKey: String(message.idempotency_key),
          text: content.text,
          attachments: content.attachments,
          metadata: content.metadata,
        },
        String(
          content.externalConversationId ?? message.conversation_external_id
        ),
        String(message.id)
      )
    } else if (loaded.connection.channel !== "web") {
      throw new Error("This channel does not have an outbound adapter yet.")
    }

    try {
      await assertChannelJobReady(database, job, {
        agentId: String(message.agent_id),
        channel: loaded.connection.channel,
      })
      await database.execute(sql`
        UPDATE build_channel_message
        SET status = CASE WHEN status IN ('delivered','failed') THEN status ELSE 'sent' END, provider_message_id = ${ids[0] ?? null}, updated_at = now()
        WHERE project_id = ${job.projectId} AND id = ${job.messageId}
      `)
      if (loaded.connection.channel === "whatsapp" && ids[0]) {
        await database.execute(
          sql`UPDATE build_channel_message m SET status=CASE WHEN r.status='read' THEN 'delivered' ELSE r.status END,error_code=CASE WHEN r.status='failed' THEN 'WHATSAPP_' || COALESCE(r.error_code,'DELIVERY_FAILED') ELSE NULL END,error_message=CASE WHEN r.status='failed' THEN 'WhatsApp reported a delivery failure.' ELSE NULL END,content_json=jsonb_set(m.content_json,'{whatsappDelivery}',jsonb_build_object('status',r.status,'occurredAt',r.occurred_at)) FROM build_whatsapp_receipt r WHERE m.project_id=${job.projectId} AND m.id=${job.messageId} AND r.project_id=m.project_id AND r.connection_id=m.connection_id AND r.provider_message_id=${ids[0]}`
        )
      }
      await database.execute(sql`
        UPDATE build_conversations SET last_message_at = now()
        WHERE project_id = ${job.projectId} AND id = ${message.conversation_id}
      `)
      await assertChannelJobReady(database, job, {
        agentId: String(message.agent_id),
        channel: loaded.connection.channel,
      })
      await database.execute(sql`
        UPDATE build_channel_connection SET last_outbound_at = now()
        WHERE project_id = ${job.projectId} AND id = ${job.connectionId}::uuid
      `)
      await assertChannelJobReady(database, job, {
        agentId: String(message.agent_id),
        channel: loaded.connection.channel,
      })
      await reconcileCampaignDeliverySuccess(
        database,
        job.projectId,
        String(message.id),
        ids[0] ?? null
      )
      return { sentMessageIds: ids }
    } catch (error) {
      // A successful provider write followed by a lost lease or database
      // failure cannot be replayed safely because Telegram has no idempotency
      // key. Keep the job uncertain even when the provider call itself did not
      // report an error.
      if (
        ids.length &&
        !(
          error &&
          typeof error === "object" &&
          "uncertain" in error &&
          error.uncertain === true
        )
      )
        throw new ChannelLeaseLostError()
      throw error
    }
  }
  if (String(message.owner_type) === "human") {
    await assertChannelJobReady(database, job, {
      agentId: String(message.agent_id),
      channel: loaded.connection.channel,
    })
    const recovered = await recoverRuntimeHandoff(
      context,
      loaded,
      job,
      database,
      {
        conversationId: String(message.conversation_id),
        externalConversationId: String(message.conversation_external_id ?? ""),
        contactId:
          message.contact_id == null ? undefined : String(message.contact_id),
        messageId: job.messageId,
        idempotencyKey: `reply:${job.messageId}:0`,
      }
    )
    if (recovered) return recovered
    await database.execute(
      sql`UPDATE build_channel_message SET status = 'ignored' WHERE project_id = ${job.projectId} AND id = ${job.messageId}`
    )
    return { ignored: true, reason: "human_ownership" }
  }
  const ownerFence = Number(message.owner_fence ?? 0)
  const historyRows = await database.execute<Row>(sql`
    SELECT m.direction, m.content_json
    FROM build_channel_message m
    WHERE m.project_id = ${job.projectId}
      AND m.conversation_id = ${message.conversation_id}
      AND m.created_at < ${message.created_at}
    ORDER BY m.created_at ASC, m.id ASC
    LIMIT 100
  `)
  let output: Awaited<ReturnType<AgentTurnRunner>>
  try {
    await assertChannelJobReady(database, job, {
      agentId: String(message.agent_id),
      channel: loaded.connection.channel,
    })
    output = await runner({
      projectId: job.projectId,
      agentId: String(message.agent_id),
      conversationId: String(message.conversation_id),
      channel: loaded.connection.channel,
      contactId: String(message.contact_id ?? ""),
      messages: [
        ...historyRows.rows.map((row) => {
          const content = messageContent(row)
          const role: "user" | "assistant" =
            row.direction === "inbound" ? "user" : "assistant"
          return {
            role,
            content: content.text,
            attachments: content.attachments,
          }
        }),
        (() => {
          const content = messageContent(message)
          return {
            role: "user" as const,
            content: content.text,
            attachments: content.attachments,
          }
        })(),
      ],
      metadata: {
        ...jsonObject(job.payload),
        requestKey: `channel:${job.id}`,
        externalConversationId: String(message.conversation_external_id ?? ""),
      },
    })
  } catch (error) {
    await assertChannelJobReady(database, job, {
      agentId: String(message.agent_id),
      channel: loaded.connection.channel,
    })
    await recordChannelAgentFailure(database, job, message, error).catch(
      () => undefined
    )
    throw error
  }
  // Human takeover can happen while the runner is executing. The owner fence
  // makes that handoff authoritative: never enqueue a response produced under
  // an ownership epoch that has since changed.
  await assertChannelJobReady(database, job, {
    agentId: String(message.agent_id),
    channel: loaded.connection.channel,
  })
  const ownership = await database.execute<{
    owner_type: string
    owner_fence: number | string
  }>(sql`
    SELECT owner_type, owner_fence
    FROM build_conversations
    WHERE project_id = ${job.projectId} AND id = ${message.conversation_id}
    LIMIT 1
  `)
  const currentOwner = ownership.rows[0]
  const outputOwnerFence = output.ownerFence ?? ownerFence
  // A runtime handoff has already committed the human ownership transition
  // before returning. Only that explicit ownership+ownerType pair may use the
  // post-handoff fence; an arbitrary human marker still has to pass the AI
  // fence and the authenticated claim below.
  const runtimeHandoff =
    output.ownership === "human" && output.ownerType === "human"
  const incompatibleOwnerType =
    output.ownership === "human" &&
    output.ownerType !== undefined &&
    output.ownerType !== "human"
  if (
    incompatibleOwnerType ||
    !currentOwner ||
    String(currentOwner.owner_type) !== (runtimeHandoff ? "human" : "ai") ||
    Number(currentOwner.owner_fence) !== outputOwnerFence
  ) {
    await database.execute(sql`
      UPDATE build_channel_message
      SET status = 'ignored'
      WHERE project_id = ${job.projectId} AND id = ${job.messageId}
    `)
    return { ignored: true, reason: "human_ownership" }
  }
  let deliveryOwnerType: "ai" | "human" = runtimeHandoff ? "human" : "ai"
  let deliveryOwnerFence = outputOwnerFence
  if (output.ownership === "human" && !runtimeHandoff) {
    await assertChannelJobReady(database, job, {
      agentId: String(message.agent_id),
      channel: loaded.connection.channel,
    })
    const actorId =
      typeof output.metadata?.actorId === "string" &&
      output.metadata.actorId.trim()
        ? output.metadata.actorId
        : "system"
    try {
      const handedOff = await new ConversationService(context).claim(
        String(message.conversation_id),
        { type: "human", id: actorId, reason: "Agent handoff action" },
        { expectedOwnerFence: ownerFence, expectedOwnerType: "ai" }
      )
      deliveryOwnerType = handedOff.ownerType
      deliveryOwnerFence = handedOff.ownerFence
    } catch (error) {
      if (!(error instanceof ConversationOwnershipLostError)) throw error
      await database.execute(sql`
        UPDATE build_channel_message
        SET status = 'ignored'
        WHERE project_id = ${job.projectId} AND id = ${job.messageId}
      `)
      return { ignored: true, reason: "human_ownership" }
    }
  }
  const runtimeTurn = await database.execute<{
    output_message_id: string | null
  }>(sql`
    SELECT output_message_id FROM build_conversation_turns
    WHERE project_id = ${job.projectId}
      AND conversation_id = ${String(message.conversation_id)}
      AND request_key = ${`channel:${job.id}`}
    LIMIT 1
  `)
  for (const [index, response] of output.messages.entries()) {
    await assertChannelJobReady(database, job, {
      agentId: String(message.agent_id),
      channel: loaded.connection.channel,
    })
    const admission = await enqueueOutboundEnvelope(
      context,
      {
        connectionId: job.connectionId,
        conversationId: String(message.conversation_id),
        contactId:
          message.contact_id == null ? undefined : String(message.contact_id),
        channel: loaded.connection.channel,
        idempotencyKey: `reply:${job.messageId}:${index}`,
        text: response.text,
        attachments: response.attachments,
        metadata: response.metadata,
      },
      String(message.conversation_external_id),
      {
        expectedOwnerFence: deliveryOwnerFence,
        expectedOwnerType: deliveryOwnerType,
        runtimeMessageId: runtimeTurn.rows[0]?.output_message_id ?? undefined,
      }
    )
    if (admission.reason === "ownership_changed") {
      await database.execute(sql`
        UPDATE build_channel_message
        SET status = 'ignored'
        WHERE project_id = ${job.projectId} AND id = ${job.messageId}
      `)
      return { ignored: true, reason: "human_ownership" }
    }
  }
  await assertChannelJobReady(database, job, {
    agentId: String(message.agent_id),
    channel: loaded.connection.channel,
  })
  await database.execute(
    sql`UPDATE build_channel_message SET status = 'delivered' WHERE project_id = ${job.projectId} AND id = ${job.messageId}`
  )
  return { outputMessages: output.messages.length }
}

async function processTelegramPoll(
  context: BuildContext,
  loaded: Awaited<ReturnType<typeof getChannelConnection>>,
  job: ClaimedChannelJob,
  database: TracerDatabase
) {
  if (loaded.connection.channel !== "telegram")
    throw new Error("Polling job is not Telegram.")
  await assertChannelJobReady(database, job, {
    agentId: loaded.connection.agentId,
    channel: "telegram",
  })
  const token = String(
    loaded.credentials?.token ?? loaded.credentials?.botToken ?? ""
  )
  const updates = await createTelegramApi(token).getUpdates(
    loaded.pollingOffset == null ? undefined : loaded.pollingOffset + 1
  )
  let offset = loaded.pollingOffset
  for (const update of updates) {
    await assertChannelJobReady(database, job, {
      agentId: loaded.connection.agentId,
      channel: "telegram",
    })
    offset = Math.max(offset ?? -1, update.update_id)
    const envelope = normalizeTelegramUpdate(loaded.connection.id, update)
    if (envelope) await enqueueInboundEnvelope(context, envelope)
  }
  await assertChannelJobReady(database, job, {
    agentId: loaded.connection.agentId,
    channel: "telegram",
  })
  await database.execute(sql`
    UPDATE build_channel_connection SET polling_offset = ${offset}, last_error = NULL, status = 'connected'
    WHERE project_id = ${context.projectId} AND id = ${loaded.connection.id}::uuid
  `)
  return { updates: updates.length, offset }
}

/** Verifies the Telegram header without exposing or comparing the secret in errors. */
export async function verifyTelegramWebhookSecret(
  context: BuildContext,
  connectionId: string,
  supplied: string | null
) {
  if (!supplied) return false
  const loaded = await getChannelConnection(context, connectionId, {
    includeSecret: true,
  })
  if (
    loaded.connection.channel !== "telegram" ||
    loaded.connection.status !== "connected" ||
    !loaded.webhookSecret
  )
    return false
  const { timingSafeStringEquals } = await import("@/src/lib/build/channels")
  return timingSafeStringEquals(supplied, loaded.webhookSecret)
}

function publicOrigin(requestOrigin: string | null | undefined) {
  if (!requestOrigin) return undefined
  try {
    return new URL(requestOrigin).origin
  } catch {
    throw new Error("Origin must be an absolute URL.")
  }
}

function hostedPublicOrigin() {
  const base = process.env.DATOOL_PUBLIC_URL ?? process.env.BETTER_AUTH_URL
  if (!base) return undefined
  try {
    return new URL(base).origin
  } catch {
    return undefined
  }
}

/** Canonical origin used by same-origin public chat requests. Next may
 * normalize loopback hostnames in request URLs, while the browser keeps the
 * configured public hostname in its Origin header. */
export function publicServerOrigin() {
  return hostedPublicOrigin()
}

function configuredPublicOrigins(connection: ChannelConnection) {
  return Array.isArray(connection.config.originAllowlist)
    ? connection.config.originAllowlist.flatMap((value) => {
        if (typeof value !== "string") return []
        try {
          return [new URL(value).origin]
        } catch {
          return []
        }
      })
    : []
}

/** Header value used by the hosted chat page. The proxy must set this on the
 * actual /chat/:connectionId response; meta tags cannot enforce frame-ancestors. */
export function publicChatContentSecurityPolicy(connection: ChannelConnection) {
  if (connection.channel !== "web" || connection.status !== "connected")
    return "frame-ancestors 'none'"
  const origins = configuredPublicOrigins(connection)
  // An empty allowlist is the intentionally public deployment mode. A
  // configured allowlist is emitted exactly as origins, with 'self' retained
  // for the Datool-hosted iframe's own API origin.
  return origins.length
    ? `frame-ancestors 'self' ${origins.join(" ")}`
    : "frame-ancestors *"
}

/** Resolve policy data for the Next proxy without exposing credentials. */
export async function getPublicChatFramePolicy(connectionId: string) {
  const context = await publicConnectionContext(connectionId)
  const loaded = await getChannelConnection(context, connectionId)
  return {
    channel: loaded.connection.channel,
    status: loaded.connection.status,
    contentSecurityPolicy: publicChatContentSecurityPolicy(loaded.connection),
  }
}

/** Validate an actual browser Origin for CORS preflight without accepting a
 * caller-controlled parent-frame header. */
export async function assertPublicRequestOrigin(
  connectionId: string,
  requestOrigin: string | null,
  sameOrigin?: string
) {
  const context = await publicConnectionContext(connectionId)
  const loaded = await getChannelConnection(context, connectionId)
  if (loaded.connection.channel !== "web")
    throw new Error("This public deployment is not a web channel.")
  assertConnectedConnection(loaded.connection)
  return assertPublicOrigin(loaded.connection, requestOrigin, sameOrigin)
}

export function assertPublicOrigin(
  connection: ChannelConnection,
  requestOrigin: string | null,
  sameOrigin?: string
) {
  const origin = publicOrigin(requestOrigin)
  const serverOrigin = publicOrigin(sameOrigin)
  const effectiveOrigin = origin ?? serverOrigin
  if (!origin) return serverOrigin
  const configured = configuredPublicOrigins(connection)
  const hosted = hostedPublicOrigin()
  if (
    configured.length &&
    !configured.includes(origin) &&
    origin !== hosted &&
    origin !== serverOrigin
  )
    throw new Error("This channel is not enabled for the request origin.")
  return effectiveOrigin
}

/** Creates a signed browser visitor session without trusting a caller project ID. */
export async function createPublicSession(
  context: BuildContext,
  connectionId: string,
  options: {
    visitorToken?: string
    conversationId?: string
    origin?: string
    sameOrigin?: string
    context?: Record<string, unknown>
    clientKey?: string
  } = {}
) {
  const loaded = await getChannelConnection(context, connectionId)
  if (loaded.connection.channel !== "web")
    throw new Error("This public deployment is not a web channel.")
  assertConnectedConnection(loaded.connection)
  const origin = assertPublicOrigin(
    loaded.connection,
    options.origin ?? null,
    options.sameOrigin
  )
  const appearance = await readBubbleAppearance(context, loaded.connection)
  const visitor = options.visitorToken
    ? verifyVisitorContext(options.visitorToken, { origin, connectionId })
    : {
        visitorId: randomUUID(),
        issuedAt: 0,
        expiresAt: 0,
        origin,
        connectionId,
      }
  if (options.conversationId) {
    if (!options.visitorToken) throw new Error("Invalid visitor context.")
    const resumed = await database(context).execute<Row>(sql`
      UPDATE build_conversations SET status = CASE WHEN status = 'closed' THEN 'active' ELSE status END
      WHERE project_id = ${context.projectId} AND id = ${options.conversationId}
        AND agent_id = ${loaded.connection.agentId} AND status <> 'blocked'
        AND metadata_json->>'visitorId' = ${visitor.visitorId}
        AND metadata_json->>'connectionId' = ${connectionId}
      RETURNING id, metadata_json
    `)
    if (!resumed.rows[0])
      throw new Error("Conversation is not available for this visitor.")
    return {
      conversationId: String(resumed.rows[0].id),
      visitorToken: options.visitorToken,
      visitorId: visitor.visitorId,
      context: jsonObject(jsonObject(resumed.rows[0].metadata_json).context),
      appearance,
    }
  }
  await enforcePublicAdmission(
    context,
    loaded.connection,
    "session",
    options.clientKey
  )
  const contactId = randomUUID()
  const conversationId = randomUUID()
  const contactExternalId = `web:${connectionId}:${visitor.visitorId}`
  const visitorContext = jsonObject(options.context)
  const contact = await database(context).execute<Row>(sql`
    INSERT INTO build_contacts
      (id, project_id, external_id, display_name, metadata_json, last_seen_at)
    VALUES (${contactId}, ${context.projectId}, ${contactExternalId}, '',
      ${JSON.stringify({ origin, channel: "web" })}::jsonb, now())
    ON CONFLICT (project_id, external_id) WHERE external_id IS NOT NULL
    DO UPDATE SET metadata_json = build_contacts.metadata_json || EXCLUDED.metadata_json, last_seen_at = now()
    RETURNING id
  `)
  const persistedContactId = String(contact.rows[0]?.id ?? contactId)
  await database(context).execute(sql`
    INSERT INTO build_contact_identities
      (id, project_id, contact_id, channel, identity_key, metadata_json)
    VALUES (${randomUUID()}, ${context.projectId}, ${persistedContactId}, 'web', ${`${connectionId}:${visitor.visitorId}`}, ${JSON.stringify({ origin })}::jsonb)
    ON CONFLICT (project_id, channel, identity_key)
    DO UPDATE SET contact_id = EXCLUDED.contact_id, metadata_json = build_contact_identities.metadata_json || EXCLUDED.metadata_json, updated_at = now()
  `)
  await database(context).execute(sql`
    INSERT INTO build_conversations
      (id, project_id, agent_id, channel, external_conversation_id, metadata_json)
    SELECT ${conversationId}, ${context.projectId}, agent_id, 'web', ${`${visitor.visitorId}:${conversationId}`},
      ${JSON.stringify({ visitorId: visitor.visitorId, contactId: persistedContactId, connectionId, origin, context: visitorContext })}::jsonb
    FROM build_channel_connection
    WHERE project_id = ${context.projectId} AND id = ${connectionId}::uuid
  `)
  const token =
    options.visitorToken ??
    signVisitorContext({ visitorId: visitor.visitorId, origin, connectionId })
  return {
    conversationId,
    visitorToken: token,
    visitorId: visitor.visitorId,
    context: visitorContext,
    appearance,
  }
}

/** Only the signed visitor's own threads in this deployment are discoverable. */
export async function listPublicConversations(
  context: BuildContext,
  connectionId: string,
  visitorToken: string,
  origin?: string,
  sameOrigin?: string
) {
  const { connection } = await getChannelConnection(context, connectionId)
  if (connection.channel !== "web")
    throw new Error("This public deployment is not a web channel.")
  assertConnectedConnection(connection)
  const effectiveOrigin = assertPublicOrigin(
    connection,
    origin ?? null,
    sameOrigin
  )
  const visitor = verifyVisitorContext(visitorToken, {
    origin: effectiveOrigin,
    connectionId,
  })
  const rows = await database(context).execute<Row>(sql`
    SELECT c.id, first_message.title, latest_message.updated_at
    FROM build_conversations c
    JOIN LATERAL (
      SELECT left(m.content_json->>'text', 120) AS title FROM build_channel_message m
      WHERE m.project_id = c.project_id AND m.conversation_id = c.id AND m.direction = 'inbound'
      ORDER BY m.created_at, m.id LIMIT 1
    ) first_message ON true
    JOIN LATERAL (
      SELECT max(m.created_at) AS updated_at FROM build_channel_message m
      WHERE m.project_id = c.project_id AND m.conversation_id = c.id
    ) latest_message ON true
    WHERE c.project_id = ${context.projectId} AND c.agent_id = ${connection.agentId}
      AND c.metadata_json->>'visitorId' = ${visitor.visitorId}
      AND c.metadata_json->>'connectionId' = ${connectionId} AND c.status <> 'blocked'
    ORDER BY latest_message.updated_at DESC, c.id DESC LIMIT 100
  `)
  return rows.rows.map((row) => ({
    id: String(row.id),
    title: String(row.title || "New chat"),
    updatedAt: timestamp(row.updated_at),
  }))
}

async function readBubbleAppearance(
  context: BuildContext,
  connection: ChannelConnection
) {
  const agent = await database(context).execute<Row>(sql`
    SELECT applied_config_json FROM build_agents
    WHERE project_id = ${context.projectId} AND id = ${connection.agentId} AND status = 'active'
    LIMIT 1
  `)
  if (!agent.rows[0]) throw new Error("This public deployment is unavailable.")
  const configuration = jsonObject(agent.rows[0].applied_config_json)
  return resolveChatBubbleSettings(
    configuration.appearance,
    connection.config.bubble
  )
}

/** Public display configuration only. Never returns agent instructions or credentials. */
export async function getPublicChatAppearance(
  context: BuildContext,
  connectionId: string,
  origin: string | null,
  sameOrigin?: string
) {
  const { connection } = await getChannelConnection(context, connectionId)
  if (connection.channel !== "web")
    throw new Error("This public deployment is not a web channel.")
  assertConnectedConnection(connection)
  const allowedOrigin = assertPublicOrigin(connection, origin, sameOrigin)
  return {
    appearance: await readBubbleAppearance(context, connection),
    allowedOrigin,
  }
}

/** Records public visitor feedback only after the signed visitor owns the conversation. */
export async function recordPublicFeedback(
  context: BuildContext,
  connectionId: string,
  conversationId: string,
  visitorToken: string,
  input: {
    question: string
    sentiment: "positive" | "negative" | "unknown"
    messageId?: string
    reason?: string
    origin?: string
    sameOrigin?: string
    clientKey?: string
  }
) {
  const loaded = await getChannelConnection(context, connectionId)
  if (loaded.connection.channel !== "web")
    throw new Error("This public deployment is not a web channel.")
  assertConnectedConnection(loaded.connection)
  const origin = assertPublicOrigin(
    loaded.connection,
    input.origin ?? null,
    input.sameOrigin
  )
  const visitor = verifyVisitorContext(visitorToken, { origin, connectionId })
  await enforcePublicAdmission(
    context,
    loaded.connection,
    "feedback",
    input.clientKey
  )
  const ownership = await database(context).execute<Row>(sql`
    SELECT 1
    FROM build_conversations
    WHERE project_id = ${context.projectId}
      AND id = ${conversationId}
      AND agent_id = ${loaded.connection.agentId}
      AND metadata_json->>'visitorId' = ${visitor.visitorId}
      AND metadata_json->>'connectionId' = ${connectionId}
    LIMIT 1
  `)
  if (!ownership.rows[0])
    throw new Error("Conversation is not available for this visitor.")
  if (input.messageId) {
    const message = await database(context).execute<Row>(sql`
      SELECT 1 FROM build_channel_message
      WHERE project_id = ${context.projectId}
        AND connection_id = ${connectionId}::uuid
        AND conversation_id = ${conversationId}
        AND id::text = ${input.messageId}
        AND direction = 'outbound'
      LIMIT 1
    `)
    if (!message.rows[0])
      throw new Error("Message is not available for this visitor.")
  }
  const { recordFeedback } = await import("../operations/analytics")
  return recordFeedback(context, {
    conversationId,
    channel: "web",
    question: input.question,
    messageId: input.messageId,
    sentiment: input.sentiment,
    reason: input.reason,
    metadata: input.messageId ? { messageId: input.messageId } : {},
  })
}

export async function enqueuePublicMessage(
  context: BuildContext,
  connectionId: string,
  conversationId: string,
  visitorToken: string,
  input: {
    text: string
    attachments?: NormalizedAttachment[]
    origin?: string
    sameOrigin?: string
    idempotencyKey?: string
    metadata?: Record<string, unknown>
    clientKey?: string
  }
) {
  const loaded = await getChannelConnection(context, connectionId)
  if (loaded.connection.channel !== "web")
    throw new Error("This public deployment is not a web channel.")
  assertConnectedConnection(loaded.connection)
  if (input.attachments?.length)
    throw new Error("Public web attachments are not supported.")
  const origin = assertPublicOrigin(
    loaded.connection,
    input.origin ?? null,
    input.sameOrigin
  )
  const visitor = verifyVisitorContext(visitorToken, { origin, connectionId })
  await enforcePublicAdmission(
    context,
    loaded.connection,
    "message",
    input.clientKey
  )
  const ownership = await database(context).execute<Row>(sql`
    SELECT c.id, c.status, c.owner_type, c.agent_id, c.external_conversation_id
    FROM build_conversations c
    WHERE c.project_id = ${context.projectId}
      AND c.id = ${conversationId} AND c.metadata_json->>'visitorId' = ${visitor.visitorId}
      AND c.metadata_json->>'connectionId' = ${connectionId}
    LIMIT 1
  `)
  const conversation = ownership.rows[0]
  if (!conversation)
    throw new Error("Conversation is not available for this visitor.")
  if (String(conversation.agent_id) !== loaded.connection.agentId)
    throw new Error("Conversation agent does not match its channel connection.")
  if (String(conversation.status) === "closed")
    throw new Error("Conversation is closed.")
  const id = input.idempotencyKey?.trim()
    ? `${visitor.visitorId}:${input.idempotencyKey.trim().slice(0, 200)}`
    : randomUUID()
  const envelope: InboundEnvelope = {
    connectionId,
    channel: "web",
    providerEventId: id,
    providerMessageId: id,
    externalConversationId: String(
      conversation.external_conversation_id ?? conversationId
    ),
    externalContactId: visitor.visitorId,
    receivedAt: new Date().toISOString(),
    text: input.text,
    attachments: input.attachments ?? [],
    contact: { externalId: visitor.visitorId, metadata: { origin } },
    metadata: {
      visitorId: visitor.visitorId,
      origin,
      ...jsonObject(input.metadata),
    },
  }
  return enqueueInboundEnvelope(context, envelope)
}

export async function readPublicConversation(
  context: BuildContext,
  connectionId: string,
  conversationId: string,
  visitorToken: string,
  origin?: string,
  sameOrigin?: string
) {
  const loaded = await getChannelConnection(context, connectionId)
  if (loaded.connection.channel !== "web")
    throw new Error("This public deployment is not a web channel.")
  assertConnectedConnection(loaded.connection)
  const effectiveOrigin = assertPublicOrigin(
    loaded.connection,
    origin ?? null,
    sameOrigin
  )
  const visitor = verifyVisitorContext(visitorToken, {
    origin: effectiveOrigin,
    connectionId,
  })
  const rows = await database(context).execute<Row>(sql`
    SELECT m.id, m.direction, m.status, m.content_json, m.provider_message_id, m.created_at,
      (c.owner_type = 'ai' AND c.status = 'active' AND m.direction = 'inbound' AND EXISTS (
        SELECT 1 FROM build_channel_job j WHERE j.project_id = m.project_id AND j.message_id = m.id
          AND j.kind = 'process_inbound' AND j.status IN ('queued', 'running')
      )) AS pending_reply
    FROM build_conversations c
    LEFT JOIN build_channel_message m ON m.project_id = c.project_id AND m.conversation_id = c.id
    WHERE c.project_id = ${context.projectId} AND c.id = ${conversationId}
      AND c.agent_id = ${loaded.connection.agentId}
      AND c.metadata_json->>'visitorId' = ${visitor.visitorId}
      AND c.metadata_json->>'connectionId' = ${connectionId}
    ORDER BY m.created_at ASC, m.id ASC
    LIMIT 200
  `)
  if (!rows.rows.length)
    throw new Error("Conversation is not available for this visitor.")
  return rows.rows
    .filter((row) => row.id !== null)
    .map((row) => {
      const content = messageContent(row)
      return {
        id: String(row.id),
        direction: String(row.direction),
        status: String(row.status),
        pendingReply: row.pending_reply === true,
        text: content.text,
        attachments: content.attachments,
        metadata: publicMessageMetadata(content.metadata),
        providerMessageId:
          row.provider_message_id == null
            ? null
            : String(row.provider_message_id),
        createdAt: timestamp(row.created_at),
      }
    })
}

export async function resetPublicConversation(
  context: BuildContext,
  connectionId: string,
  conversationId: string,
  visitorToken: string,
  origin?: string,
  sameOrigin?: string
) {
  const loaded = await getChannelConnection(context, connectionId)
  if (loaded.connection.channel !== "web")
    throw new Error("This public deployment is not a web channel.")
  assertConnectedConnection(loaded.connection)
  const effectiveOrigin = assertPublicOrigin(
    loaded.connection,
    origin ?? null,
    sameOrigin
  )
  const visitor = verifyVisitorContext(visitorToken, {
    origin: effectiveOrigin,
    connectionId,
  })
  await database(context).execute(sql`
    UPDATE build_conversations
    SET status = 'closed'
    WHERE project_id = ${context.projectId} AND id = ${conversationId}
      AND agent_id = ${loaded.connection.agentId}
      AND metadata_json->>'visitorId' = ${visitor.visitorId}
      AND metadata_json->>'connectionId' = ${connectionId}
  `)
  return { conversationId, status: "closed" as const }
}

/** Import an external channel message without scheduling an AI response.
 * Used for Business App echoes, consented history and paused-channel inboxes.
 * The ledger, ownership fence and transcript commit together on every retry. */
export async function recordExternalChannelMessage(
  context: BuildContext,
  envelope: InboundEnvelope,
  options: {
    direction: "inbound" | "outbound"
    takeover?: boolean
    historical?: boolean
  }
) {
  const loaded = await getChannelConnection(context, envelope.connectionId)
  if (
    loaded.connection.channel !== envelope.channel ||
    !["connected", "paused"].includes(loaded.connection.status)
  )
    throw new Error("Channel connection is unavailable.")
  const contactId = await findOrCreateContact(context, envelope)
  const conversation = await findOrCreateConversation(
    context,
    envelope,
    contactId
  )
  return context.database.transaction(async (tx) => {
    const inserted = await tx.execute<Row>(
      sql`INSERT INTO build_channel_message(id,project_id,connection_id,conversation_id,contact_id,direction,provider_message_id,idempotency_key,content_json,status,created_at) VALUES(${randomUUID()},${context.projectId},${envelope.connectionId}::uuid,${conversation.id},${contactId},${options.direction},${envelope.providerMessageId},${`${envelope.channel}:${envelope.providerEventId}`},${JSON.stringify({ text: envelope.text, attachments: envelope.attachments, metadata: envelope.metadata })}::jsonb,'ignored',${envelope.receivedAt}::timestamptz) ON CONFLICT DO NOTHING RETURNING id`
    )
    if (!inserted.rows.length)
      return { deduplicated: true, conversationId: conversation.id }
    const scoped = scopedTracerTransaction(context.database, tx)
    const conversations = new ConversationService({
      ...context,
      database: scoped,
    })
    if (options.takeover)
      await conversations.claim(conversation.id, {
        type: "human",
        id: `whatsapp-business-app:${envelope.connectionId}`,
        reason: "A team member replied from the WhatsApp Business App.",
      })
    const message = await conversations.appendMessage(conversation.id, {
      role: options.direction === "inbound" ? "user" : "assistant",
      content: envelope.text || "[Attachment]",
      status: "completed",
      metadata: {
        ...envelope.metadata,
        attachments: JSON.parse(JSON.stringify(envelope.attachments)),
        providerMessageId: envelope.providerMessageId,
        historical: options.historical ?? false,
        source:
          options.direction === "outbound"
            ? "whatsapp_business_app"
            : "whatsapp",
      },
    })
    await tx.execute(
      sql`UPDATE build_conversation_messages SET created_at=${envelope.receivedAt}::timestamptz WHERE project_id=${context.projectId} AND id=${message.id}`
    )
    if (!options.historical)
      await admitInboundTicket(
        tx,
        context.projectId,
        envelope,
        conversation.id,
        contactId
      )
    return { deduplicated: false, conversationId: conversation.id }
  })
}
