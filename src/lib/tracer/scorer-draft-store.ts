import { z } from "zod"
import { scorerInputSchema, type ScorerInput } from "./scorers"

// Drafts intentionally allow incomplete fields; publishing uses scorerInputSchema.
const draftSchema = z.object({
  ...scorerInputSchema.shape,
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  code: z.string(),
  model: z.string(),
  messages: z.array(z.object({ role: z.enum(["system", "user"]), content: z.string() })),
  choices: z.array(z.object({ label: z.string(), score: z.number() })),
  threshold: z.number().nullable(),
})
const storedSchema = z.object({
  version: z.literal(1),
  draft: draftSchema,
  base: draftSchema,
  revision: z.number().int().nonnegative().optional(),
})
type StorageAccess = Pick<Storage, "getItem" | "setItem" | "removeItem">
export function createScorerDraftStore(
  key: string,
  initial: ScorerInput,
  revision?: number,
  storage: () => StorageAccess = () => localStorage
) {
  const initialDraft = draftSchema.parse(initial)
  let base = initialDraft
  let state = {
    draft: initialDraft,
    revision,
    dirty: false,
    ready: false,
    storageError: "",
  }
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((listener) => listener())
  const persist = () => {
    try {
      if (state.dirty)
        storage().setItem(
          key,
          JSON.stringify({
            version: 1,
            draft: state.draft,
            base,
            revision: state.revision,
          })
        )
      else storage().removeItem(key)
      state = { ...state, storageError: "" }
    } catch {
      state = {
        ...state,
        storageError:
          "This browser could not store the draft. Keep this page open and save your changes.",
      }
    }
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => state,
    hydrate() {
      if (state.ready) return
      try {
        const raw = storage().getItem(key)
        const parsed = raw ? storedSchema.safeParse(JSON.parse(raw)) : null
        if (parsed?.success) {
          const stored = parsed.data
          // A completed save can leave a stale draft in another tab. Don't resurrect it.
          if (JSON.stringify(stored.draft) !== JSON.stringify(initialDraft)) {
            base = stored.base
            state = {
              ...state,
              draft: stored.draft,
              revision: stored.revision,
              dirty: JSON.stringify(stored.draft) !== JSON.stringify(base),
            }
          } else storage().removeItem(key)
        }
      } catch {
        // Malformed or blocked storage must never prevent opening the editor.
      }
      state = { ...state, ready: true }
      emit()
    },
    update(value: ScorerInput | ((current: ScorerInput) => ScorerInput)) {
      const draft = draftSchema.parse(
        typeof value === "function" ? value(state.draft) : value
      )
      state = {
        ...state,
        draft,
        dirty: JSON.stringify(draft) !== JSON.stringify(base),
      }
      persist()
      emit()
    },
    saved(submitted: ScorerInput, nextRevision?: number) {
      base = draftSchema.parse(submitted)
      state = {
        ...state,
        revision: nextRevision,
        dirty: JSON.stringify(state.draft) !== JSON.stringify(base),
      }
      persist()
      emit()
      return !state.dirty
    },
    clear() {
      state = { ...state, dirty: false }
      persist()
      emit()
    },
    move(nextKey: string) {
      const previousKey = key
      key = nextKey
      persist()
      if (!state.storageError) {
        try {
          storage().removeItem(previousKey)
        } catch {
          /* The new draft is already safe. */
        }
      }
      emit()
      return !state.storageError
    },
  }
}
export type ScorerDraftStore = ReturnType<typeof createScorerDraftStore>
