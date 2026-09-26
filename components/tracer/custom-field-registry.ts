"use client"
import { projectFetch } from "@/lib/workspace-routing"

import { parseComputedColumns, type ComputedColumn } from "@/src/lib/tracer/computed-columns"

let fields: ComputedColumn[] = []
const listeners = new Set<() => void>()
let migration: Promise<void> | undefined
async function request(init?: RequestInit): Promise<ComputedColumn[] | ComputedColumn> {
  const response = await projectFetch("/api/custom-fields", init)
  const body = await response.json()
  if (!response.ok) throw new Error(body.error?.message ?? "Custom fields could not be saved.")
  return body.data
}
export const fieldRegistry = {
  get: () => fields,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  async refresh() {
    fields = await request() as ComputedColumn[]
    listeners.forEach(listener => listener())
    return fields
  },
  async save(field: ComputedColumn, overwrite = false) {
    const saved = await request({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ field, overwrite }) }) as ComputedColumn
    fields = [...fields.filter(item => item.id !== saved.id), saved]
    listeners.forEach(listener => listener())
    return saved
  },
  async migrate() {
    migration ??= (async () => {
      await fieldRegistry.refresh()
      const legacy = new Map<string, ComputedColumn>()
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key?.startsWith("datool:eval-columns:")) {
          for (const field of parseComputedColumns(localStorage.getItem(key))) legacy.set(field.id, field)
        }
      }
      for (const field of legacy.values()) await fieldRegistry.save(field)
    })().catch(error => { migration = undefined; throw error })
    return migration
  },
  resolve(columns: ComputedColumn[], registry = fields) {
    return [...new Map(columns.map(column => {
      const saved = registry.find(field => field.id === column.id) ?? registry.find(field => field.name.toLowerCase() === column.name.toLowerCase() && field.code === column.code && field.mode === column.mode && (field.format ?? "text") === (column.format ?? "text")) ?? column
      return [saved.id, saved]
    })).values()]
  },
}
