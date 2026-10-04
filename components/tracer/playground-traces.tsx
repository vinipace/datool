"use client"
import { useEffect, useMemo, useRef, useState } from "react"
import type { Attempt } from "@/src/lib/playground/contracts"
import type { EvalRunDetail, Evaluator } from "@/src/lib/tracer/contracts"
import { ColumnEditor, ComputedColumnDetails } from "./eval-computed-columns"
import { TableViewControls } from "./table-view-controls"
import { useTableView } from "./use-table-view"
import { tracerApi } from "./api"
import { useCollectionPages } from "./use-collection-pages"
import { TraceListTable } from "./trace-list-table"
import { TraceInspectorOverlay } from "./trace-list-overlay"
import { DEFAULT_TRACE_LIST_COLUMNS } from "./trace-list-utils"
import { useComputedColumns } from "./use-computed-columns"
import { CollectionHeaderContext } from "./collection-header-context"

export function PlaygroundTraces({
  connectionId,
  displayTarget,
  attempts = [],
  evaluators = [],
  evaluatorIds = [],
}: {
  attempts?: Attempt[]
  evaluators?: Evaluator[]
  evaluatorIds?: string[]
  displayTarget?: HTMLDivElement | null
  connectionId: string
}) {
  const [scoreRuns, setScoreRuns] = useState<EvalRunDetail[]>([])
  const [scoreError, setScoreError] = useState("")
  const runKey = JSON.stringify(attempts.filter(attempt => attempt.appId === connectionId).flatMap(attempt => attempt.evalRunIds))
  useEffect(() => {
    let active = true
    Promise.all((JSON.parse(runKey) as string[]).map(id => tracerApi.evals.get(id))).then(runs => {
      if (active) { setScoreRuns(runs); setScoreError("") }
    }).catch(error => { if (active) setScoreError(error.message) })
    return () => { active = false }
  }, [runKey])
  const results = useMemo(() => [...scoreRuns].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).flatMap(run => run.results), [scoreRuns])
  const scoreColumns = [...new Map([
    ...evaluatorIds.map(id => [id, evaluators.find(evaluator => evaluator.id === id)?.name ?? id] as const),
    ...results.map(result => [result.evaluatorId, result.evaluatorName] as const),
  ])].map(([id, name]) => ({ id, name }))
  const [selected, setSelected] = useState<string | null>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const filter = `metadata."datool.connection.id" = ${JSON.stringify(connectionId)}`
  const collection = useCollectionPages(tracerApi.traces.list, filter)
  const rows = useMemo(() => collection.items.map(trace => ({ id: trace.id, trace, expectedOutput: null, datasetItemId: null, results: results.filter(result => result.traceId === trace.id) })), [collection.items, results])
  const computed = useComputedColumns(`playground:${connectionId}`, rows)
  const tableView = useTableView({
    resource: "playground-traces",
    settingsStorageKey: `datool:playground-table-settings:${connectionId}`,
    orderStorageKey: `datool:playground-column-order:${connectionId}`,
    computed,
  })
  const latestCallId = collection.items[0]?.attributes["datool.call.id"]
  return (
    <CollectionHeaderContext.Provider value={{ display: displayTarget, filter: displayTarget }}>
    <TableViewControls savedView={tableView.savedView} pageData={{
      rows: collection.items, total: collection.total, isLoading: collection.isLoading,
      isRefreshing: collection.isRefreshing, error: collection.error?.message ?? collection.loadMoreError?.message ?? null,
      hasMore: collection.canLoadMore, isLoadingMore: collection.isLoadingMore,
      refresh: collection.refresh, loadMore: collection.loadMore,
    }}>
    <section
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
      aria-label="App traces"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        {tableView.storageError && <p role="status" className="p-3 text-xs text-destructive">{tableView.storageError}</p>}
        {scoreError && <p role="alert" className="p-3 text-xs text-destructive">Could not load scores: {scoreError}</p>}
        {computed.storageError && <p role="status" className="p-3 text-xs text-destructive">{computed.storageError}</p>}
        {collection.error && (
          <p role="alert" className="p-3 text-sm text-destructive">
            {collection.error.message}
          </p>
        )}
        {collection.isLoading ? (
          <p className="p-3 text-sm text-muted-foreground">Loading traces…</p>
        ) : !collection.items.length ? (
          <p className="p-3 text-sm text-muted-foreground">
            No traces received yet. Calls appear here when the app exports them
            through the Datool tracer.
          </p>
        ) : (
          <div className="min-h-0 flex-1 bg-background px-2 py-1 text-foreground">
            <TraceListTable pagination={collection}
              settings={tableView.settings}
              onSettingsChange={tableView.onSettingsChange}
              columnOrderStore={tableView.columnOrderStore}
              scores={{ columns: scoreColumns, results }}
              columnTools={{ ...computed, rows, orderStorageKey: `datool:playground-column-order:${connectionId}` }}
              enableCardView
              animateRows
              fillHeight
              columns={DEFAULT_TRACE_LIST_COLUMNS}
              traces={collection.items}
              highlightedCallId={typeof latestCallId === "string" ? latestCallId : undefined}
              selectedTraceId={selected}
              onOpenTrace={(id, element) => {
                trigger.current = element
                setSelected(id)
              }}
            />
          </div>
        )}

      </div>
      {selected && (
        <TraceInspectorOverlay
          key={selected}
          traceId={selected}
          customColumnDetails={<ComputedColumnDetails onRemove={id => { void computed.update(computed.columns.filter(column => column.id !== id)) }} columns={computed.columns} cells={computed.cells} rowId={selected} action={<ColumnEditor addedFields={computed.columns} borderless addLabel="Add custom field" rows={rows} onSave={column => computed.update([...computed.columns, column])} description="Calculate a custom field for each trace. Fields share the table’s custom columns and saved views." />} />}
          onClose={() => setSelected(null)}
          returnFocusRef={trigger}
        />
      )}
    </section>
    </TableViewControls>
    </CollectionHeaderContext.Provider>
  )
}
