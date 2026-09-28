"use client"

import * as React from "react"
import { Braces, Check, ChevronRight, Info, Loader2, Plus, Save, Upload, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Notice } from "@/components/ui/notice"
import type {
  Dataset,
  DatasetDetail,
  DatasetItem,
  DatasetItemPreview,
  PatchDatasetInput,
} from "@/src/lib/tracer/contracts"
import { compileCollectionFilter } from "@/src/lib/tracer/collection-filters"
import { useTableView } from "./use-table-view"
import type { ValueView } from "@/src/lib/tracer/value-views"
import {
  itemDraft,
  type ItemDraft,
} from "@/src/lib/tracer/dataset-editor"
import { DatasetAutosave, type AutosaveState } from "@/src/lib/tracer/dataset-autosave"
import { datasetItemPatch, datasetItemPreview, DATASET_ITEM_READ_MAX_BYTES } from "@/src/lib/tracer/dataset-payload"
import { downloadTraceExport } from "./trace-list-utils"
import { DatasetVersionHistory } from "./dataset-version-history"
import { tracerApi } from "./api"
import { CollectionPage } from "./collection-page"
import { CollectionFilterBar } from "./collection-filter"
import { CollectionPanel } from "./collection-panel"
import { HeaderSlot } from "./collection-header"
import { PanelActionLabel } from "@/components/ui/panel-action-label"
import { ConnectedEvalButton } from "./connected-eval-button"
import { DatasetDetailsInspector } from "./dataset-details-inspector"
import { DatasetImportDialog } from "./dataset-import-dialog"
import { DatasetItemInspector } from "./dataset-item-inspector"
import { DatasetItemsTable } from "./dataset-items-table"
import { DatasetSchemaDialog } from "./dataset-schema-dialog"
import { DockedInspector } from "./docked-inspector"
import { DatasetKindIcon } from "./dataset-kind-icon"
import { useRemote } from "./hooks"
import { ErrorState, LoadingState } from "./primitives"
import { useCollectionFilter } from "./use-collection-filter"
import { useCollectionPages } from "./use-collection-pages"
import { ColumnEditor, ComputedColumnDetails } from "./eval-computed-columns"
import { useComputedColumns } from "./use-computed-columns"
import { useWorkspaceStorageScope } from "./workspace-path"

export { DatasetsPage } from "./dataset-library-page"

export function DatasetDetailPage({ datasetId }: { datasetId: string }) {
  return <DatasetDetailSession key={datasetId} datasetId={datasetId} />
}

