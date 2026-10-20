import { assertPublicHttpUrl } from "../http"
import { createHmac, timingSafeEqual } from "node:crypto"
import {
  metaIdSchema,
  whatsappRecipientSchema,
  whatsappTemplateSchema,
  type WhatsAppTemplate,
} from "@/src/lib/build/whatsapp"
import type {
  InboundEnvelope,
  NormalizedAttachment,
  OutboundEnvelope,
} from "@/src/lib/build/channels"

export class WhatsAppApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly uncertain = false,
    readonly retryAfterSeconds?: number
  ) {
    super(message)
    this.name = "WhatsAppApiError"
  }
}
export function metaConfig() {
  const appId = process.env.DATOOL_META_APP_ID ?? ""
  const appSecret = process.env.DATOOL_META_APP_SECRET ?? ""
  const configId = process.env.DATOOL_META_WHATSAPP_CONFIG_ID ?? ""
  const verifyToken = process.env.DATOOL_META_WEBHOOK_VERIFY_TOKEN ?? ""
  const version = process.env.DATOOL_META_GRAPH_VERSION ?? "v23.0"
  if (!/^v\d+\.0$/.test(version))
    throw new WhatsAppApiError(
      "INVALID_CONFIGURATION",
      "Meta Graph API version is invalid."
    )
  return { appId, appSecret, configId, verifyToken, version }
}
export function verifyWhatsAppSignature(
  body: string | Uint8Array,
  signature: string | null
) {
  const secret = metaConfig().appSecret
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature))
    return false
  const expected = createHmac("sha256", secret).update(body).digest()
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"))
}
export function verifyWhatsAppChallenge(token: string | null) {
  const expected = metaConfig().verifyToken
  if (!expected || !token) return false
  const a = Buffer.from(expected),
    b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}
