"use client"

import * as React from "react"
import { Notice } from "@/components/ui/notice"
import { Workflow } from "lucide-react"
import { CollectionDisplaySkeleton, CollectionHistogramSkeleton, CollectionTableSkeleton } from "@/components/ui/collection-skeleton"
import { HeaderSlot } from "./collection-header"
import {
  usePathname,
  useRouter,
  useSearchParams,
  type ReadonlyURLSearchParams,
} from "next/navigation"

import { useComputedColumns } from "./use-computed-columns"
import { useTableView } from "./use-table-view"
import { useWorkspaceStorageScope } from "./workspace-path"
import { ComputedColumnDetails, ColumnEditor } from "./eval-computed-columns"
import { DemoWorkflowAction } from "./app-shell"
import { tracerApi } from "./api"
import { useCollectionFilter } from "./use-collection-filter"
import { useCollectionPages } from "./use-collection-pages"
import { ErrorState, EmptyState } from "./primitives"
import { TraceInspectorOverlay } from "./trace-list-overlay"
import { TraceListHistogram } from "./trace-list-histogram"
import { TraceListTable } from "./trace-list-table"
import { CollectionPanel } from "./collection-panel"
import { TraceListToolbar } from "./trace-list-toolbar"
import { TraceSelectionActions } from "./trace-selection-actions"
import type { TraceSummary } from "@/src/lib/tracer/contracts"
import { TraceOnboarding } from "./trace-onboarding"
import { preserveFixedFilters } from "@/components/ui/datool/search-bar/filter-draft"
import {
  DEFAULT_TRACE_LIST_COLUMNS,
  TRACE_FIXED_FILTERS,
  downloadTraceExport,
  tracesToCsv,
} from "./trace-list-utils"

function traceUrl(
  pathname: string,
  search: ReadonlyURLSearchParams,
  traceId: string | null,
  spanId: string | null
) {
  const params = new URLSearchParams(search.toString())

  if (traceId) {
    params.set("trace", traceId)
  } else {
    params.delete("trace")
    params.delete("inspector")
  }

  if (traceId && spanId) {
    params.set("span", spanId)
  } else {
    params.delete("span")
  }

  const query = params.toString()
  return query ? `${pathname}?${query}` : pathname
}

