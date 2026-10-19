import { lookup } from "node:dns/promises"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { isIP } from "node:net"
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib"

export type PublicHttpOptions = {
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
  timeoutMs?: number
  maxRequestBytes?: number
  maxResponseBytes?: number
  signal?: AbortSignal
}

export type PublicHttpResponse = {
  url: string
  status: number
  headers: Headers
  body: Uint8Array
}

/** Public customer tools never inherit the internal app transport's development bypass. */
export function isPublicBuildAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number)
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 &&
        (b === 168 ||
          (b === 0 && (c === 0 || c === 2)) ||
          (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    )
  }
  // Exclude mapped addresses, tunnels, documentation, local and special-purpose ranges.
  return (
    isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^2001:(?:0|db8|10|20):/i.test(address) &&
    !/^2002:/i.test(address) &&
    !/^3fff:/i.test(address)
  )
}

export function assertPublicHttpUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error("A valid public HTTP URL is required.")
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      "Only HTTP(S) URLs without embedded credentials are allowed."
    )
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (
    !hostname ||
    hostname === "localhost" ||
    /\.(?:localhost|local|internal)$/.test(hostname) ||
    (isIP(hostname) && !isPublicBuildAddress(hostname))
  )
    throw new Error("The destination must be a public internet address.")
  return url
}

/**
 * Resolve once and pin the validated address to the socket. Redirects are
 * returned, never followed: callers must revalidate each hop and must not
 * forward credentials to a new authority. Errors intentionally omit URLs,
 * request bodies and headers, which can contain customer credentials.
 */
export async function publicHttpRequest(
  rawUrl: string,
  options: PublicHttpOptions = {}
): Promise<PublicHttpResponse> {
  const url = assertPublicHttpUrl(rawUrl)
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  const timeoutMs = Math.min(60_000, Math.max(100, options.timeoutMs ?? 15_000))
  const maxResponseBytes = Math.min(
    20 * 1024 * 1024,
    Math.max(1, options.maxResponseBytes ?? 1024 * 1024)
  )
  const body =
    options.body === undefined ? undefined : Buffer.from(options.body)
  if (body && body.byteLength > (options.maxRequestBytes ?? 1024 * 1024))
    throw new Error("The outbound request exceeds its size limit.")
  const deadline = Date.now() + timeoutMs
  if (options.signal?.aborted)
    throw new Error("The outbound request was cancelled.")
  let dnsTimer: ReturnType<typeof setTimeout> | undefined
  const addresses = await Promise.race([
    isIP(hostname)
      ? Promise.resolve([{ address: hostname, family: isIP(hostname) }])
      : lookup(hostname, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => {
      dnsTimer = setTimeout(
        () => reject(new Error("Public hostname lookup timed out.")),
        timeoutMs
      )
    }),
  ])
    .catch(() => {
      throw new Error("The public hostname could not be resolved safely.")
    })
    .finally(() => clearTimeout(dnsTimer))
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicBuildAddress(address))
  )
    throw new Error(
      "The destination must resolve only to public internet addresses."
    )
  if (options.signal?.aborted)
    throw new Error("The outbound request was cancelled.")
  const address = addresses[0]
  let headers: Headers
  try {
    headers = new Headers(options.headers)
  } catch {
    throw new Error("The outbound request contains invalid headers.")
  }
  for (const key of [
    "host",
    "connection",
    "proxy-authorization",
    "proxy-connection",
    "transfer-encoding",
    "content-length",
  ])
    headers.delete(key)
  headers.set("accept-encoding", "identity")
  if (body) headers.set("content-length", String(body.byteLength))
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, response?: PublicHttpResponse) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
      if (error) reject(error)
      else resolve(response!)
    }
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: options.method ?? "GET",
        headers: Object.fromEntries(headers),
        agent: false,
        family: address.family,
        lookup: (_hostname, options, callback) => {
          // Bun and Node's multi-address connect path request the `all`
          // callback shape. Return only the address validated above in either
          // shape, preserving DNS pinning across both supported runtimes.
          if (options.all) callback(null, [address])
          else callback(null, address.address, address.family)
        },
      },
      (response) => {
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined)
            responseHeaders.set(
              key,
              Array.isArray(value) ? value.join(", ") : value
            )
        }
        const declared = Number(response.headers["content-length"])
        if (declared > maxResponseBytes) {
          finish(new Error("The outbound response exceeds its size limit."))
          response.destroy()
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength
          if (size > maxResponseBytes) {
            finish(new Error("The outbound response exceeds its size limit."))
            response.destroy()
            request.destroy()
          } else chunks.push(chunk)
        })
        response.on("aborted", () =>
          finish(new Error("The outbound response was interrupted."))
        )
        response.on("error", () =>
          finish(new Error("The outbound response was interrupted."))
        )
        response.on("end", () => {
          if (settled) return
          try {
            let bytes = Buffer.concat(chunks)
            const encoding = responseHeaders
              .get("content-encoding")
              ?.toLowerCase()
            const limits = { maxOutputLength: maxResponseBytes }
            if (encoding === "gzip") bytes = gunzipSync(bytes, limits)
            else if (encoding === "deflate") bytes = inflateSync(bytes, limits)
            else if (encoding === "br")
              bytes = brotliDecompressSync(bytes, limits)
            else if (encoding && encoding !== "identity")
              throw new Error("Unsupported response encoding.")
            if (bytes.byteLength > maxResponseBytes)
              throw new Error("Response too large.")
            finish(undefined, {
              url: url.toString(),
              status: response.statusCode ?? 0,
              headers: responseHeaders,
              body: bytes,
            })
          } catch {
            finish(
              new Error(
                "The outbound response could not be decoded within its size limit."
              )
            )
          }
        })
      }
    )
    function abort() {
      finish(new Error("The outbound request was cancelled."))
      request.destroy()
    }
    const timer = setTimeout(
      () => {
        finish(new Error("The outbound request timed out."))
        request.destroy()
      },
      Math.max(1, deadline - Date.now())
    )
    options.signal?.addEventListener("abort", abort, { once: true })
    request.on("error", () => finish(new Error("The outbound request failed.")))
    if (options.signal?.aborted) {
      abort()
      return
    }
    request.end(body)
  })
}
