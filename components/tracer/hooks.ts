"use client"

import * as React from "react"
import { createReadScheduler } from "@/src/lib/tracer/read-scheduler"

export type RemoteState<T> = {
  data: T | null
  error: Error | null
  isLoading: boolean
  /** Visible feedback for explicit refreshes; automatic reads stay silent. */
  isRefreshing: boolean
  refresh: () => void
}

type RemoteOptions<T> = {
  enabled?: boolean
  intervalMs?: number
  shouldPoll?: (data: T | null) => boolean
  /** The caller must prevent previous data from being shown for a different resource. */
  keepPreviousData?: boolean
}

export function useRemote<T>(
  load: (signal: AbortSignal) => Promise<T>,
  dependencies: React.DependencyList,
  options: RemoteOptions<T> = {}
): RemoteState<T> {
  const { enabled = true, intervalMs, keepPreviousData = false } = options
  const [state, setState] = React.useState({
    data: null as T | null,
    error: null as Error | null,
    isLoading: enabled,
    isRefreshing: false,
  })
  const scheduler = React.useRef<ReturnType<
    typeof createReadScheduler<T>
  > | null>(null)
  const shouldPoll = React.useEffectEvent(
    (data: T | null) => options.shouldPoll?.(data) ?? true
  )
  React.useEffect(() => {
    if (!enabled) return
    let latest: T | null = null
    let first = true
    const current = createReadScheduler<T>({
      load,
      intervalMs,
      visible: () => document.visibilityState !== "hidden",
      shouldPoll: () => shouldPoll(latest),
      onStart: (reason) => {
        const reset = first
        first = false
        if (!reset && reason === "background") return
        setState((s) => ({
          ...s,
          data: reset && !keepPreviousData ? null : s.data,
          error: null,
          isLoading: (reset && !keepPreviousData) || s.data === null,
          isRefreshing: (!reset || keepPreviousData) && s.data !== null,
        }))
      },
      onValue: (data) => {
        latest = data
        setState((s) => ({ ...s, data, error: null }))
      },
      onError: (error) =>
        setState((s) => ({
          ...s,
          error:
            error instanceof Error
              ? error
              : new Error("Unable to load this view."),
        })),
      onSettled: () =>
        setState((s) => ({ ...s, isLoading: false, isRefreshing: false })),
    })
    scheduler.current = current
    queueMicrotask(current.refresh)
    document.addEventListener("visibilitychange", current.resume)
    return () => {
      current.stop()
      document.removeEventListener("visibilitychange", current.resume)
    }
    // Callers declare the resource identity and stable loader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, load, intervalMs, keepPreviousData, ...dependencies])
  return {
    ...state,
    isLoading: enabled && state.isLoading,
    refresh: () => scheduler.current?.refresh(),
  }
}

export type MutationState = {
  error: Error | null
  isPending: boolean
}

export function useMutation() {
  const [state, setState] = React.useState<MutationState>({
    error: null,
    isPending: false,
  })

  const run = React.useCallback(async <T>(operation: () => Promise<T>) => {
    setState({ error: null, isPending: true })

    try {
      return await operation()
    } catch (reason) {
      const error =
        reason instanceof Error
          ? reason
          : new Error("The action could not be completed.")
      setState({ error, isPending: false })
      throw error
    } finally {
      setState((current) => ({ ...current, isPending: false }))
    }
  }, [])

  return { ...state, run }
}

const noPreferenceSubscription = () => () => {}

/** Hydration-safe initial preference; user choices stay local to this mount. */
export function useStoredChoice<T extends string>(
  key: string,
  choices: readonly T[],
  fallback: T
): readonly [T, (value: T) => void] {
  const stored = React.useSyncExternalStore(
    noPreferenceSubscription,
    () => {
      try {
        const value = localStorage.getItem(key) as T | null
        return value !== null && choices.includes(value) ? value : fallback
      } catch {
        return fallback
      }
    },
    () => fallback
  )
  const [chosen, setChosen] = React.useState<T | null>(null)
  return [
    chosen ?? stored,
    (value) => {
      setChosen(value)
      try {
        localStorage.setItem(key, value)
      } catch {
        /* The current mount still retains the choice. */
      }
    },
  ]
}

/** Section preferences follow the viewer, rather than an individual trace. */
export function useTraceSectionDisclosure(
  section: string,
  initiallyRevealed = false
) {
  const [choice, setChoice] = useStoredChoice(
    `datool:trace-inspector:section:${section}`,
    ["open", "closed"] as const,
    "open"
  )
  // Following an annotation reveals its field without changing the saved layout.
  const [revealed, setRevealed] = React.useState(initiallyRevealed)
  const open = revealed || choice === "open"
  const onToggle: React.ToggleEventHandler<HTMLDetailsElement> = (event) => {
    // Ignore nested disclosures and toggles caused by restoring the preference.
    if (
      event.target !== event.currentTarget ||
      event.currentTarget.open === open
    )
      return
    setRevealed(false)
    setChoice(event.currentTarget.open ? "open" : "closed")
  }
  return { open, onToggle }
}