export function TraceListWorkspace() {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const search = useCollectionFilter("traces", "", {
    normalize: (value) => preserveFixedFilters(value, "", TRACE_FIXED_FILTERS),
  })
  const {
    canLoadMore,
    data,
    error,
    isLoading,
    isLoadingMore,
    isFetching,
    isRefreshing,
    loadMore,
    loadMoreError,
    refresh,
    total,
    items: traces,
  } = useCollectionPages(tracerApi.traces.list, search.filter)
  const storageScope = useWorkspaceStorageScope()
  const tableView = useTableView({
    settingsStorageKey: `datool:traces-table-settings:${storageScope}`,
    orderStorageKey: "datool:traces-column-order",
  })
  const openedFromTable = React.useRef(false)
  const openedRow = React.useRef<HTMLElement | null>(null)
  const selectedTraceId = searchParams.get("trace")
  const selectedSpanId = searchParams.get("span")
  const [now, setNow] = React.useState(() => Date.now())
  const visibleTraces = traces
  const selectionScope = `${pathname}:${search.filter}`
  const [selection, setSelection] = React.useState<{ scope: string; traces: Map<string, TraceSummary> }>(() => ({ scope: selectionScope, traces: new Map() }))
  const checkedTraces = selection.scope === selectionScope ? [...selection.traces.values()] : []
  const checkedIds = new Set(checkedTraces.map(trace => trace.id))
  function changeSelection(ids: Set<string>) {
    const available = new Map([...checkedTraces, ...visibleTraces].map(trace => [trace.id, trace]))
    setSelection({ scope: selectionScope, traces: new Map([...ids].flatMap(id => {
      const trace = available.get(id)
      return trace ? [[id, trace] as const] : []
    })) })
  }
  const workspaceRef = React.useRef<HTMLDivElement>(null)
  function clearSelection() {
    changeSelection(new Set())
    requestAnimationFrame(() => workspaceRef.current?.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')?.focus())
  }
  const columnRows = React.useMemo(() => traces.map(trace => ({ id: trace.id, trace, expectedOutput: null, datasetItemId: null, results: [] })), [traces])
  const computed = useComputedColumns("traces", columnRows)
  const selectedTraceIndex = visibleTraces.findIndex(
    (trace) => trace.id === selectedTraceId
  )

  React.useEffect(() => {
    if (!selectedTraceId) openedFromTable.current = false
  }, [selectedTraceId])

  React.useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 3_000)
    return () => window.clearInterval(interval)
  }, [])

  const openTrace = React.useCallback(
    (traceId: string, trigger: HTMLElement) => {
      openedRow.current = trigger
      trigger.focus()
      const href = traceUrl(pathname, searchParams, traceId, null)
      // Selection is client-only. Native history keeps Next's search params in
      // sync without waiting for a server navigation before opening the panel.
      // Keep one history entry for the inspector so closing skips every
      // trace selected while it was open, including repeated row clicks.
      if (selectedTraceId) {
        window.history.replaceState(null, "", href)
      } else {
        openedFromTable.current = true
        window.history.pushState(null, "", href)
      }
    },
    [pathname, searchParams, selectedTraceId]
  )

  const replaceTrace = React.useCallback(
    (traceId: string, spanId: string | null = null) => {
      window.history.replaceState(null, "", traceUrl(pathname, searchParams, traceId, spanId))
    },
    [pathname, searchParams]
  )

  const closeTrace = React.useCallback(() => {
    // Back from the extra maximize entry would only restore the split view.
    const returnToList = openedFromTable.current && searchParams.get("inspector") !== "full"
    openedFromTable.current = false
    if (returnToList) {
      router.back()
      return
    }

    window.history.replaceState(null, "", traceUrl(pathname, searchParams, null, null))
  }, [pathname, router, searchParams])

  const downloadJson = React.useCallback(() => {
    downloadTraceExport({
      content: JSON.stringify(visibleTraces, null, 2),
      filename: "datool-visible-traces.json",
      type: "application/json",
    })
  }, [visibleTraces])

  const downloadCsv = React.useCallback(() => {
    downloadTraceExport({
      content: tracesToCsv(visibleTraces),
      filename: "datool-visible-traces.csv",
      type: "text/csv;charset=utf-8",
    })
  }, [visibleTraces])

  return (
    <div ref={workspaceRef} className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground">
      <CollectionPanel label="Traces" selectionControls={checkedTraces.length ? <TraceSelectionActions traces={checkedTraces} onClear={clearSelection} onChanged={refresh} onDeleted={ids => {
        clearSelection()
        if (selectedTraceId && ids.includes(selectedTraceId)) closeTrace()
        refresh()
      }} /> : undefined}>
        <TraceListToolbar
          isRefreshing={isRefreshing}
          onDownloadCsv={downloadCsv}
          onDownloadJson={downloadJson}
          onQueryChange={value => { changeSelection(new Set()); search.onChange(value) }}
          onRefresh={refresh}
          query={search.value}
          filterError={search.error}
        />
        {tableView.storageError ? <Notice variant="error" role="status">{tableView.storageError}</Notice> : null}
        {error && !data ? (
          <ErrorState error={error} onRetry={refresh} />
        ) : null}
        {error && data ? (
          <div className="flex items-center justify-between gap-3 border-b border-warning-border bg-warning-background px-3 py-2 text-xs text-warning-foreground">
            <span>
              Latest refresh failed. Showing the last loaded trace rows.
            </span>
            <button
              className="shrink-0 underline underline-offset-2 hover:text-foreground"
              onClick={refresh}
              type="button"
            >
              Retry
            </button>
          </div>
        ) : null}
        {isLoading && !data ? (
          <>
            <HeaderSlot name="display"><CollectionDisplaySkeleton /></HeaderSlot>
            <CollectionHistogramSkeleton />
            <CollectionTableSkeleton label="Loading trace logs" />
          </>
        ) : null}
        {!isLoading && !error && traces.length === 0 ? (
          <TraceOnboarding
            key={pathname}
            fallback={
              <EmptyState
                action={search.filter ? undefined : <DemoWorkflowAction />}
                detail={
                  search.filter
                    ? "Try changing or clearing the filter."
                    : "Capture a local trace or load the sample workflow to inspect the persisted log and span graph."
                }
                icon={Workflow}
                title={search.filter ? "No matching traces" : "No traces captured yet"}
              />
            }
          />
        ) : null}
        {traces.length > 0 ? (
          <>
            <TraceListHistogram
              timeRange="all"
              now={now}
              traces={visibleTraces}
            />
            <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-0.5 bg-background px-3 py-1 text-[10px] text-foreground-subtle">
              <span>
                {traces.length}
                {total !== null && total > traces.length ? ` of ${total}` : ""}{" "}
                {(total ?? traces.length) === 1 ? "trace" : "traces"}
              </span>
            </div>
            <div className="min-h-0 flex-1">
              <TraceListTable
                pagination={{ canLoadMore, isLoadingMore, isFetching, loadMore, loadMoreError }}
                checkedIds={checkedIds}
                onCheckedIdsChange={changeSelection}
                settings={tableView.settings}
                onSettingsChange={tableView.onSettingsChange}
                columnOrderStore={tableView.columnOrderStore}
                enableCardView
                columnTools={{ ...computed, rows: columnRows, orderStorageKey: "datool:traces-column-order" }}
                fillHeight
                columns={DEFAULT_TRACE_LIST_COLUMNS}
                onOpenTrace={openTrace}
                selectedTraceId={selectedTraceId}
                traces={visibleTraces}
              />
            </div>

          </>
        ) : null}
      </CollectionPanel>
      {selectedTraceId ? (
        <TraceInspectorOverlay
          customColumnDetails={<ComputedColumnDetails onRemove={id => { void computed.update(computed.columns.filter(column => column.id !== id)) }} columns={computed.columns} cells={computed.cells} rowId={selectedTraceId} action={<ColumnEditor addedFields={computed.columns} borderless addLabel="Add custom field" rows={columnRows} onSave={column => computed.update([...computed.columns, column])} />} />}
          initialSpanId={selectedSpanId ?? undefined}
          nextTraceId={
            selectedTraceIndex >= 0
              ? visibleTraces[selectedTraceIndex + 1]?.id
              : undefined
          }
          onClose={closeTrace}
          onNavigate={(traceId) => replaceTrace(traceId)}
          onSpanChange={(spanId) => replaceTrace(selectedTraceId, spanId)}
          previousTraceId={
            selectedTraceIndex > 0
              ? visibleTraces[selectedTraceIndex - 1]?.id
              : undefined
          }
          returnFocusRef={openedRow}
          traceId={selectedTraceId}
        />
      ) : null}
    </div>
  )
}
