import { z } from "zod"
import { customViewSchema, evalViewSettingsSchema, type CustomView, type EvalViewSettings } from "./custom-views"

const draftSchema = z.object({ base: customViewSchema.nullable(), settings: evalViewSettingsSchema })
export type PageViewDraft = { base: CustomView | null; settings: EvalViewSettings }

/** Keep each view's draft and original revision until an explicit save or reset. */
export function createPageViewDraftStore(scope: string, storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem"> = () => localStorage) {
  const memory = new Map<string | null, PageViewDraft | null>()
  let defaultBaseline: EvalViewSettings | null = null
  let error = ""
  const listeners = new Set<() => void>()
  const report = (message: string) => {
    if (error === message) return
    error = message
    listeners.forEach(listener => listener())
  }
  const key = (id: string | null) => `${scope}:draft:${encodeURIComponent(id ?? "default")}`
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getError: () => error,
    report,
    defaultBaseline(initial: EvalViewSettings): EvalViewSettings {
      if (defaultBaseline) return defaultBaseline
      const raw = storage().getItem(`${scope}:baseline:default`)
      defaultBaseline = raw ? evalViewSettingsSchema.parse(JSON.parse(raw)) : initial
      // Adopt existing preferences once, before tracking edits. Keep this separate
      // from the draft so reloads and view switches cannot turn an edit into a baseline.
      if (!raw) {
        try { storage().setItem(`${scope}:baseline:default`, JSON.stringify(defaultBaseline)) }
        catch { report("The default Page View settings could not be stored in this browser.") }
      }
      return defaultBaseline
    },
    read(id: string | null): PageViewDraft | null {
      if (memory.has(id)) return memory.get(id) ?? null
      const raw = storage().getItem(key(id))
      if (!raw) return null
      const draft = draftSchema.parse(JSON.parse(raw))
      if ((draft.base?.id ?? null) !== id) throw new Error("The local draft belongs to a different Page View.")
      memory.set(id, draft)
      return draft
    },
    write(id: string | null, draft: PageViewDraft) {
      memory.set(id, draft)
      try { storage().setItem(key(id), JSON.stringify(draft)); report("") }
      catch { report("Changes could not be stored in this browser. Keep this page open until you save them.") }
    },
    clear(id: string | null) {
      memory.set(id, null)
      try { storage().removeItem(key(id)); report("") }
      catch { report("The local Page View draft could not be cleared in this browser.") }
    },
  }
}

export function createPageViewSelectionStore(key: string, storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem"> = () => localStorage) {
  const initial = { id: null as string | null, loaded: false, error: "" }
  let state = initial
  const listeners = new Set<() => void>()
  const publish = (next: typeof state) => { state = next; listeners.forEach(listener => listener()) }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    load() {
      try { publish({ id: storage().getItem(key), loaded: true, error: "" }) }
      catch { publish({ id: null, loaded: true, error: "The selected Page View could not be loaded from this browser." }) }
    },
    set(id: string | null) {
      let error = ""
      try { if (id) storage().setItem(key, id); else storage().removeItem(key) }
      catch { error = "The selected Page View could not be saved in this browser." }
      publish({ id, loaded: true, error })
    },
  }
}
