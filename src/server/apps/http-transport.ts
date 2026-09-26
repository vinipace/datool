import type { PromptRunScope } from "@/src/lib/tracer/prompt-overrides"
import { lookup } from "node:dns/promises"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { isIP } from "node:net"
import type { WebhookConnection } from "@/src/lib/playground/connections"

export function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number)
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    )
  }
  // Only globally routed IPv6 unicast; mapped/private/link-local addresses fail closed.
  return (
    isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^2001:(db8|0):/i.test(address)
  )
}

export async function invokeHttp(
  config: WebhookConnection,
  input: unknown,
  envelope: unknown,
  context: { promptScope?: PromptRunScope; appId: string; callId: string; traceId?: string }
) {
  const deadline = Date.now() + config.timeoutMs
  const url = new URL(config.url)
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  const addresses = await new Promise<{ address: string; family: number }[]>(
    (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Webhook DNS lookup timed out.")),
        config.timeoutMs
      )
      const resolving = isIP(hostname)
        ? Promise.resolve([{ address: hostname, family: isIP(hostname) }])
        : lookup(hostname, { all: true })
      resolving
        .then(resolve, () =>
          reject(new Error("Webhook hostname could not be resolved."))
        )
        .finally(() => clearTimeout(timer))
    }
  )
  const allowPrivate =
    process.env.DATOOL_ALLOW_PRIVATE_APP_URLS === "1" ||
    process.env.NODE_ENV !== "production"
  if (
    !addresses.length ||
    (!allowPrivate && addresses.some((item) => !publicAddress(item.address)))
  )
    throw new Error("Webhook must resolve to a public address.")
  const address = addresses[0]
  const body = JSON.stringify(config.body === "input" ? input : envelope)
  if (body === undefined || Buffer.byteLength(body) > 1024 * 1024)
    throw new Error("App input must be JSON and at most 1 MiB.")
  const headers = new Headers(config.headers)
  headers.set("content-type", "application/json")
  headers.set("x-datool-connection-id", context.appId)
  headers.set("x-datool-call-id", context.callId)
  if (context.promptScope) headers.set("x-datool-prompt-scope", Buffer.from(JSON.stringify(context.promptScope)).toString("base64url"))
  if (context.traceId)
    headers.set("x-datool-invocation-trace-id", context.traceId)
  // Pin the checked DNS address for the actual connection; never follow redirects with credentials.
  return new Promise<{ output: unknown; telemetryComplete: boolean }>(
    (resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: config.method,
          headers: Object.fromEntries(headers),
          family: address.family,
          lookup: (_hostname, _options, callback) =>
            callback(null, address.address, address.family),
        },
        (response) => {
          if (
            !response.statusCode ||
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            reject(
              new Error(`Webhook returned HTTP ${response.statusCode ?? 0}`)
            )
            response.destroy()
            return
          }
          const chunks: Buffer[] = []
          let size = 0
          response.on("data", (chunk: Buffer) => {
            size += chunk.length
            if (size > 1024 * 1024) {
              reject(new Error("Webhook output exceeds 1 MiB."))
              request.destroy()
            } else chunks.push(chunk)
          })
          response.on("error", () =>
            reject(new Error("Webhook response was interrupted."))
          )
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8")
            let output: unknown = text
            try {
              output = JSON.parse(text)
            } catch {
              /* String outputs are supported. */
            }
            resolve({
              output,
              telemetryComplete:
                response.headers["x-datool-telemetry-complete"] === "true",
            })
          })
        }
      )
      const timer = setTimeout(
        () => {
          reject(new Error("Webhook request failed or timed out."))
          request.destroy()
        },
        Math.max(1, deadline - Date.now())
      )
      request.on("close", () => clearTimeout(timer))
      request.on("error", () =>
        reject(new Error("Webhook request failed or timed out."))
      )
      request.end(body)
    }
  )
}