function DatasetDetailSession({ datasetId }: { datasetId: string }) {
  const storageScope = useWorkspaceStorageScope()
  const changeFieldView = (field: string, view: ValueView) => {
    tableView.onSettingsChange(current => ({
      ...current,
      fieldViews: { ...current.fieldViews, [field]: view },
    }))
  }
  const load = React.useCallback(
    () => tracerApi.datasets.get(datasetId, { includeItems: false }),
    [datasetId]
  )
  const datasetState = useRemote<DatasetDetail>(load, [datasetId])
  const filter = useCollectionFilter("datasetItems")
  const list = React.useCallback(
    (options: import("./api").CollectionListOptions) =>
      tracerApi.datasets.items(datasetId, { ...options, preview: true }),
    [datasetId]
  )
  const page = useCollectionPages(list, filter.filter, 0)
  const [datasetOverride, setDatasetOverride] = React.useState<Dataset | null>(
    null
  )
  const dataset = datasetOverride
    ? {
        ...datasetOverride,
        itemCount: datasetState.data?.itemCount ?? datasetOverride.itemCount,
      }
    : datasetState.data
  const [overrides, setOverrides] = React.useState<Record<string, DatasetItem>>(
    {}
  )
  const [deleted, setDeleted] = React.useState<Set<string>>(() => new Set())
  const [newIds, setNewIds] = React.useState<Set<string>>(() => new Set())
  const [drafts, setDrafts] = React.useState<Record<string, ItemDraft>>({})
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [checked, setChecked] = React.useState<Set<string>>(() => new Set())
  const [autosaves, setAutosaves] = React.useState<Record<string, AutosaveState>>({})
  const [version, setVersion] = React.useState<{ id: string; revision: number } | null>(null)
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const [pageError, setPageError] = React.useState("")
  const [schemaOpen, setSchemaOpen] = React.useState(false)
  const [importOpen, setImportOpen] = React.useState(false)
  const [mobileDetails, setMobileDetails] = React.useState(false)
  const returnFocus = React.useRef<HTMLElement | null>(null)
  const selectionRequest = React.useRef<AbortController | null>(null)
  const [rowError, setRowError] = React.useState("")
  React.useEffect(() => () => selectionRequest.current?.abort(), [])
  const refreshDataset = datasetState.refresh
  const refreshItems = page.refresh
  const [autosave] = React.useState(() => new DatasetAutosave({
    schemas: () => ({}),
    save: (item, values, isNew) => isNew
      ? tracerApi.datasets.createItem(datasetId, { id: item.id, ...values, sourceTraceId: values.sourceTraceId ?? undefined })
      : tracerApi.datasets.updateItem(item.id, datasetItemPatch(item, values)),
    changed: (id, state) => {
      setAutosaves(current => ({ ...current, [id]: state }))
      setOverrides(current => ({ ...current, [id]: state.preview }))
    },
    saved: () => {},
  }))
  React.useEffect(() => {
    autosave.configure({
      schemas: () => dataset?.fieldSchemas ?? {},
      saved: (item, wasNew) => {
        if (item.datasetVersionId) setVersion(current => !current || (item.datasetRevision ?? 0) >= current.revision
          ? { id: item.datasetVersionId!, revision: item.datasetRevision ?? 0 } : current)
        setNewIds(current => { const next = new Set(current); next.delete(item.id); return next })
        if (wasNew) { refreshDataset(); refreshItems() }
      },
    })
  }, [autosave, dataset?.fieldSchemas, refreshDataset, refreshItems])
  React.useEffect(() => {
    autosave.attach()
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (autosave.hasUnsavedChanges) { void autosave.flush(); event.preventDefault(); event.returnValue = "" }
    }
    window.addEventListener("beforeunload", beforeUnload)
    return () => { window.removeEventListener("beforeunload", beforeUnload); autosave.detach() }
  }, [autosave])
  const saveStates = Object.values(autosaves)
  const hasSaveError = saveStates.some(state => state.status === "error" || state.status === "invalid")
  const isSaving = saveStates.some(state => state.status === "pending" || state.status === "saving")
  const saveStatus = hasSaveError ? "Changes not saved" : isSaving ? "Saving…" : "Saved"
  const currentVersion = version && version.revision >= (dataset?.revision ?? 0) ? version.id : dataset?.versionId

  const allItems = React.useMemo(() => {
    const map = new Map<string, DatasetItemPreview>(page.items.map((item) => [item.id, item]))
    for (const item of Object.values(overrides)) map.set(item.id, item)
    return [...map.values()].filter((item) => !deleted.has(item.id))
  }, [page.items, overrides, deleted])
  const computed = useComputedColumns(
    `dataset:${datasetId}`,
    allItems.filter(item => !item.omittedFields),
    `datool:dataset-fields:${storageScope}:${datasetId}`
  )
  const tableView = useTableView({
    resource: "dataset-items",
    computed,
    settingsStorageKey: `datool:dataset-table:${storageScope}:${datasetId}`,
  })
  const { settings, storageError: settingsError } = tableView
  const matches = React.useMemo(
    () => compileCollectionFilter("datasetItems", filter.filter),
    [filter.filter]
  )
  // Preview rows were filtered in PostgreSQL against complete values.
  const items = React.useMemo(() => allItems.filter((item) => newIds.has(item.id) || item.omittedFields || matches(item)), [allItems, newIds, matches])
  const tableItems = React.useMemo(() => items.map(datasetItemPreview), [items])
  const selected = allItems.find((item) => item.id === selectedId)
  const selectedIndex = items.findIndex((item) => item.id === selectedId)
  const select = async (row: DatasetItemPreview, target?: HTMLElement) => {
    if (target) returnFocus.current = target
    selectionRequest.current?.abort()
    const controller = new AbortController()
    selectionRequest.current = controller
    setRowError("")
    if (selectedId && selectedId !== row.id) void autosave.flush(selectedId)
    setSelectedId(row.id)
    try {
      const item = overrides[row.id] ?? (row.omittedFields ? await tracerApi.datasets.getItem(row.id, controller.signal) : row)
      if (controller.signal.aborted) return
      setDrafts((current) =>
        current[item.id] ? current : { ...current, [item.id]: itemDraft(item) }
      )
      setOverrides((current) => ({
        ...current,
        [item.id]: current[item.id] ?? item,
      }))
    } catch (error) {
      if (!controller.signal.aborted) setRowError((error as Error).message)
    }
  }
  const close = () => {
    selectionRequest.current?.abort()
    if (selectedId) void autosave.flush(selectedId)
    setSelectedId(null)
    setMobileDetails(false)
    returnFocus.current?.focus()
  }

  async function exportItems(rows: DatasetItemPreview[], selected = false) {
    setPageError("")
    try {
      const complete: DatasetItem[] = []
      let bytes = 2
      for (const row of rows) {
        const item = row.omittedFields ? await tracerApi.datasets.getItem(row.id) : row
        bytes += new TextEncoder().encode(JSON.stringify(item, null, 2)).byteLength + 2
        if (bytes > DATASET_ITEM_READ_MAX_BYTES) throw new Error("Export exceeds 32 MiB. Select fewer rows.")
        complete.push(item)
      }
      downloadTraceExport({ content: JSON.stringify(complete, null, 2), filename: `datool-${selected ? "selected-" : ""}${dataset?.name.split("/").at(-1) ?? "dataset-rows"}.json`, type: "application/json" })
    } catch (error) { setPageError((error as Error).message) }
  }

  function addRow() {
    const id = `ditem_${crypto.randomUUID()}`
    const timestamp = new Date().toISOString()
    const row: DatasetItem = {
      id,
      datasetId,
      input: {},
      expectedOutput: {},
      metadata: {},
      sourceTraceId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    setOverrides((current) => ({ ...current, [id]: row }))
    setNewIds((current) => new Set(current).add(id))
    select(row)
    autosave.edit(row, itemDraft(row), true)
  }

  async function deleteRow(item: DatasetItem) {
    selectionRequest.current?.abort()
    setPageError("")
    setDeleted((current) => new Set(current).add(item.id))
    setSelectedId(null)
    try {
      const pending = await autosave.remove(item.id)
      if (!(pending?.isNew ?? newIds.has(item.id))) await tracerApi.datasets.deleteItem(item.id)
      setAutosaves(current => { const next = { ...current }; delete next[item.id]; return next })
      setChecked((current) => {
        const next = new Set(current)
        next.delete(item.id)
        return next
      })
      datasetState.refresh()
      page.refresh()
    } catch (reason) {
      setDeleted((current) => {
        const next = new Set(current)
        next.delete(item.id)
        return next
      })
      setPageError((reason as Error).message)
    }
  }

  async function saveDataset(patch: PatchDatasetInput) {
    if (!dataset) return
    const previous = datasetOverride
    setDatasetOverride({ ...dataset, ...patch })
    try {
      setDatasetOverride(await tracerApi.datasets.update(datasetId, patch))
    } catch (reason) {
      setDatasetOverride(previous)
      throw reason
    }
  }

  if (!dataset)
    return datasetState.error ? (
      <ErrorState error={datasetState.error} onRetry={datasetState.refresh} />
    ) : (
      <LoadingState label="Loading dataset" />
    )
  return (
    <>
      <HeaderSlot name="filter">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <ChevronRight className="size-3.5 shrink-0 text-foreground-muted" />
          <span aria-hidden="true" className="shrink-0 [&>svg]:size-4">
            <DatasetKindIcon kind="dataset" />
          </span>
          <h1 className="truncate font-medium" title={dataset.name}>
            {dataset.name.split("/").at(-1)}
          </h1>
        </div>
      </HeaderSlot>
      <HeaderSlot name="display">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 text-xs text-foreground-muted">
            <span role="status" className="sr-only items-center gap-1.5 xl:not-sr-only xl:inline-flex">
              {isSaving ? <Loader2 className="size-3.5 animate-spin" /> : !hasSaveError ? <Check className="size-3.5" /> : null}
              {saveStatus}
            </span>
            <Button size="responsive-sm" variant="ghost" onClick={() => setHistoryOpen(true)} aria-label="Dataset version history" title={`${saveStatus} · Version ${currentVersion?.slice(0, 8) ?? "—"}`}>
              <Save aria-hidden="true" className={cn("size-3.5 xl:hidden", isSaving && "animate-pulse motion-reduce:animate-none", hasSaveError && "text-destructive")} />
              <span className="hidden text-foreground-muted xl:inline">Version</span>
              <span className="hidden font-mono xl:inline">{currentVersion?.slice(0, 8) ?? "—"}</span>
            </Button>
          </div>
          <Button
            size="responsive-sm"
            variant="outline"
            aria-label="Field schemas"
            title="Field schemas"
            onClick={() => setSchemaOpen(true)}
          >
            <Braces className="size-3.5" />
            <span className="hidden xl:inline">Field schemas</span>
          </Button>
          <ConnectedEvalButton datasetId={datasetId} compact />
        </div>
      </HeaderSlot>
      <CollectionPanel label="Dataset rows">
        <HeaderSlot name="actions">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setImportOpen(true)}
          >
            <Upload className="size-3.5" />
            <PanelActionLabel>Import</PanelActionLabel>
          </Button>
          <Button size="sm" variant="outline" onClick={addRow}>
            <Plus className="size-3.5" />
            <PanelActionLabel>Row</PanelActionLabel>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label="Dataset details"
            onClick={() => {
              setSelectedId(null)
              setMobileDetails(true)
            }}
          >
            <Info className="size-4" />
          </Button>
        </HeaderSlot>
        {pageError && (
          <Notice role="alert" variant="error" className="m-2">
            {pageError}
          </Notice>
        )}
        {datasetState.error && (
          <Notice role="alert" variant="error" className="m-2">
            {datasetState.error.message}
          </Notice>
        )}
        <CollectionPage
          savedView={tableView.savedView}
          state={{
            ...page,
            refresh: () => {
              datasetState.refresh()
              page.refresh()
              setDatasetOverride(null)
              setOverrides((current) =>
                Object.fromEntries(
                  Object.entries(current).filter(
                    ([id]) =>
                      newIds.has(id) || (autosaves[id] && autosaves[id].status !== "saved") || id === selectedId
                  )
                )
              )
            },
          }}
          loadingLabel="Loading dataset rows"
          pagination={page}
          selection={{
            rows: items.filter((item) => checked.has(item.id)),
            onExportJson: () => void exportItems(items.filter(item => checked.has(item.id)), true),
            onClear: () => setChecked(new Set()),
          }}
          className="p-2"
          header={{
            onExportJson: () => void exportItems(items),
            exportName: dataset.name.split("/").at(-1) ?? "dataset-rows",
            children: (
              <CollectionFilterBar
                resource="datasetItems"
                {...filter}
                isLoading={page.isLoading || page.isRefreshing}
              />
            ),
          }}
        >
          <DatasetItemsTable
            items={tableItems}
            computed={computed}
            checked={checked}
            onCheck={setChecked}
            selectedId={selectedId}
            onSelect={select}
            filtered={!!filter.filter}
            datasetId={datasetId}
            drafts={newIds}
            settings={settings}
            settingsError={settingsError}
            onSettingsChange={tableView.onSettingsChange}
            onFieldViewChange={changeFieldView}
          />
        </CollectionPage>
      </CollectionPanel>
      <DockedInspector
        title={selected ? "Dataset row" : "Dataset details"}
        mobileOpen={!!selected || mobileDetails}
        onMobileClose={close}
      >
        <div className="h-full min-h-0">
          <div className={selected ? "hidden" : "h-full"}>
            <DatasetDetailsInspector
              dataset={dataset}
              onSave={saveDataset}
              onClose={close}
            />
          </div>
          {selected && !drafts[selected.id] ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
                <span className="text-sm">Dataset row</span>
                <Button variant="ghost" size="icon-sm" aria-label="Close dataset row" onClick={close}><X className="size-4" /></Button>
              </div>
              {rowError ? <ErrorState error={new Error(rowError)} onRetry={() => void select(selected)} /> : <LoadingState label="Loading complete dataset row" />}
            </div>
          ) : null}
          {selected && drafts[selected.id] ? (
            <DatasetItemInspector
              item={selected}
              customColumnDetails={
                <>
                  {computed.storageError && (
                    <Notice variant="error" role="status" className="my-3">
                      {computed.storageError}
                    </Notice>
                  )}
                  <ComputedColumnDetails
                    columns={computed.columns}
                    cells={computed.cells}
                    rowId={selected.id}
                    onRemove={(id) => {
                      void computed.update(
                        computed.columns.filter((column) => column.id !== id)
                      )
                    }}
                    action={
                      <ColumnEditor
                        borderless
                        resource="dataset"
                        addLabel="Add custom field"
                        addedFields={computed.columns}
                        rows={[selected, ...allItems.filter((item) => item.id !== selected.id && !item.omittedFields)]}
                        onSave={(column) =>
                          computed.update([...computed.columns, column])
                        }
                      />
                    }
                  />
                </>
              }
              draft={drafts[selected.id]}
              onDraftChange={(draft) => {
                setDrafts((current) => ({ ...current, [selected.id]: draft }))
                autosave.edit(selected, draft, newIds.has(selected.id))
              }}
              schemas={dataset.fieldSchemas ?? {}}
              fieldViews={settings.fieldViews}
              onFieldViewChange={changeFieldView}
              onRetry={() => void autosave.retry(selected.id)}
              onDelete={() => void deleteRow(selected)}
              onClose={close}
              onPrevious={
                selectedIndex > 0
                  ? () => select(items[selectedIndex - 1])
                  : undefined
              }
              onNext={
                selectedIndex >= 0 && selectedIndex < items.length - 1
                  ? () => select(items[selectedIndex + 1])
                  : undefined
              }
              saving={autosaves[selected.id]?.status === "saving"}
              isNew={newIds.has(selected.id)}
              error={autosaves[selected.id]?.status === "error" ? autosaves[selected.id]?.error : undefined}
            />
          ) : null}
        </div>
      </DockedInspector>
      {historyOpen && <DatasetVersionHistory datasetId={datasetId} onClose={() => setHistoryOpen(false)} />}
      {schemaOpen && (
        <DatasetSchemaDialog
          schemas={dataset.fieldSchemas ?? {}}
          sample={selected ?? items[0]}
          onClose={() => setSchemaOpen(false)}
          onSave={(fieldSchemas) => saveDataset({ fieldSchemas })}
        />
      )}
      {importOpen && (
        <DatasetImportDialog
          onClose={() => setImportOpen(false)}
          onImport={async (rows) => {
            await tracerApi.datasets.importItems(datasetId, rows)
            page.refresh()
            datasetState.refresh()
          }}
        />
      )}
    </>
  )
}
