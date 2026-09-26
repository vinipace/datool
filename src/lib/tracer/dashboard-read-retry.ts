export class DashboardRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfter?: string | null
  ) {
    super(message)
    this.name = "DashboardRequestError"
  }
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted()
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", abort, { once: true })
  })
}

const defaultClock = { now: Date.now, random: Math.random, wait }

/** Only callers performing side-effect-free metric reads may use this policy. */
export async function retryDashboardMetricRead<T>(
  load: () => Promise<T>,
  signal?: AbortSignal,
  clock = defaultClock
): Promise<T> {
  const deadline = clock.now() + 15_000
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()
    try {
      return await load()
    } catch (error) {
      signal?.throwIfAborted()
      if (
        !(error instanceof DashboardRequestError) ||
        error.status !== 429 ||
        error.code !== "READ_BUSY" ||
        attempt >= 4
      )
        throw error
      const header = error.retryAfter?.trim()
      const seconds = header ? Number(header) : NaN
      const serverDelay =
        Number.isFinite(seconds) && seconds >= 0
          ? seconds * 1000
          : header
            ? Math.max(0, Date.parse(header) - clock.now())
            : 0
      // Jitter is additive: never retry sooner than the server's minimum.
      const delay =
        Math.max(
          500 * 2 ** attempt,
          Number.isFinite(serverDelay) ? serverDelay : 0
        ) +
        clock.random() * 250
      if (clock.now() + delay >= deadline) throw error
      await clock.wait(delay, signal)
      // A suspended tab can resume well after its timer was due.
      if (clock.now() >= deadline) throw error
    }
  }
}
