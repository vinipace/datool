import { randomBytes } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { Api, GrammyError, HttpError } from "grammy/web"

import type {
  InboundEnvelope,
  NormalizedAttachment,
  OutboundEnvelope,
} from "@/src/lib/build/channels"

const TELEGRAM_SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/
const TELEGRAM_TEXT_LIMIT = 4096

export type TelegramUser = {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
  language_code?: string
}

export type TelegramMessage = {
  message_id: number
  date?: number
  chat: { id: number; type?: string; title?: string; username?: string; first_name?: string; last_name?: string }
  from?: TelegramUser
  sender_chat?: { id: number; type?: string; title?: string; username?: string; first_name?: string; last_name?: string }
  text?: string
  caption?: string
  photo?: Array<{ file_id: string; width?: number; height?: number }>
  document?: { file_id: string; file_name?: string; mime_type?: string }
  audio?: { file_id: string; file_name?: string; mime_type?: string }
  video?: { file_id: string; mime_type?: string; file_name?: string }
  voice?: { file_id: string; mime_type?: string }
  location?: { latitude: number; longitude: number }
}

export type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  channel_post?: TelegramMessage
  edited_channel_post?: TelegramMessage
}

export class TelegramApiError extends Error {
  readonly code: string
  readonly status: number | undefined
  readonly retryAfterSeconds: number | undefined
  readonly uncertain: boolean

  constructor(options: {
    code: string
    message: string
    status?: number
    retryAfterSeconds?: number
    uncertain?: boolean
  }) {
    super(options.message)
    this.name = "TelegramApiError"
    this.code = options.code
    this.status = options.status
    this.retryAfterSeconds = options.retryAfterSeconds
    this.uncertain = options.uncertain ?? false
  }
}

function assertToken(token: string) {
  if (!/^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(token))
    throw new TelegramApiError({ code: "INVALID_CREDENTIAL", message: "Telegram bot token format is invalid." })
}

