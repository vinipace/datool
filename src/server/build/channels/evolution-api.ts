import { WhatsAppApiError } from "./whatsapp-api"

export type EvolutionObject = Record<string, unknown>
export function evolutionObject(value: unknown): EvolutionObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as EvolutionObject)
    : {}
}
export function evolutionEnabled(projectId: string) {
  return (
    process.env.DATOOL_EVOLUTION_ENABLED === "true" &&
    (process.env.DATOOL_EVOLUTION_PROJECT_IDS ?? "")
      .split(",")
      .map((x) => x.trim())
      .includes(projectId)
  )
}
export function evolutionConfig() {
  const url = new URL(
    process.env.DATOOL_EVOLUTION_URL ?? "http://invalid.invalid"
  )
  const key = process.env.DATOOL_EVOLUTION_API_KEY ?? ""
  if (
    !process.env.DATOOL_EVOLUTION_URL ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !key
  )
    throw new WhatsAppApiError(
      "INVALID_CONFIGURATION",
      "Evolution is not configured on this installation."
    )
  return { url: url.origin, key }
}
export async function evolutionRequest<T = EvolutionObject>(
  path: string,
  options: {
    token?: string
    method?: string
    body?: unknown
    sending?: boolean
  } = {}
): Promise<T> {
  const config = evolutionConfig()
  let response: Response
  try {
    response = await fetch(`${config.url}${path}`, {
      method: options.method ?? "GET",
      headers: {
        apikey: options.token ?? config.key,
        "Content-Type": "application/json",
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
      cache: "no-store",
    })
  } catch {
    throw new WhatsAppApiError(
      "NETWORK_ERROR",
      "Evolution could not confirm this request.",
      options.sending === true
    )
  }
  if (!response.ok) {
    const code =
      response.status === 404
        ? "EVOLUTION_NOT_FOUND"
        : response.status === 429
          ? "RATE_LIMITED"
          : response.status >= 500
            ? "NETWORK_ERROR"
            : "WHATSAPP_REJECTED"
    throw new WhatsAppApiError(
      code,
      `Evolution request failed (${response.status}).`,
      options.sending === true && response.status >= 500,
      response.status === 429 ? 10 : undefined
    )
  }
  try {
    return (await response.json()) as T
  } catch {
    throw new WhatsAppApiError(
      "INVALID_PROVIDER_RESPONSE",
      "Evolution returned an invalid response.",
      options.sending === true
    )
  }
}
export function evolutionPhone(jid: unknown) {
  return typeof jid === "string"
    ? (/^([1-9][0-9]{6,19})(?::\d+)?@s\.whatsapp\.net$/.exec(jid)?.[1] ?? null)
    : null
}
export function evolutionMessage(data: unknown) {
  const raw = evolutionObject(data),
    key = evolutionObject(raw.key),
    message = evolutionObject(raw.message)
  if (
    typeof key.remoteJid !== "string" ||
    !/@(?:s\.whatsapp\.net|lid)$/.test(key.remoteJid)
  )
    return null
  // LIDs are opaque. Only use an explicitly supplied phone JID; never strip @lid.
  const phone =
    evolutionPhone(key.remoteJid) ?? evolutionPhone(key.remoteJidAlt)
  const id = typeof key.id === "string" && key.id.length <= 200 ? key.id : null
  const seconds = Number(raw.messageTimestamp)
  const time = seconds * 1000
  if (
    !phone ||
    !id ||
    typeof key.fromMe !== "boolean" ||
    !Number.isFinite(time) ||
    time <= 0 ||
    time > Date.now() + 60_000
  )
    return null
  const body =
    typeof message.conversation === "string"
      ? message.conversation
      : evolutionObject(message.extendedTextMessage).text
  // Preserve the provider address only when this event also identifies a phone.
  // A LID is opaque and must never become a phone-based conversation identity.
  const replyJid =
    [key.remoteJid, key.remoteJidAlt].find(
      (value): value is string =>
        typeof value === "string" && /^[0-9]{5,20}@lid$/.test(value)
    ) ?? null
  return {
    phone,
    replyJid,
    id,
    fromMe: key.fromMe,
    receivedAt: new Date(time).toISOString(),
    text:
      typeof body === "string"
        ? body.slice(0, 16_000)
        : "[Unsupported message]",
    supported: typeof body === "string",
    name: typeof raw.pushName === "string" ? raw.pushName.slice(0, 200) : "",
  }
}
