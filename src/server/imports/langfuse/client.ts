import { z } from "zod"

export type Credentials = { host: string; publicKey: string; secretKey: string }
export type Kind = "sessions" | "traces" | "observations" | "scores"
export type Mode = "legacy" | "modern"
export type SourceRecord = Record<string, unknown>
export type Page = {
  rows: unknown[]
  next: string | null
  total: number | null
}
export class SourceError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable = false,
    public readonly retryAfterMs = 0
  ) {
    super(code)
  }
}
export function normalizeHost(host: string) {
  const url = new URL(host)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new SourceError("INVALID_LANGFUSE_HOST")
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new SourceError("LANGFUSE_REQUIRES_HTTPS")
  return url.href.replace(/\/+$/, "")
}
export function credentialsFromEnvironment(): Credentials {
  const { LANGFUSE_HOST, LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY } =
    process.env
  const host = LANGFUSE_BASE_URL?.trim() || LANGFUSE_HOST?.trim()
  if (!host || !LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY)
    throw new SourceError("LANGFUSE_CREDENTIALS_REQUIRED")
  return {
    host: normalizeHost(host),
    publicKey: LANGFUSE_PUBLIC_KEY,
    secretKey: LANGFUSE_SECRET_KEY,
  }
}
export class LangfuseClient {
  readonly host: string
  constructor(
    private readonly credentials: Credentials,
    private readonly options: {
      fetch?: typeof fetch
      sleep?: (ms: number) => Promise<void>
      attempts?: number
      timeoutMs?: number
    } = {}
  ) {
    this.host = normalizeHost(credentials.host)
  }

  async request(
    path: string,
    params: Record<string, string> = {}
  ): Promise<unknown> {
    const url = new URL(`${this.host}/api/public/${path}`)
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value)
    const attempts = this.options.attempts ?? 5
    for (let attempt = 0; attempt < attempts; attempt++) {
      let response: Response
      try {
        response = await (this.options.fetch ?? fetch)(url, {
          headers: {
            authorization: `Basic ${Buffer.from(`${this.credentials.publicKey}:${this.credentials.secretKey}`).toString("base64")}`,
            accept: "application/json",
          },
          redirect: "error",
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 30000),
        })
      } catch {
        if (attempt + 1 === attempts)
          throw new SourceError("LANGFUSE_NETWORK_ERROR", true)
        await this.sleep(500 * 2 ** attempt)
        continue
      }
      if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
        await response.body?.cancel()
        const retry = response.headers.get("retry-after")
        const delay =
          retry && /^\d+(\.\d+)?$/.test(retry)
            ? Number(retry) * 1000
            : retry
              ? Date.parse(retry) - Date.now()
              : 0
        // Long provider backoffs go to the durable job retry instead of holding the request.
        if (delay > 60000)
          throw new SourceError("LANGFUSE_LONG_RATE_LIMIT", true, delay)
        if (attempt + 1 === attempts)
          throw new SourceError(`LANGFUSE_HTTP_${response.status}`, true)
        await this.sleep(
          Math.max(Number.isFinite(delay) ? delay : 0, 500 * 2 ** attempt)
        )
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new SourceError(`LANGFUSE_HTTP_${response.status}`)
      }
      try {
        // Limit untrusted responses while streaming, including bodies without Content-Length.
        if (!response.body) throw new SourceError("LANGFUSE_INVALID_JSON")
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > 32 * 1024 * 1024) {
            await reader.cancel()
            throw new SourceError("LANGFUSE_PAGE_TOO_LARGE")
          }
          chunks.push(part.value)
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"))
      } catch (error) {
        if (error instanceof SourceError) throw error
        if (error instanceof SyntaxError)
          throw new SourceError("LANGFUSE_INVALID_JSON")
        throw new SourceError("LANGFUSE_RESPONSE_INTERRUPTED", true)
      }
    }
    throw new SourceError("LANGFUSE_REQUEST_FAILED", true)
  }
  private sleep(ms: number) {
    return (
      this.options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    )(ms)
  }

  async project(): Promise<string> {
    const result = z
      .object({ data: z.array(z.object({ id: z.string().min(1) })).length(1) })
      .safeParse(await this.request("projects"))
    if (!result.success)
      throw new SourceError("LANGFUSE_PROJECT_IDENTITY_INVALID")
    return result.data.data[0].id
  }
  async page(
    kind: Kind,
    mode: Mode,
    from: string,
    to: string,
    token: string | null,
    limit: number
  ): Promise<Page> {
    const modern =
      mode === "modern" && ["observations", "scores"].includes(kind)
    const path =
      kind === "observations" && modern
        ? "v2/observations"
        : kind === "scores"
          ? modern
            ? "v3/scores"
            : "v2/scores"
          : kind
    const params: Record<string, string> =
      kind === "observations"
        ? { fromStartTime: from, toStartTime: to }
        : { fromTimestamp: from, toTimestamp: to }
    params.limit = String(limit)
    if (modern) {
      if (token) params.cursor = token
    } else params.page = token ?? "1"
    if (kind === "observations" && modern)
      params.fields =
        "core,basic,time,io,metadata,model,usage,prompt,metrics,trace_context"
    if (kind === "scores" && modern)
      params.fields = "details,subject,annotation"
    if (kind === "traces") params.orderBy = "timestamp.asc"
    const result = z
      .object({
        data: z.array(z.unknown()),
        meta: z.record(z.string(), z.unknown()),
      })
      .safeParse(await this.request(path, params))
    if (!result.success) throw new SourceError("LANGFUSE_INVALID_PAGE")
    const { data, meta } = result.data
    if (modern) {
      if (
        meta.cursor !== undefined &&
        meta.cursor !== null &&
        (typeof meta.cursor !== "string" || !meta.cursor)
      )
        throw new SourceError("LANGFUSE_INVALID_CURSOR")
      const next = typeof meta.cursor === "string" ? meta.cursor : null
      if (next && (next === token || !data.length))
        throw new SourceError("LANGFUSE_PAGINATION_STALLED")
      return { rows: data, next, total: null }
    }
    const parsed = z
      .object({
        page: z.number().int().positive(),
        totalPages: z.number().int().nonnegative(),
        totalItems: z.number().int().nonnegative(),
      })
      .safeParse(meta)
    if (!parsed.success || parsed.data.page !== Number(token ?? 1))
      throw new SourceError("LANGFUSE_INVALID_PAGE_META")
    const next =
      parsed.data.page < parsed.data.totalPages
        ? String(parsed.data.page + 1)
        : null
    if (next && !data.length)
      throw new SourceError("LANGFUSE_PAGINATION_STALLED")
    return { rows: data, next, total: parsed.data.totalItems }
  }
}
