import { createHmac, timingSafeEqual } from "node:crypto"
import { WhatsAppApiError } from "./whatsapp-api"

const BASE = "https://zernio.com/api/v1"
export type ZernioObject = Record<string, unknown>
export const zernioObject = (value: unknown): ZernioObject =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as ZernioObject)
    : {}

export function zernioReady() {
  try {
    const url = new URL(process.env.DATOOL_PUBLIC_URL ?? "")
    return Boolean(
      process.env.DATOOL_ZERNIO_API_KEY &&
      process.env.DATOOL_ZERNIO_WEBHOOK_SECRET &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !/^(localhost|127\.|\[::1\])/.test(url.hostname)
    )
  } catch {
    return false
  }
}

export function verifyZernioSignature(
  body: Uint8Array,
  signature: string | null
) {
  const secret = process.env.DATOOL_ZERNIO_WEBHOOK_SECRET
  if (!secret || !signature || !/^[a-f0-9]{64}$/.test(signature)) return false
  const expected = createHmac("sha256", secret).update(body).digest()
  return timingSafeEqual(expected, Buffer.from(signature, "hex"))
}

/** The bearer key is sent only to Zernio's fixed origin. Never follow redirects. */
export async function zernioRequest<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "DELETE"
    body?: unknown
    sending?: boolean
    idempotencyKey?: string
    allowMissing?: boolean
  } = {}
): Promise<T> {
  const key = process.env.DATOOL_ZERNIO_API_KEY
  if (!key || !path.startsWith("/") || path.startsWith("//"))
    throw new WhatsAppApiError(
      "INVALID_CONFIGURATION",
      "The official WhatsApp connection is not configured."
    )
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(options.idempotencyKey
          ? { "Idempotency-Key": options.idempotencyKey }
          : {}),
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
      "WhatsApp could not confirm this request.",
      options.sending === true
    )
  }
  if (response.status === 404 && options.allowMissing) return {} as T
  if (!response.ok) {
    const code =
      response.status === 429
        ? "RATE_LIMITED"
        : response.status === 401 || response.status === 403
          ? "INVALID_CREDENTIAL"
          : response.status >= 500
            ? "NETWORK_ERROR"
            : "WHATSAPP_REJECTED"
    throw new WhatsAppApiError(
      code,
      `WhatsApp request failed (${response.status}).`,
      !!options.sending && response.status >= 500,
      response.status === 429
        ? Number(response.headers.get("retry-after")) || 10
        : undefined
    )
  }
  try {
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Missing response")
    let size = 0
    const chunks: Uint8Array[] = []
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 2_000_000) throw new Error("Response too large")
        chunks.push(value)
      }
    } finally {
      void reader.cancel().catch(() => {})
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T
  } catch {
    throw new WhatsAppApiError(
      "INVALID_PROVIDER_RESPONSE",
      "WhatsApp returned an invalid response.",
      options.sending === true
    )
  }
}
