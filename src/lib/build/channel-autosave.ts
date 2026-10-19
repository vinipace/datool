import type { ChatBubbleSettings } from "./chat-bubble"
import type { ChannelConnection } from "./channels"

export type BubbleDraft = {
  label: string
  origins: string
  bubble: ChatBubbleSettings
}

/** A single write queue keeps late responses from replacing newer form edits. */
export function createChannelAutosave(
  initial: BubbleDraft,
  connection: ChannelConnection,
  save: (draft: BubbleDraft) => Promise<ChannelConnection>,
  delay = 600
) {
  let acknowledged = JSON.stringify(initial)
  let state = {
    draft: initial,
    connection,
    status: "saved" as "saved" | "saving" | "error",
    error: null as Error | null,
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let flight: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const pending = () => JSON.stringify(state.draft) !== acknowledged
  function publish(next: Partial<typeof state>) {
    state = { ...state, ...next }
    listeners.forEach((listener) => listener())
  }
  async function drain() {
    while (pending()) {
      const draft = state.draft
      publish({ status: "saving", error: null })
      try {
        const result = await save(draft)
        acknowledged = JSON.stringify(draft)
        publish({ connection: result })
      } catch (cause) {
        const error =
          cause instanceof Error ? cause : new Error("Could not save changes.")
        publish({ status: "error", error })
        throw error
      }
    }
    publish({ status: "saved", error: null })
  }
  function flush() {
    clearTimeout(timer)
    if (!flight)
      flight = drain().finally(() => {
        flight = undefined
      })
    return flight
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    pending,
    flush,
    update(draft: BubbleDraft) {
      if (JSON.stringify(draft) === JSON.stringify(state.draft)) return
      publish({ draft, status: "saving", error: null })
      clearTimeout(timer)
      timer = setTimeout(() => {
        void flush().catch(() => {})
      }, delay)
    },
    setConnection(next: ChannelConnection) {
      publish({ connection: next })
    },
  }
}
