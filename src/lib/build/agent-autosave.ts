import { agentConfigurationSchema, type ManagedAgent } from "./contracts"

export function agentDraft(agent?: ManagedAgent) {
  return {
    name: agent?.name ?? "",
    slug: agent?.slug ?? "",
    description: agent?.description ?? "",
    configuration:
      agent?.configuration ??
      agentConfigurationSchema.parse({
        appearance: { welcomeMessage: "Hi! How can I help?" },
      }),
  }
}

type AgentDraft = ReturnType<typeof agentDraft>

export function validAgentDraft(draft: AgentDraft) {
  return Boolean(
    draft.name.trim() &&
    draft.name.length <= 160 &&
    draft.slug.trim() &&
    draft.configuration.model.trim() &&
    draft.description.length <= 2000 &&
    agentConfigurationSchema.safeParse(draft.configuration).success
  )
}

/** Serializes revisions without replacing edits made while a write is in flight. */
export function createAgentAutosave(
  agent: ManagedAgent | undefined,
  save: (
    draft: AgentDraft,
    saved: ManagedAgent | undefined,
    changes: Partial<AgentDraft>
  ) => Promise<ManagedAgent>,
  delay = 600
) {
  let baseline = agentDraft(agent)
  let definitions = 0
  let appliedDefinitions = 0
  let state = {
    draft: baseline,
    saved: agent,
    status: "idle" as "idle" | "saving" | "saved" | "error" | "invalid",
    error: null as Error | null,
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let flight: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const pending = () =>
    JSON.stringify(state.draft) !== JSON.stringify(baseline) ||
    definitions !== appliedDefinitions

  function publish(next: Partial<typeof state>) {
    state = { ...state, ...next }
    listeners.forEach((listener) => listener())
  }

  async function drain() {
    while (pending()) {
      const draft = state.draft
      if (!validAgentDraft(draft)) {
        publish({ status: "invalid", error: null })
        return
      }
      const version = definitions
      const changes = Object.fromEntries(
        Object.entries(draft).filter(
          ([key, value]) =>
            JSON.stringify(value) !==
            JSON.stringify(baseline[key as keyof AgentDraft])
        )
      ) as Partial<AgentDraft>
      publish({ status: "saving", error: null })
      try {
        const saved = await save(draft, state.saved, changes)
        baseline = draft
        appliedDefinitions = version
        publish({ saved })
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

  function schedule() {
    clearTimeout(timer)
    // Creating an agent remains an explicit action; existing agents autosave.
    if (!state.saved) return
    publish({ status: validAgentDraft(state.draft) ? "saving" : "invalid" })
    timer = setTimeout(() => void flush().catch(() => {}), delay)
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
    update(draft: AgentDraft) {
      // The editor has one name; retain the appearance field for channel consumers.
      if (draft.name !== state.draft.name) {
        draft = {
          ...draft,
          configuration: {
            ...draft.configuration,
            appearance: {
              ...draft.configuration.appearance,
              displayName: draft.name,
            },
          },
        }
      }
      if (JSON.stringify(draft) === JSON.stringify(state.draft)) return
      publish({ draft, error: null })
      schedule()
    },
    definitionsChanged() {
      definitions++
      schedule()
    },
  }
}
