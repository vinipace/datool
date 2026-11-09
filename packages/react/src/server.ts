import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto"
import {
  createDatoolClient,
  DatoolError,
  type DatoolClientOptions,
  type ChatRequest,
} from "@datool/sdk/agents"

export type DatoolRequestConfig = { userId?: string; drive?: string }
export type DatoolHandlerOptions = DatoolClientOptions & {
  connectionId: string
  config: (input: {
    req: Request
  }) => DatoolRequestConfig | Response | Promise<DatoolRequestConfig | Response>
}

/** Export as POST in a Next.js App Router route, or use with any Request/Response server. */
export function createDatoolHandler(options: DatoolHandlerOptions) {
  const client = createDatoolClient(options)
  const cookieName = `datool_${createHash("sha256").update(options.connectionId).digest("hex").slice(0, 12)}`
  const sign = (id: string) =>
    createHmac("sha256", options.apiKey)
      .update(`${cookieName}:${id}`)
      .digest("base64url")
  return async function datoolHandler(req: Request): Promise<Response> {
    const headers = new Headers({ "Cache-Control": "no-store", Vary: "Cookie" })
    const reply = (data: unknown, status = 200) =>
      Response.json(data, { status, headers })
    if (req.method !== "POST") {
      headers.set("Allow", "POST")
      return reply({ error: { message: "Use POST." } }, 405)
    }
    const origin = req.headers.get("origin")
    if (origin && origin !== new URL(req.url).origin)
      return reply(
        { error: { message: "Cross-origin requests are not allowed." } },
        403
      )
    // Reauthenticate on every read, poll and message. Never copy a browser-supplied scope.
    let config: DatoolRequestConfig | Response
    try {
      config = await options.config({ req })
    } catch {
      return reply({ error: { message: "Sign in to use this chat." } }, 401)
    }
    if (config instanceof Response)
      return reply(
        {
          error: {
            message:
              config.status === 401
                ? "Sign in to use this chat."
                : "Chat access was denied.",
          },
        },
        config.status >= 400 ? config.status : 403
      )
    if (
      !config ||
      (config.userId !== undefined &&
        (typeof config.userId !== "string" || !config.userId.trim())) ||
      (config.drive !== undefined &&
        (typeof config.drive !== "string" || !config.drive.trim()))
    )
      return reply(
        { error: { message: "Chat configuration is unavailable." } },
        500
      )
    let userId = config.userId
    if (!userId) {
      const cookie =
        req.headers
          .get("cookie")
          ?.split(";")
          .map((value) => value.trim())
          .find((value) => value.startsWith(`${cookieName}=`))
          ?.slice(cookieName.length + 1) ?? ""
      const [id, signature, extra] = cookie.split(".")
      const validId = /^[0-9a-f-]{36}$/.test(id ?? "")
      const expected = validId ? sign(id) : ""
      const valid =
        validId &&
        !extra &&
        /^[A-Za-z0-9_-]{43}$/.test(signature ?? "") &&
        timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      const visitorId = valid ? id : randomUUID()
      userId = `visitor:${visitorId}`
      if (!valid)
        headers.append(
          "Set-Cookie",
          `${cookieName}=${visitorId}.${sign(visitorId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${new URL(req.url).protocol === "https:" ? "; Secure" : ""}`
        )
    }
    let request: ChatRequest
    try {
      const reader = req.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > 100_000) {
              await reader.cancel()
              return reply({ error: { message: "Message is too large." } }, 413)
            }
            chunks.push(value)
          }
        } finally {
          reader.releaseLock()
        }
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error()
      const fields =
        body.action === "session"
          ? ["action", "threadId"]
          : body.action === "messages"
            ? ["action", "conversationId", "before"]
            : body.action === "send"
              ? ["action", "conversationId", "text", "requestId"]
              : []
      if (
        !fields.length ||
        Object.keys(body).some((key) => !fields.includes(key))
      )
        throw new Error()
      request = body as ChatRequest
    } catch {
      return reply({ error: { message: "Invalid chat request." } }, 400)
    }
    try {
      const data = await client
        .agent({
          connectionId: options.connectionId,
          userId,
          drive: config.drive,
        })
        .chat(request)
      return reply({ data })
    } catch (error) {
      return reply(
        {
          error: {
            message:
              error instanceof DatoolError
                ? error.message
                : "Chat is temporarily unavailable.",
          },
        },
        error instanceof DatoolError ? error.status : 502
      )
    }
  }
}