export async function metaRequest<T>(
  token: string,
  path: string,
  options: {
    method?: "GET" | "POST" | "DELETE"
    body?: Record<string, unknown>
    query?: Record<string, string>
    sending?: boolean
  } = {}
): Promise<T> {
  const { version, appSecret } = metaConfig()
  const url = new URL(`https://graph.facebook.com/${version}/${path}`)
  for (const [key, value] of Object.entries(options.query ?? {}))
    url.searchParams.set(key, value)
  if (appSecret && token && !token.includes("|"))
    url.searchParams.set(
      "appsecret_proof",
      createHmac("sha256", appSecret).update(token).digest("hex")
    )
  let response: Response
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
      cache: "no-store",
    })
  } catch {
    throw new WhatsAppApiError(
      "NETWORK_ERROR",
      "Could not reach WhatsApp. Check the connection and try again.",
      Boolean(options.sending)
    )
  }
  let data: Record<string, unknown>
  try {
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Empty response")
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        length += next.value.byteLength
        if (length > 2 * 1024 * 1024) {
          await reader.cancel()
          throw new Error("Response too large")
        }
        chunks.push(next.value)
      }
    } finally {
      reader.releaseLock()
    }
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("Invalid response")
  } catch {
    throw new WhatsAppApiError(
      "INVALID_PROVIDER_RESPONSE",
      "WhatsApp returned an unreadable response.",
      Boolean(options.sending)
    )
  }
  if (!response.ok || data.error) {
    const error = (data.error ?? {}) as Record<string, unknown>
    const code = Number(error.code)
    if (code === 190 || response.status === 401)
      throw new WhatsAppApiError(
        "INVALID_CREDENTIAL",
        "WhatsApp authorization expired or was revoked. Reconnect this number."
      )
    if (
      response.status === 429 ||
      [4, 17, 80007, 130429, 131056].includes(code)
    )
      throw new WhatsAppApiError(
        "RATE_LIMITED",
        "WhatsApp is limiting messages. Delivery will retry.",
        false,
        Math.min(
          3600,
          Math.max(5, Number(response.headers.get("retry-after")) || 60)
        )
      )
    if (code === 131047)
      throw new WhatsAppApiError(
        "WHATSAPP_WINDOW_CLOSED",
        "The 24-hour reply window has closed. Send an approved template."
      )
    if (response.status >= 500)
      throw new WhatsAppApiError(
        "PROVIDER_UNAVAILABLE",
        "WhatsApp is temporarily unavailable.",
        Boolean(options.sending)
      )
    throw new WhatsAppApiError(
      "WHATSAPP_REJECTED",
      `WhatsApp rejected this request${Number.isSafeInteger(code) ? ` (code ${code})` : ""}. Check the number, permissions and template status.`
    )
  }
  return data as T
}
export async function exchangeWhatsAppCode(code: string) {
  const { appId, appSecret } = metaConfig()
  const result = await metaRequest<{ access_token: string }>(
    `${appId}|${appSecret}`,
    "oauth/access_token",
    {
      method: "POST",
      body: { client_id: appId, client_secret: appSecret, code },
    }
  )
  if (!result.access_token)
    throw new WhatsAppApiError(
      "INVALID_CREDENTIAL",
      "Meta did not return an authorization token."
    )
  const debug = await metaRequest<{
    data: {
      app_id: string
      is_valid: boolean
      scopes?: string[]
      expires_at?: number
      data_access_expires_at?: number
      granular_scopes?: { scope: string; target_ids?: string[] }[]
    }
  }>(`${appId}|${appSecret}`, "debug_token", {
    query: { input_token: result.access_token },
  })
  const data = debug.data
  if (
    !data?.is_valid ||
    data.app_id !== appId ||
    !["whatsapp_business_management", "whatsapp_business_messaging"].every(
      (scope) => data.scopes?.includes(scope)
    )
  )
    throw new WhatsAppApiError(
      "INVALID_CREDENTIAL",
      "Meta did not authorize the required WhatsApp permissions for this app."
    )
  const expiry = Math.min(
    ...[data.expires_at, data.data_access_expires_at].filter(
      (n): n is number => typeof n === "number" && n > 0
    )
  )
  if (Number.isFinite(expiry) && expiry * 1000 <= Date.now())
    throw new WhatsAppApiError(
      "INVALID_CREDENTIAL",
      "The WhatsApp authorization has expired."
    )
  return {
    token: result.access_token,
    expiresAt: Number.isFinite(expiry)
      ? new Date(expiry * 1000).toISOString()
      : null,
    wabaIds:
      data.granular_scopes
        ?.filter((s) => s.scope === "whatsapp_business_management")
        .flatMap((s) => s.target_ids ?? []) ?? [],
  }
}
export function whatsappMessage(
  envelope: OutboundEnvelope,
  recipient: string,
  messageId: string,
  template?: WhatsAppTemplate
) {
  whatsappRecipientSchema.parse(recipient)
  const base = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    biz_opaque_callback_data: messageId,
  }
  if (template)
    return {
      ...base,
      type: "template",
      template: whatsappTemplateSchema.parse(template),
    }
  if (envelope.attachments?.length) {
    if (envelope.attachments.length !== 1 || envelope.text.length > 1024)
      throw new WhatsAppApiError(
        "UNSUPPORTED_ATTACHMENT",
        "Send one WhatsApp attachment at a time, with a caption of at most 1,024 characters."
      )
    const attachment = envelope.attachments[0]
    if (
      !["image", "video", "document", "audio"].includes(attachment.type) ||
      (!attachment.fileId && !attachment.url)
    )
      throw new WhatsAppApiError(
        "UNSUPPORTED_ATTACHMENT",
        "This attachment cannot be sent on WhatsApp."
      )
    if (attachment.type === "audio" && envelope.text)
      throw new WhatsAppApiError(
        "UNSUPPORTED_ATTACHMENT",
        "Audio messages cannot include a text caption."
      )
    if (attachment.url && !attachment.fileId) {
      try {
        if (assertPublicHttpUrl(attachment.url).protocol !== "https:")
          throw new Error("HTTPS required")
      } catch {
        throw new WhatsAppApiError(
          "UNSUPPORTED_ATTACHMENT",
          "Use a public HTTPS URL for WhatsApp attachments."
        )
      }
    }
    return {
      ...base,
      type: attachment.type,
      [attachment.type]: {
        ...(attachment.fileId
          ? { id: metaIdSchema.parse(attachment.fileId) }
          : { link: attachment.url }),
        ...(envelope.text && attachment.type !== "audio"
          ? { caption: envelope.text }
          : {}),
        ...(attachment.type === "document" && attachment.name
          ? { filename: attachment.name }
          : {}),
      },
    }
  }
  if (!envelope.text.trim() || envelope.text.length > 4096)
    throw new WhatsAppApiError(
      "WHATSAPP_INVALID_MESSAGE",
      "WhatsApp text messages must contain between 1 and 4,096 characters."
    )
  return {
    ...base,
    type: "text",
    text: { body: envelope.text, preview_url: false },
    ...(envelope.replyToProviderMessageId
      ? { context: { message_id: envelope.replyToProviderMessageId } }
      : {}),
  }
}
export function normalizeWhatsAppMessage(
  connectionId: string,
  phoneId: string,
  raw: Record<string, unknown>,
  contactName?: string
): InboundEnvelope | null {
  const from = String(raw.from ?? ""),
    id = String(raw.id ?? ""),
    type = String(raw.type ?? "")
  if (["reaction", "system"].includes(type)) return null
  if (!/^[1-9]\d{6,19}$/.test(from) || !id || id.length > 500) return null
  const value = (raw[type] ?? {}) as Record<string, unknown>
  let text = "",
    attachments: NormalizedAttachment[] = []
  if (type === "text") text = String(value.body ?? "")
  else if (type === "button") text = String(value.text ?? value.payload ?? "")
  else if (type === "interactive") {
    const reply = (value.button_reply ??
      value.list_reply ??
      value.nfm_reply ??
      {}) as Record<string, unknown>
    text = String(reply.title ?? reply.body ?? reply.response_json ?? "")
  } else if (
    ["image", "audio", "video", "document", "sticker"].includes(type)
  ) {
    text = String(value.caption ?? "")
    attachments = [
      {
        type:
          type === "sticker" ? "image" : (type as NormalizedAttachment["type"]),
        fileId: String(value.id ?? ""),
        mimeType: String(value.mime_type ?? ""),
        ...(value.filename ? { name: String(value.filename) } : {}),
        metadata: { whatsappPhoneId: phoneId },
      },
    ]
  } else if (type === "location")
    text = `Location: ${value.latitude}, ${value.longitude}${value.name ? ` (${value.name})` : ""}`
  else text = `[Unsupported WhatsApp message: ${type.slice(0, 50)}]`
  const seconds = Number(raw.timestamp)
  if (
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds * 1000 > Date.now() + 60_000
  )
    return null
  return {
    connectionId,
    channel: "whatsapp",
    providerEventId: id,
    providerMessageId: id,
    externalConversationId: `${phoneId}:${from}`,
    externalContactId: `${phoneId}:${from}`,
    receivedAt: new Date(seconds * 1000).toISOString(),
    text: text.slice(0, 100_000),
    attachments,
    contact: {
      externalId: `${phoneId}:${from}`,
      phone: `+${from}`,
      displayName: contactName,
    },
    metadata: {
      whatsappPhoneId: phoneId,
      whatsappRecipientId: from,
      whatsappType: type,
    },
  }
}
