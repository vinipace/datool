/** One in-flight load, completion-based polling, cancellation and bounded backoff. */
export function createReadScheduler<T>(options: {
  load: (signal: AbortSignal) => Promise<T>
  onStart?: (reason: "refresh" | "background") => void
  onValue: (value: T) => void
  onError: (error: unknown) => void
  onSettled?: () => void
  intervalMs?: number
  visible?: () => boolean
  shouldPoll?: () => boolean
}) {
  let stopped = false,
    busy = false,
    pending = false,
    failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  const visible = options.visible ?? (() => true)
  function schedule() {
    if (stopped || !options.intervalMs) return
    timer = setTimeout(
      () => {
        if (visible() && (options.shouldPoll?.() ?? true))
          void run("background")
        else schedule()
      },
      Math.min(60_000, options.intervalMs * 2 ** Math.min(failures, 4)) *
        (0.9 + Math.random() * 0.2)
    )
  }
  async function run(reason: "refresh" | "background" = "refresh") {
    if (stopped) return
    if (busy) {
      pending = true
      return
    }
    if (timer) clearTimeout(timer)
    busy = true
    controller = new AbortController()
    options.onStart?.(reason)
    try {
      const value = await options.load(controller.signal)
      if (stopped) return
      failures = 0
      options.onValue(value)
    } catch (error) {
      if (!stopped) {
        failures++
        options.onError(error)
      }
    } finally {
      busy = false
      if (!stopped) {
        options.onSettled?.()
        if (pending) {
          pending = false
          void run()
        } else schedule()
      }
    }
  }
  return {
    refresh: () => void run(),
    resume: () => {
      if (visible() && !busy && (options.shouldPoll?.() ?? true))
        void run("background")
    },
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      controller?.abort()
    },
  }
}
