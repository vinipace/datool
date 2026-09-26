/** Reconcile saved order with dynamic columns, keeping table controls fixed. */
export function resolveLogColumnOrder(source: string[], saved: string[], actions: string[] = []) {
  const movable = source.filter(id => id !== "__select" && !actions.includes(id))
  const ordered = [...new Set([...saved.filter(id => movable.includes(id)), ...movable])]
  return [
    ...source.filter(id => id === "__select"),
    ...ordered,
    ...source.filter(id => actions.includes(id)),
  ]
}

export function createColumnOrderStore(storageKey?: string, storage: () => Pick<Storage, "getItem" | "setItem"> = () => localStorage) {
  const initial: string[] = []
  let order = initial
  let loaded = !storageKey
  let loadError: string | null = null
  const listeners = new Set<() => void>()
  const publish = (next: string[]) => {
    order = next
    listeners.forEach(listener => listener())
  }
  return {
    getSnapshot: () => order,
    getServerSnapshot: () => initial,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    load: () => {
      if (!storageKey) return
      try {
        const value: unknown = JSON.parse(storage().getItem(storageKey) ?? "[]")
        if (!Array.isArray(value) || !value.every(id => typeof id === "string")) throw new Error("Invalid saved order")
        loaded = true
        loadError = null
        publish(value)
      } catch { loadError = "Saved column order could not be loaded in this browser." }
    },
    set: (next: string[], requirePersistence = false) => {
      if (requirePersistence && (!loaded || loadError)) throw new Error(loadError ?? "Column order is still loading.")
      if (requirePersistence && !storageKey) throw new Error("Column order persistence is unavailable.")
      if (storageKey) {
        try { storage().setItem(storageKey, JSON.stringify(next)) } catch {
          if (requirePersistence) throw new Error("Column order could not be saved in this browser. No changes were applied.")
        }
      }
      publish(next)
    },
  }
}

export type ColumnOrderStore = ReturnType<typeof createColumnOrderStore>

export type EvalColumnLayout = {
  order: ColumnOrderStore
  getColumns: () => { id: string; name: string }[]
}
