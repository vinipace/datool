import { defaultTableSettings, evalViewSettingsSchema, type CollectionTableSettings } from "./custom-views"
import { z } from "zod"
import { valueViews } from "./value-views"

const schema = evalViewSettingsSchema.pick({ columnVisibility: true, columnSizing: true, view: true, rowHeight: true }).extend({ fieldViews: z.record(z.string(), z.enum(valueViews)).optional() })
export function createTableSettingsStore(key?: string, storage: () => Pick<Storage, "getItem" | "setItem"> = () => localStorage, defaults: CollectionTableSettings = defaultTableSettings) {
  const initial = { settings: defaults, loaded: !key, error: "" }
  let snapshot = initial
  const listeners = new Set<() => void>()
  const publish = (next: typeof initial) => { snapshot = next; listeners.forEach(listener => listener()) }
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initial,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    load: () => {
      if (!key) return
      try {
        const raw = storage().getItem(key)
        publish({ settings: raw ? schema.parse(JSON.parse(raw)) : defaults, loaded: true, error: "" })
      } catch { publish({ ...snapshot, loaded: true, error: "Saved table settings could not be loaded." }) }
    },
    set: (change: CollectionTableSettings | ((current: CollectionTableSettings) => CollectionTableSettings)) => {
      const settings = schema.parse(typeof change === "function" ? change(snapshot.settings) : change)
      let error = ""
      try { if (key) storage().setItem(key, JSON.stringify(settings)) }
      catch { error = "Table settings could not be saved in this browser." }
      publish({ settings, loaded: true, error })
    },
  }
}
