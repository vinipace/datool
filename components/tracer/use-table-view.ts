"use client"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import type { ComputedColumnStore } from "@/src/lib/tracer/computed-column-store"
import type { ComputedColumn } from "@/src/lib/tracer/computed-columns"
import { defaultTableSettings, evalViewSettingsSchema, type CustomView, type EvalViewSettings, type CollectionTableSettings } from "@/src/lib/tracer/custom-views"
import { createColumnOrderStore } from "@/src/lib/tracer/collection-column-order"
import { createTableSettingsStore } from "@/src/lib/tracer/table-settings-store"
import { createPageViewSelectionStore } from "@/src/lib/tracer/page-view-drafts"
import { pageResourceForPath, pageViewPathname, pageViewQueryParams, applyPageViewQueryParams } from "@/src/lib/tracer/view-resources"
import { useProjectScope } from "./project-scope-context"
import { callViewOperation } from "./view-library-client"
import { useComputedColumns } from "./use-computed-columns"

/** Page drafts stay in this browser; shared definitions change only on explicit save. */
export function useTableView({
  resource: explicitResource, settingsStorageKey, orderStorageKey, computed: suppliedComputed, defaultSettings, selectedView, details, persistenceEnabled = true,
}: {
  resource?: CustomView["resource"]
  persistenceEnabled?: boolean
  settingsStorageKey?: string
  orderStorageKey?: string
  computed?: { store: ComputedColumnStore; columns: ComputedColumn[] }
  defaultSettings?: CollectionTableSettings
  selectedView?: { id: string | null; onSelect: (id: string | null) => void }
  details?: { open: boolean; onOpenChange: (open: boolean) => void }
}) {
  const projectId = useProjectScope()?.projectId ?? ""
  const pathname = pageViewPathname(usePathname() ?? "/")
  const search = useSearchParams()
  const resource = explicitResource ?? pageResourceForPath(pathname, settingsStorageKey)
  const automaticComputed = useComputedColumns(`page:${pathname}:${resource ?? "table"}`, [])
  const computed = suppliedComputed ?? automaticComputed
  const settingsStore = useMemo(() => createTableSettingsStore(settingsStorageKey, undefined, defaultSettings), [settingsStorageKey, defaultSettings])
  const { settings, loaded, error } = useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot, settingsStore.getServerSnapshot)
  const orderStore = useMemo(() => createColumnOrderStore(orderStorageKey ? projectId + ":" + orderStorageKey : undefined), [orderStorageKey, projectId])
  const columnOrder = useSyncExternalStore(orderStore.subscribe, orderStore.getSnapshot, orderStore.getServerSnapshot)
  useEffect(() => { settingsStore.load(); orderStore.load() }, [settingsStore, orderStore])
  const draftStorageKey = `datool:page-view:${encodeURIComponent(projectId)}:${encodeURIComponent(pathname)}:${resource ?? "table"}`
  const selectionKey = `${draftStorageKey}:selected`
  const selectionStore = useMemo(() => createPageViewSelectionStore(selectionKey), [selectionKey])
  const selection = useSyncExternalStore(selectionStore.subscribe, selectionStore.getSnapshot, selectionStore.getServerSnapshot)
  const [extra, setExtra] = useState<Pick<EvalViewSettings, "pageSettings" | "objectViews" | "query" | "renderer">>({})
  const [applyError, setApplyError] = useState("")
  const [defaultDetailsOpen] = useState(details?.open ?? false)
  const baseSettings = useMemo<EvalViewSettings>(() => ({
    schemaVersion: 1, ...(defaultSettings ?? defaultTableSettings), computedColumns: [], customFields: [], columnOrder: [], detailsOpen: defaultDetailsOpen, queryParams: {},
  }), [defaultSettings, defaultDetailsOpen])
  useEffect(() => {
    if (!persistenceEnabled) return
    selectionStore.load()
  }, [selectionStore, persistenceEnabled])
  const onDetailsChange = details?.onOpenChange
  const applying = useRef(0)
  useEffect(() => () => { applying.current++ }, [projectId, settingsStore])
  const applyView = useCallback(async (value: EvalViewSettings, restoreQuery = true) => {
    const next = evalViewSettingsSchema.parse(value)
    const generation = ++applying.current
    const fields = next.customFields
      ? await Promise.all(next.customFields.map(async ref => {
          const field = await callViewOperation<ComputedColumn>(projectId, "get_custom_field", ref)
          return ref.revision ? { ...field, pinnedRevision: ref.revision } : field
        }))
      : next.computedColumns
    for (const ref of Object.values(next.objectViews ?? {})) if (ref) await callViewOperation(projectId, "get_object_view", ref)
    if (generation !== applying.current) throw new Error("The page changed before this Page View could be applied.")
    // Resolve all dependencies before publishing any page state.
    computed?.store.select(fields)
    orderStore.set(next.columnOrder)
    settingsStore.set({ columnVisibility: next.columnVisibility, columnSizing: next.columnSizing, view: next.view, rowHeight: next.rowHeight, fieldViews: next.fieldViews })
    onDetailsChange?.(next.detailsOpen)
    setExtra({ pageSettings: next.pageSettings, objectViews: next.objectViews, query: next.query, renderer: next.renderer })
    if (restoreQuery) {
      const params = applyPageViewQueryParams(new URLSearchParams(window.location.search), next.queryParams ?? {})
      window.history.replaceState(null, "", window.location.pathname + "?" + params)
    }
    window.dispatchEvent(new CustomEvent("datool:page-view-applied", { detail: { projectId, settings: next } }))
    setApplyError("")
  }, [projectId, computed?.store, orderStore, settingsStore, onDetailsChange])
  const incomingId = search?.get("pageView") ?? selectedView?.id ?? selection.id
  const queryParams = pageViewQueryParams(new URLSearchParams(search?.toString()))
  const viewSettings: EvalViewSettings = {
    ...extra, schemaVersion: 1, ...settings, computedColumns: [],
    customFields: computed?.columns.map(field => ({ id: field.id, ...(field.pinnedRevision ? { revision: field.pinnedRevision } : {}) })) ?? [],
    columnOrder, detailsOpen: details?.open ?? false, queryParams,
  }
  const onSelect = useCallback((id: string | null) => {
    selectionStore.set(id)
    selectedView?.onSelect(id)
    const params = new URLSearchParams(window.location.search)
    if (id) params.set("pageView", id); else params.delete("pageView")
    params.delete("pageViewRevision")
    window.history.replaceState(null, "", window.location.pathname + (params.size ? "?" + params : ""))
  }, [selectedView, selectionStore])
  return {
    settings, onSettingsChange: settingsStore.set, columnOrderStore: orderStore, computed, resource,
    storageError: applyError || selection.error || error,
    savedView: persistenceEnabled && loaded && selection.loaded && resource ? { resource, settings: viewSettings, defaultSettings: baseSettings, storageKey: draftStorageKey, onApply: applyView, viewId: incomingId, onSelect } : undefined,
  }
}
