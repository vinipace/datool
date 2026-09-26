import { parseComputedColumns, type ComputedColumn } from "./computed-columns"

type ColumnStorage = Pick<Storage, "getItem" | "setItem">
type ColumnSnapshot = {
  columns: ComputedColumn[]
  loaded: boolean
  storageError: string | null
}

/** One synchronous source for UI and agent edits, including back-to-back calls
 * before React renders. WebMCP writes are atomic with browser persistence. */
export function createComputedColumnStore(
  runId: string,
  storage: () => ColumnStorage,
  storageKey = `datool:eval-columns:${runId}`,
  persist?: (columns: ComputedColumn[], previous: ComputedColumn[]) => Promise<ComputedColumn[]>
) {
  const key = storageKey
  const initial: ColumnSnapshot = {
    columns: [],
    loaded: false,
    storageError: null,
  }
  let snapshot = initial
  const listeners = new Set<() => void>()
  const publish = (next: ColumnSnapshot) => {
    snapshot = next
    listeners.forEach((listener) => listener())
  }
  return {
    runId,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initial,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    load: () => {
      try {
        publish({
          columns: parseComputedColumns(storage().getItem(key)),
          loaded: true,
          storageError: null,
        })
      } catch {
        publish({
          ...snapshot,
          storageError: "Saved columns could not be loaded in this browser.",
        })
      }
    },
    update: (
      change:
        | ComputedColumn[]
        | ((current: ComputedColumn[]) => ComputedColumn[]),
      requirePersistence = false
    ) => {
      if (requirePersistence && !snapshot.loaded)
        throw new Error(snapshot.storageError ?? "Columns are still loading.")
      const columns =
        typeof change === "function" ? change(snapshot.columns) : change
      const save = (columns: ComputedColumn[]) => {
      try {
        storage().setItem(key, JSON.stringify(columns))
      } catch {
        const storageError = "Columns could not be saved in this browser."
        publish({
          ...snapshot,
          ...(requirePersistence ? {} : { columns }),
          storageError,
        })
        if (requirePersistence)
          throw new Error(storageError + " No changes were applied.")
        return
      }
      publish({ columns, loaded: true, storageError: null })
      }
      if (persist) return persist(columns, snapshot.columns).then(save).catch(error => {
        publish({ ...snapshot, storageError: error instanceof Error ? error.message : "Custom fields could not be saved." })
        if (requirePersistence) throw error
      })
      save(columns)
    },
  }
}

export type ComputedColumnStore = ReturnType<typeof createComputedColumnStore>
