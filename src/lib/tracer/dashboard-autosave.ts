import type { Dashboard, DashboardInput } from "./dashboards"

export function dashboardConfig(dashboard: Dashboard): DashboardInput {
  const { schemaVersion, name, description, widgets, defaultWindowDays } =
    dashboard
  return {
    schemaVersion,
    name,
    description,
    widgets,
    ...(defaultWindowDays !== undefined ? { defaultWindowDays } : {}),
  }
}

/** Serializes writes against the latest server revision and coalesces rapid edits. */
export function createDashboardAutosave({
  initial,
  save,
  delay = 350,
}: {
  initial: Dashboard
  save: (config: DashboardInput, revision: number) => Promise<Dashboard>
  delay?: number
}) {
  let saved = initial
  let snapshot = {
    config: dashboardConfig(initial),
    saved,
    status: "saved" as "saved" | "saving" | "error",
    error: null as Error | null,
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let flight: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const pending = () =>
    JSON.stringify(snapshot.config) !== JSON.stringify(dashboardConfig(saved))
  function publish(next: Partial<typeof snapshot>) {
    snapshot = { ...snapshot, ...next }
    listeners.forEach((listener) => listener())
  }
  async function drain() {
    while (pending()) {
      const config = snapshot.config
      publish({ status: "saving", error: null })
      try {
        saved = await save(config, saved.revision)
        publish({
          saved,
          ...(snapshot.config === config
            ? { config: dashboardConfig(saved) }
            : {}),
        })
      } catch (cause) {
        const error =
          cause instanceof Error
            ? cause
            : new Error("Unable to save dashboard.")
        publish({ status: "error", error })
        throw error
      }
    }
    clearTimeout(timer)
    publish({ status: "saved", error: null })
  }
  function flush(): Promise<void> {
    clearTimeout(timer)
    if (flight) return flight
    flight = drain().finally(() => {
      flight = undefined
    })
    return flight
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    update(update: (config: DashboardInput) => DashboardInput) {
      const config = update(snapshot.config)
      if (JSON.stringify(config) === JSON.stringify(snapshot.config)) return
      // After an error, retain edits for an explicit retry instead of retrying a conflict.
      publish({ config, ...(snapshot.error ? {} : { status: "saving" }) })
      clearTimeout(timer)
      if (!snapshot.error)
        timer = setTimeout(() => {
          void flush().catch(() => {})
        }, delay)
    },
    pending,
    flush,
  }
}
