import { fetchWithRetry } from "./retry.ts"
export type QueuedEvent = { id: string; previousId: string | null; path: string; method: "POST" | "PATCH"; body: unknown }
/** A queued acknowledgement means Redis acceptance. Optional waiting returns the committed lifecycle result. */
export async function queuedRequest<T>(options: {
  baseUrl: string; headers: Record<string, string>; fetch: typeof fetch; timeoutMs: number;
  event: QueuedEvent; waitForSaved?: boolean; retries?: number;
}): Promise<T> {
  const request = async (path: string, init: RequestInit) => {
    const response = await fetchWithRetry(options.fetch, `${options.baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", ...options.headers } }, { timeoutMs: options.timeoutMs, retries: options.retries })
    if (!response.ok) throw new Error(`Datool ingestion failed (HTTP ${response.status})`)
    const payload = await response.json()
    if (!payload || typeof payload !== "object" || !("data" in payload)) throw new Error("Invalid ingestion response")
    return payload.data
  }
  const accepted = await request("/api/ingest", { method: "POST", body: JSON.stringify(options.event) })
  if (!options.waitForSaved) return accepted
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const state = await request(`/api/ingest?eventId=${encodeURIComponent(options.event.id)}`, { method: "GET" })
    if (state.status === "saved") return state.result
    if (state.status === "failed") throw new Error(`Datool ingestion event ${options.event.id} failed; retained for replay`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Datool ingestion event ${options.event.id} is queued but not yet saved`)
}
