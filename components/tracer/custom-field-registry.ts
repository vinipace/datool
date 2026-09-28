"use client"
import { useMemo } from "react"
import { projectFetch } from "@/lib/workspace-routing"
import { parseComputedColumns, type ComputedColumn } from "@/src/lib/tracer/computed-columns"
import { customFieldInputSchema, customFieldSchema } from "@/src/lib/tracer/custom-fields"
import { useProjectScope } from "./project-scope-context"

const registries = new Map<string, ReturnType<typeof createRegistry>>()
const empty: ComputedColumn[] = []
function createRegistry(projectId: string) {
  let fields: ComputedColumn[] = []
  let loaded = false
  let loading: Promise<ComputedColumn[]> | null = null
  const listeners = new Set<() => void>()
  const migrations = new Map<string, Promise<void>>()
  const publish = (next: ComputedColumn[]) => { fields = next; listeners.forEach(listener => listener()) }
  async function request(path: string, init?: RequestInit) {
    if (!projectId) throw new Error("Select a project before using Custom Fields.")
    const response = await projectFetch(path, init, projectId)
    const body = await response.json()
    if (!response.ok) throw new Error(body.error?.message ?? "Custom Fields could not be saved.")
    return body.data
  }
  const registry = {
    get: () => fields,
    serverSnapshot: () => empty,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    async refresh(force = true) {
      if (!projectId) return fields
      if (loaded && !force) return fields
      if (loading) return loading
      loading = (async () => {
      const items: ComputedColumn[] = []
      let cursor: string | null = null
      do {
        const page = await request("/api/custom-fields?catalog=1&limit=100" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""))
        items.push(...page.items.map((field: unknown) => customFieldSchema.parse(field)))
        cursor = page.nextCursor
      } while (cursor)
      publish(items)
      loaded = true
      return fields
      })()
      try { return await loading }
      finally { loading = null }
    },
    async save(field: ComputedColumn, overwrite = false) {
      const existing = fields.find(item => item.id === field.id)
      if (existing && !overwrite) return existing
      const definition = customFieldInputSchema.strip().parse({ ...existing, ...field })
      const saved = customFieldSchema.parse(await request(existing ? "/api/custom-fields/" + encodeURIComponent(existing.id) : "/api/custom-fields", {
        method: existing ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(existing ? { ...definition, expectedRevision: field.revision ?? existing.revision } : definition),
      }))
      publish([...fields.filter(item => item.id !== saved.id), saved])
      return saved
    },
    async migrate(storageKey?: string) {
      await registry.refresh(false)
      // Only the active project's explicitly owned selection is eligible.
      if (!storageKey?.includes(":" + encodeURIComponent(projectId) + ":")) return
      if (!migrations.has(storageKey)) migrations.set(storageKey, (async () => {
        const previous = localStorage.getItem(storageKey)
        const migrated = []
        for (const field of parseComputedColumns(previous)) migrated.push(await registry.save(field))
        if (localStorage.getItem(storageKey) === previous) localStorage.setItem(storageKey, JSON.stringify(migrated))
      })().catch(error => { migrations.delete(storageKey); throw error }))
      await migrations.get(storageKey)
    },
    resolve(columns: ComputedColumn[], source = fields) {
      return [...new Map(columns.map(column => {
        const saved = column.pinnedRevision ? column : source.find(field => field.id === column.id) ?? column
        return [saved.id, saved]
      })).values()]
    },
  }
  return registry
}
export function useFieldRegistry() {
  const projectId = useProjectScope()?.projectId ?? ""
  return useMemo(() => {
    if (!registries.has(projectId)) registries.set(projectId, createRegistry(projectId))
    return registries.get(projectId)!
  }, [projectId])
}
