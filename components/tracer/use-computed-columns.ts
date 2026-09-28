"use client"

import * as React from "react"
import {
  evaluateColumn,
  type ComputedCell,
  type ComputedColumn,
  type ComputedRow,
} from "@/src/lib/tracer/computed-columns"
import { useFieldRegistry } from "./custom-field-registry"
import { useWorkspaceStorageScope } from "./workspace-path"
import { createComputedColumnStore } from "@/src/lib/tracer/computed-column-store"

const emptyRegistry: ComputedColumn[] = []
const stores = new Map<string, ReturnType<typeof createComputedColumnStore>>()

export function useComputedColumns(runId: string, rows: ComputedRow[], storageKey?: string) {
  const fieldRegistry = useFieldRegistry()
  const scope = useWorkspaceStorageScope()
  const scopedKey = storageKey?.includes(scope) ? storageKey : `datool:eval-columns:${scope}:${storageKey ?? runId}`
  const store = React.useMemo(
    () => {
      const existing = stores.get(scopedKey)
      if (existing) return existing
      const store = createComputedColumnStore(runId, () => localStorage, scopedKey, async (columns, previous) => {
      const saved = []
      for (const column of columns) {
        const old = previous.find(item => item.id === column.id)
        const registered = fieldRegistry.get().find(item => item.id === column.id)
        saved.push(registered && registered.code === column.code && registered.name === column.name && registered.mode === column.mode && registered.format === column.format ? registered : await fieldRegistry.save(column, !!old && JSON.stringify(old) !== JSON.stringify(column)))
      }
      return [...new Map(saved.map(column => [column.id, column])).values()]
      })
      stores.set(scopedKey, store)
      return store
    },
    [runId, scopedKey, fieldRegistry]
  )
  const { columns: storedColumns, storageError } = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot
  )
  const registry = React.useSyncExternalStore(fieldRegistry.subscribe, fieldRegistry.get, () => emptyRegistry)
  const columns = React.useMemo(() => fieldRegistry.resolve(storedColumns, registry), [fieldRegistry, storedColumns, registry])
  React.useEffect(() => {
    if (!store.getSnapshot().loaded) store.load()
    void fieldRegistry.migrate(scopedKey).then(() => { store.load(); store.select(fieldRegistry.resolve(store.getSnapshot().columns)) })
      .catch(() => { /* Retain local fields; the editor exposes registry failures. */ })
    const refresh = () => { void fieldRegistry.refresh().then(() => store.select(fieldRegistry.resolve(store.getSnapshot().columns))).catch(() => {}) }
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [store, fieldRegistry, scopedKey])
  return {
    store,
    columns,
    update: store.update,
    storageError,
    cells: useColumnValues(rows, columns),
  }
}

export function useColumnValues(
  rows: ComputedRow[],
  columns: ComputedColumn[]
) {
  // Polling returns new objects even for unchanged data. Recompute only when the
  // actual inputs change, so cells do not flash every three seconds.
  const inputs = JSON.stringify({ rows, columns })
  const [result, setResult] = React.useState<{
    inputs: string
    cells: Record<string, Record<string, ComputedCell>>
  }>({ inputs: "", cells: {} })
  React.useEffect(() => {
    const controller = new AbortController()
    const data = JSON.parse(inputs) as {
      rows: ComputedRow[]
      columns: ComputedColumn[]
    }
    void Promise.all(
      data.columns.map(
        async (column) =>
          [
            column.id,
            await evaluateColumn(data.rows, column, controller.signal),
          ] as const
      )
    ).then((entries) => {
      if (!controller.signal.aborted)
        setResult({ inputs, cells: Object.fromEntries(entries) })
    })
    return () => controller.abort()
  }, [inputs])
  return result.inputs === inputs ? result.cells : {}
}