// Use grammY's Web API build so both the Node web process and Bun worker use
// their native fetch transport. Datool owns durable jobs; grammY owns Bot API
// requests. Do not enable automatic retries for sends with uncertain delivery.
export function createTelegramApi(token: string) {
  const api = new Api(token, {
    fetch: globalThis.fetch,
    timeoutSeconds: 10,
    baseFetchConfig: { redirect: "error" },
    sensitiveLogs: false,
  })
  async function call<T>(
    operation: () => Promise<T>,
    sending = false
  ): Promise<T> {
    assertToken(token)
    try {
      const result = await operation()
      if (result === undefined || result === null)
        throw new Error("Missing Telegram result")
      return result
    } catch (error) {
      // Library errors retain request payloads and transport errors may contain
      // the token-bearing URL. Only persist our own safe error representation.
      if (error instanceof GrammyError && Number.isInteger(error.error_code)) {
        const code =
          error.error_code === 429
            ? "RATE_LIMITED"
            : error.error_code === 401
              ? "INVALID_CREDENTIAL"
              : "PROVIDER_ERROR"
        throw new TelegramApiError({
          code,
          message:
            code === "RATE_LIMITED"
              ? "Telegram rate limit reached."
              : code === "INVALID_CREDENTIAL"
                ? "Telegram rejected the bot credential."
                : "Telegram rejected the request.",
          status: error.error_code,
          retryAfterSeconds: error.parameters.retry_after,
          uncertain: sending && error.error_code >= 500,
        })
      }
      if (error instanceof HttpError && !(error.error instanceof SyntaxError)) {
        throw new TelegramApiError({
          code: "NETWORK_ERROR",
          message:
            "This server could not reach api.telegram.org. Check its connection to Telegram and try again.",
          uncertain: sending,
        })
      }
      throw new TelegramApiError({
        code: "INVALID_PROVIDER_RESPONSE",
        message: "Telegram returned an invalid response.",
        uncertain: sending,
      })
    }
  }
  // Registration is safe to repeat unless it discards pending updates. Jobs
  // already own polling retries; sends must remain uncertain after a timeout.
  async function register<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call(operation)
      } catch (error) {
        if (
          !(error instanceof TelegramApiError) ||
          error.code !== "NETWORK_ERROR" ||
          attempt >= 2
        )
          throw error
        await delay(250 * 2 ** attempt)
      }
    }
  }
  return {
    getMe: () => register(() => api.getMe()),
    setWebhook: (input: {
      url: string
      secretToken: string
      dropPendingUpdates?: boolean
    }) => {
      const parsed = new URL(input.url)
      if (parsed.protocol !== "https:")
        throw new TelegramApiError({
          code: "INVALID_WEBHOOK",
          message: "Telegram webhooks require an HTTPS URL.",
        })
      if (!TELEGRAM_SECRET_PATTERN.test(input.secretToken))
        throw new TelegramApiError({
          code: "INVALID_WEBHOOK_SECRET",
          message: "Telegram webhook secret has an invalid format.",
        })
      return (input.dropPendingUpdates ? call : register)(() =>
        api.setWebhook(input.url, {
          secret_token: input.secretToken,
          allowed_updates: [
            "message",
            "edited_message",
            "channel_post",
            "edited_channel_post",
          ],
          ...(input.dropPendingUpdates ? { drop_pending_updates: true } : {}),
        })
      )
    },
    deleteWebhook: (dropPendingUpdates = false) =>
      (dropPendingUpdates ? call : register)(() =>
        api.deleteWebhook({ drop_pending_updates: dropPendingUpdates })
      ),
    getUpdates: (offset?: number) =>
      call(() =>
        api.getUpdates({
          ...(offset !== undefined ? { offset } : {}),
          limit: 100,
          timeout: 0,
          allowed_updates: [
            "message",
            "edited_message",
            "channel_post",
            "edited_channel_post",
          ],
        })
      ),
    sendMessage: (chatId: string, text: string, replyToMessageId?: string) =>
      call(
        () =>
          api.sendMessage(chatId, text, {
            ...(replyToMessageId
              ? { reply_parameters: { message_id: Number(replyToMessageId) } }
              : {}),
          }),
        true
      ),
    sendPhoto: (chatId: string, photo: string, caption?: string) =>
      call(
        () =>
          api.sendPhoto(chatId, photo, {
            ...(caption ? { caption: caption.slice(0, 1024) } : {}),
          }),
        true
      ),
    sendDocument: (chatId: string, document: string, caption?: string) =>
      call(
        () =>
          api.sendDocument(chatId, document, {
            ...(caption ? { caption: caption.slice(0, 1024) } : {}),
          }),
        true
      ),
    sendAudio: (chatId: string, audio: string, caption?: string) =>
      call(
        () =>
          api.sendAudio(chatId, audio, {
            ...(caption ? { caption: caption.slice(0, 1024) } : {}),
          }),
        true
      ),
    sendVideo: (chatId: string, video: string, caption?: string) =>
      call(
        () =>
          api.sendVideo(chatId, video, {
            ...(caption ? { caption: caption.slice(0, 1024) } : {}),
          }),
        true
      ),
  }
}

export function newTelegramWebhookSecret() {
  return randomBytes(32).toString("base64url").slice(0, 43)
}

function attachmentForMessage(message: TelegramMessage): NormalizedAttachment[] {
  const attachments: NormalizedAttachment[] = []
  const photo = message.photo?.at(-1)
  if (photo) attachments.push({
    type: "image",
    fileId: photo.file_id,
    metadata: {
      ...(photo.width === undefined ? {} : { width: photo.width }),
      ...(photo.height === undefined ? {} : { height: photo.height }),
    },
  })
  if (message.document) attachments.push({ type: "document", fileId: message.document.file_id, mimeType: message.document.mime_type, name: message.document.file_name })
  if (message.audio) attachments.push({ type: "audio", fileId: message.audio.file_id, mimeType: message.audio.mime_type, name: message.audio.file_name })
  if (message.voice) attachments.push({ type: "audio", fileId: message.voice.file_id, mimeType: message.voice.mime_type })
  if (message.video) attachments.push({ type: "video", fileId: message.video.file_id, mimeType: message.video.mime_type, name: message.video.file_name })
  if (message.location) attachments.push({ type: "location", metadata: message.location })
  return attachments
}

