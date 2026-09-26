import {
  defaultPrompt,
  promptDraftSchema,
  type ManagedPrompt,
  type PromptInput,
} from "./prompts"

/** Serialize draft writes while keeping newer edits intact during a request. */
export function createPromptAutosave({
  initial,
  save,
  delay = 500,
}: {
  initial?: ManagedPrompt
  save: (input: PromptInput, saved?: ManagedPrompt) => Promise<ManagedPrompt>
  delay?: number
}) {
  const initialDraft = initial
    ? promptDraftSchema.parse(initial)
    : structuredClone(defaultPrompt)
  let baseline = JSON.stringify(initialDraft)
  let snapshot = {
    draft: initialDraft,
    metadataText: JSON.stringify(initialDraft.metadata, null, 2),
    saved: initial,
    status: "saved" as "saved" | "saving" | "incomplete" | "error",
    error: null as string | null,
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let flight: Promise<void> | undefined
  const listeners = new Set<() => void>()
  function input() {
    try {
      const parsed = promptDraftSchema.safeParse({
        ...snapshot.draft,
        metadata: JSON.parse(snapshot.metadataText),
      })
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }
  function changed() {
    const value = input()
    return value
      ? JSON.stringify(value) !== baseline
      : JSON.stringify(snapshot.draft) !== baseline ||
          snapshot.metadataText !==
            JSON.stringify(snapshot.draft.metadata, null, 2)
  }
  function publish(patch: Partial<typeof snapshot>) {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach((listener) => listener())
  }
  async function drain() {
    while (changed()) {
      const value = input()
      if (!value) {
        publish({ status: "incomplete", error: null })
        return
      }
      publish({ status: "saving", error: null })
      try {
        const saved = await save(value, snapshot.saved)
        baseline = JSON.stringify(promptDraftSchema.parse(saved))
        // Never replace editable text with an older response.
        publish({ saved })
      } catch (cause) {
        publish({
          status: "error",
          error:
            cause instanceof Error
              ? cause.message
              : "Unable to autosave prompt.",
        })
        throw cause
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
  function schedule() {
    clearTimeout(timer)
    if (snapshot.error) return
    publish({
      status: changed()
        ? input()
          ? "saving"
          : "incomplete"
        : flight
          ? "saving"
          : "saved",
    })
    if (changed() && input())
      timer = setTimeout(() => {
        void flush().catch(() => {})
      }, delay)
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    update(patch: Partial<PromptInput>) {
      publish({ draft: { ...snapshot.draft, ...patch } })
      schedule()
    },
    updateMetadata(metadataText: string) {
      publish({ metadataText })
      schedule()
    },
    restore(draft: PromptInput) {
      publish({ draft, metadataText: JSON.stringify(draft.metadata, null, 2) })
      schedule()
    },
    acceptPublished(saved: ManagedPrompt) {
      baseline = JSON.stringify(promptDraftSchema.parse(saved))
      publish({ saved, status: "saved", error: null })
    },
    pending: () => snapshot.status === "saving" || changed(),
    flush,
  }
}
