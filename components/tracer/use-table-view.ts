"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import type { ComputedColumnStore } from "@/src/lib/tracer/computed-column-store"
import type { ComputedColumn } from "@/src/lib/tracer/computed-columns"
import type {
  CustomView,
  EvalViewSettings,
  LogTableSettings,
} from "@/src/lib/tracer/custom-views"
import { createColumnOrderStore } from "@/src/lib/tracer/log-column-order"
import { createTableSettingsStore } from "@/src/lib/tracer/table-settings-store"

/** Shared persistence and saved-view wiring, with optional custom columns. */
export function useTableView({
  resource,
  settingsStorageKey,
  orderStorageKey,
  computed,
  defaultSettings,
  selectedView,
  details,
}: {
  resource?: CustomView["resource"]
  settingsStorageKey?: string
  orderStorageKey?: string
  computed?: { store: ComputedColumnStore; columns: ComputedColumn[] }
  defaultSettings?: LogTableSettings
  selectedView?: { id: string | null; onSelect: (id: string | null) => void }
  details?: { open: boolean; onOpenChange: (open: boolean) => void }
}) {
  const settingsStore = useMemo(
    () => createTableSettingsStore(settingsStorageKey, undefined, defaultSettings),
    [settingsStorageKey, defaultSettings]
  )
  const { settings, loaded, error } = useSyncExternalStore(
    settingsStore.subscribe,
    settingsStore.getSnapshot,
    settingsStore.getServerSnapshot
  )
  const orderStore = useMemo(
    () => createColumnOrderStore(orderStorageKey),
    [orderStorageKey]
  )
  const columnOrder = useSyncExternalStore(
    orderStore.subscribe,
    orderStore.getSnapshot,
    orderStore.getServerSnapshot
  )
  useEffect(() => {
    settingsStore.load()
    orderStore.load()
  }, [settingsStore, orderStore])
  const [viewId, setViewId] = useState<string | null>(null)
  const onDetailsChange = details?.onOpenChange
  const applyView = useCallback(
    (next: EvalViewSettings) => {
      void computed?.store.update(next.computedColumns)
      orderStore.set(next.columnOrder)
      settingsStore.set(current => ({
        ...current,
        columnVisibility: next.columnVisibility,
        columnSizing: next.columnSizing,
        view: next.view,
        rowHeight: next.rowHeight,
      }))
      onDetailsChange?.(next.detailsOpen)
    },
    [computed?.store, orderStore, settingsStore, onDetailsChange]
  )
  const viewSettings: EvalViewSettings = {
    schemaVersion: 1,
    columnVisibility: settings.columnVisibility,
    columnSizing: settings.columnSizing,
    view: settings.view,
    rowHeight: settings.rowHeight,
    computedColumns: computed?.columns ?? [],
    columnOrder,
    detailsOpen: details?.open ?? false,
  }
  return {
    settings,
    onSettingsChange: settingsStore.set,
    columnOrderStore: orderStore,
    storageError: error,
    savedView: loaded && resource
      ? {
          resource,
          settings: viewSettings,
          onApply: applyView,
          viewId: selectedView ? selectedView.id : viewId,
          onSelect: selectedView?.onSelect ?? setViewId,
        }
      : undefined,
  }
}