export function normalizeTelegramUpdate(
  connectionId: string,
  update: TelegramUpdate,
  receivedAt = new Date().toISOString(),
): InboundEnvelope | null {
  const message = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post
  if (!message || !message.chat) return null
  const sender = message.from ?? message.sender_chat ?? message.chat
  const contactId = String(sender.id)
  const conversationId = String(message.chat.id)
  const attachments = attachmentForMessage(message)
  const text = message.text ?? message.caption ?? ""
  if (!text && attachments.length === 0) return null
  return {
    connectionId,
    channel: "telegram",
    providerEventId: String(update.update_id),
    providerMessageId: String(message.message_id),
    externalConversationId: conversationId,
    externalContactId: contactId,
    receivedAt,
    text,
    attachments,
    contact: {
      externalId: contactId,
      displayName: [sender.first_name, sender.last_name].filter(Boolean).join(" ") || ("title" in sender ? sender.title : undefined) || undefined,
      username: sender.username,
      locale: "language_code" in sender ? sender.language_code : undefined,
      metadata: { chatType: message.chat.type, chatTitle: message.chat.title },
    },
    metadata: {
      telegramUpdateId: update.update_id,
      telegramChatId: message.chat.id,
      telegramMessageId: message.message_id,
      telegramDate: message.date,
    },
  }
}

export async function sendTelegramEnvelope(
  api: ReturnType<typeof createTelegramApi>,
  envelope: OutboundEnvelope,
  externalConversationId: string,
) {
  const ids: string[] = []
  const text = envelope.text.trim()
  // Validate the complete envelope before the first provider write. This
  // prevents an unsupported second attachment from causing a retry to resend
  // an already delivered text chunk.
  for (const attachment of envelope.attachments ?? []) {
    const source = attachment.fileId ?? attachment.url
    if (!source || !["image", "document", "audio", "video"].includes(attachment.type)) {
      throw new TelegramApiError({
        code: "UNSUPPORTED_ATTACHMENT",
        message: !source
          ? `Telegram cannot send this ${attachment.type} attachment without a file ID or URL.`
          : `Telegram outbound ${attachment.type} attachments are not enabled yet.`,
      })
    }
  }
  try {
    for (let offset = 0; offset < text.length; offset += TELEGRAM_TEXT_LIMIT) {
      const result = await api.sendMessage(externalConversationId, text.slice(offset, offset + TELEGRAM_TEXT_LIMIT), envelope.replyToProviderMessageId)
      ids.push(String(result.message_id))
    }
    for (const attachment of envelope.attachments ?? []) {
      const source = attachment.fileId ?? attachment.url
      if (!source) throw new TelegramApiError({ code: "UNSUPPORTED_ATTACHMENT", message: `Telegram cannot send this ${attachment.type} attachment without a file ID or URL.` })
      if (attachment.type === "image") ids.push(String((await api.sendPhoto(externalConversationId, source, attachment.caption)).message_id))
      else if (attachment.type === "document") ids.push(String((await api.sendDocument(externalConversationId, source, attachment.caption)).message_id))
      else if (attachment.type === "audio") ids.push(String((await api.sendAudio(externalConversationId, source, attachment.caption)).message_id))
      else if (attachment.type === "video") ids.push(String((await api.sendVideo(externalConversationId, source, attachment.caption)).message_id))
    }
    if (!ids.length) {
      const result = await api.sendMessage(externalConversationId, " ")
      ids.push(String(result.message_id))
    }
    return ids
  } catch (error) {
    // Telegram has no outbound idempotency key. Once any part has been
    // accepted, replaying the envelope could duplicate an earlier part, even
    // when the provider reports a retryable error for the next part.
    if (!ids.length || (error instanceof TelegramApiError && error.uncertain)) throw error
    if (error instanceof TelegramApiError) {
      throw new TelegramApiError({
        code: error.code,
        message: error.message,
        status: error.status,
        retryAfterSeconds: error.retryAfterSeconds,
        uncertain: true,
      })
    }
    throw new TelegramApiError({
      code: "PROVIDER_ERROR",
      message: "Telegram delivery became uncertain after a partial send.",
      uncertain: true,
    })
  }
}
