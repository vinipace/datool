/** Parse server guidance without ever shortening it to a caller's retry budget. */
export function retryDelayMs(
  header: string | null | undefined,
  seconds?: unknown,
  now = Date.now()
) {
  const value = header?.trim()
  let fromHeader = 0
  if (value) {
    fromHeader = /^\d+(\.\d+)?$/.test(value)
      ? Number(value) * 1000
      : Date.parse(value) - now
  }
  const fromBody =
    typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : 0
  return Math.max(0, Number.isFinite(fromHeader) ? fromHeader : 0, fromBody)
}

export const transientHttpStatuses = [408, 429, 500, 502, 503, 504]
export function retryBackoffMs(attempt: number, minimum = 0) {
  return Math.max(
    minimum,
    (0.5 + Math.random() * 0.5) *
      Math.min(10_000, 250 * 2 ** Math.min(attempt, 10))
  )
}

/** Retry only transient transport/server failures; callers must use stable event IDs for writes. */
export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  options: {
    timeoutMs: number
    retries?: number
    sleep?: (ms: number) => Promise<void>
    maxRetryDelayMs?: number
    retryTransport?: boolean
    retryResponse?: (response: Response) => Promise<boolean>
  }
): Promise<Response> {
  const retries = options.retries ?? 8
  const sleep =
    options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined
    try {
      response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(options.timeoutMs),
        redirect: "error",
      })
    } catch {
      if (options.retryTransport === false || attempt >= retries)
        throw new Error("Datool delivery failed after transport retries")
    }
    if (response && !transientHttpStatuses.includes(response.status))
      return response
    if (attempt >= retries) return response!
    if (
      response &&
      options.retryResponse &&
      !(await options.retryResponse(response))
    )
      return response
    const retryAfter = response?.headers.get("retry-after")
    const retryMs = retryDelayMs(retryAfter)
    // A caller's time budget must never cause a retry earlier than provider guidance.
    if (
      response &&
      options.maxRetryDelayMs !== undefined &&
      retryMs > options.maxRetryDelayMs
    )
      return response
    await response?.body?.cancel()
    await sleep(
      Math.max(
        Number.isFinite(retryMs) ? retryMs : 0,
        (0.5 + Math.random() * 0.5) *
          Math.min(options.maxRetryDelayMs ?? 10_000, 250 * 2 ** attempt)
      )
    )
  }
}
