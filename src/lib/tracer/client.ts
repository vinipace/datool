import { DatoolPrompts, type PromptCacheOptions } from "./managed-prompt-client"
import { fetchWithRetry } from "./retry.ts"
import { IngestionSequence } from "./ingestion-sequence.ts"
import type { QueuedEvent } from "./queued-request.ts"
/** Authenticated Node client shared by runtime prompts and telemetry. */
export type DatoolClientOptions = {
  promptCache?: PromptCacheOptions
  apiKey?: string
  baseUrl?: string
  fetch?: typeof globalThis.fetch
  requestTimeoutMs?: number
  projectId?: string
  delivery?: "queued" | "direct"
  retries?: number
}

export class DatoolClient {
  readonly prompts: DatoolPrompts
  readonly baseUrl: string
  private readonly apiKey: string
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly timeout: number
  private readonly projectId?: string
  private readonly delivery: "queued" | "direct"
  private readonly retries: number
  private readonly sequence = new IngestionSequence(event => this.sendRequest("/api/ingest", "POST", event, true))

  constructor(options: DatoolClientOptions = {}) {
    this.apiKey = (options.apiKey ?? process.env.DATOOL_API_KEY ?? "").trim()
    if (!this.apiKey) throw new Error("Missing DATOOL_API_KEY in .env.local")
    this.baseUrl = (
      options.baseUrl ??
      process.env.DATOOL_BASE_URL ??
      process.env.DATOOL_TRACE_BASE_URL ??
      "http://127.0.0.1:3000"
    ).replace(/\/$/, "")
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.timeout = options.requestTimeoutMs ?? 10_000
    this.projectId = options.projectId ?? process.env.DATOOL_PROJECT_ID
    this.delivery = options.delivery ?? "queued"
    this.retries = options.retries ?? 8
    this.prompts = new DatoolPrompts(
      this.request.bind(this),
      { projectId: this.projectId, baseUrl: this.baseUrl },
      options.promptCache
    )
  }

  /** Wait for the final receipt; its predecessor chain proves all earlier writes committed. */
  async forceFlush(): Promise<void> {
    if (this.delivery !== "queued") return
    await this.sequence.flush()
    if (!this.sequence.previousId) return
    const eventId = this.sequence.previousId
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const state = await this.request<{ status: string }>(
        `/api/ingest?eventId=${encodeURIComponent(eventId)}`
      )
      if (state.status === "saved") return
      if (state.status === "failed")
        throw new Error(`Datool event ${eventId} failed; retained for replay`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`Datool event ${eventId} is queued but not yet saved`)
  }

  async request<T>(
    path: string,
    method: "GET" | "POST" | "PATCH" = "GET",
    body?: unknown,
    delivery = this.delivery
  ): Promise<T> {
    if (!path.startsWith("/api/"))
      throw new Error("Expected a Datool /api/ path")
    const queued =
      delivery === "queued" &&
      method !== "GET" &&
      /^\/api\/(sessions|traces|spans)(\/|$)/.test(path)
    if (queued) return this.sequence.request<T>({ path, method: method as QueuedEvent["method"], body })
    return this.sendRequest<T>(path, method, body, false)
  }

  private async sendRequest<T>(path: string, method: "GET" | "POST" | "PATCH", body: unknown, queued: boolean): Promise<T> {
    const response = await fetchWithRetry(
      this.fetchImpl,
      `${this.baseUrl}${queued ? "/api/ingest" : path}`,
      {
        method: queued ? "POST" : method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
          ...(this.projectId ? { "x-project-id": this.projectId } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
        redirect: "error",
      },
      {
        timeoutMs: this.timeout,
        retries: queued || method === "GET" ? this.retries : 0,
      }
    )
    // Do not echo an upstream body: proxies can include request credentials.
    if (!response.ok)
      throw new Error(
        `Datool ${method} ${path} failed (HTTP ${response.status})` +
          (response.status === 400 && !this.projectId?.trim()
            ? ": Missing project scope. Set DATOOL_PROJECT_ID or pass projectId to DatoolClient/DatoolSpanProcessor."
            : "")
      )
    const payload = await response.json()
    if (!payload || typeof payload !== "object" || !("data" in payload)) {
      throw new Error("Datool returned an invalid response envelope")
    }
    return payload.data as T
  }
}

/** Client for runtime prompts and authenticated Datool requests. */
export function createDatool(options: DatoolClientOptions = {}) {
  return new DatoolClient(options)
}
