"use client"
import { EvalGroupLinks } from "./eval-group-links"

import { evalStageLabel } from "@/src/lib/tracer/eval-run-stage"
import { EvalRunActions } from "./eval-run-actions"
import { EvalRunSummary } from "./eval-run-summary"
import { ExecutionStatus } from "@/components/ui/execution-status"
import * as React from "react"
import Link from "next/link"
import { useSearchParams, useRouter } from "next/navigation"
import { EvalComparePicker } from "./eval-compare-picker"
import { EvalComparisonSummary } from "./eval-comparison-summary"
import { EvalMetricDifference } from "./eval-metric-difference"
import { ComparisonDot, comparisonRowClass } from "@/components/ui/comparison-series"
import {
  pairEvalRows,
  evalConfigurationChanges,
  parseCompareIds,
  evalComparisonUrl,
  averageEvalScore,
  comparableScore,
  type EvalComparisonRow,
  type EvalPair,
} from "@/src/lib/tracer/eval-comparison"
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  PanelLeft,
  GitCompareArrows,
  X,
} from "lucide-react"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { JsonCode } from "./json-code"
import { tracerApi } from "./api"
import { useCollectionPages } from "./use-collection-pages"
import type { CollectionListOptions } from "./api"
import type { ApiList } from "@/src/lib/tracer/contracts"
import { ErrorState, LoadingState } from "./primitives"
import {
  CollectionHeaderControls,
  HeaderSlot,
  headerButtonClass,
} from "./collection-header"
import {
  LogTableBody,
  LogTable,
  LogRow,
  LogRowSelection,
  LogSelectAll,
} from "./log-table"
import { logTable } from "./log-table-styles"
import { EvalScoreCell } from "./eval-score-cell"
import { PercentageCell } from "./percentage-cell"
import { getTraceIconKind } from "./trace-icon-kind"
import { SpanKindIcon } from "./span-kind-icon"
import { TraceInspectorOverlay } from "./trace-list-overlay"
import { useWorkspaceHref, useWorkspaceStorageScope } from "./workspace-path"
import { formatDuration, previewValue } from "./format"
import type {
  JsonValue,
  EvalRunDetail,
  TraceDetail,
} from "@/src/lib/tracer/contracts"
import {
  ColumnEditor,
  ComputedValue,
  ComputedColumnDetails,
} from "./eval-computed-columns"
import { useComputedColumns } from "./use-computed-columns"
import { getEvalTableColumns } from "@/src/lib/tracer/eval-table-columns"
import { useTableView } from "./use-table-view"
import { Notice } from "@/components/ui/notice"
import { TableViewControls } from "./table-view-controls"
import { CollectionPanel } from "./collection-panel"
import { CollectionSelectionActions } from "./collection-selection-actions"

function Payload({ value }: { value: JsonValue | undefined }) {
  if (value == null)
    return (
      <span data-empty="true" className="text-empty-foreground">
        —
      </span>
    )
  return (
    <div
      className="text-sm break-words whitespace-pre-wrap"
      title={previewValue(value, 4000)}
    >
      {typeof value === "string" ? (
        value
      ) : (
        <JsonCode text={JSON.stringify(value, null, 2)} />
      )}
    </div>
  )
}

export function EvalDetailPage({ runId }: { runId: string }) {
  return (
    <CollectionPanel label="Eval traces" contentClassName="p-0">
      <EvalDetail key={runId} runId={runId} />
    </CollectionPanel>
  )
}

function EvalDetail({ runId }: { runId: string }) {
  const workspaceHref = useWorkspaceHref()
  const storageScope = useWorkspaceStorageScope()
  const state = useCollectionPages<EvalComparisonRow, ApiList<EvalComparisonRow> & { run: EvalRunDetail }>(
    React.useCallback(async (options: CollectionListOptions) => {
      const run = await tracerApi.evals.get(runId, options)
      return { run, items: run.rows ?? [], nextCursor: run.nextCursor ?? null }
    }, [runId]),
    runId,
    3000,
    { refreshLoadedPages: true, shouldPoll: page => !page || page.run.status === "running" }
  )
  const search = useSearchParams()
  const router = useRouter()
  const compareKey = `${parseCompareIds(search.get("compare")).filter(
    (id) => id !== runId
  ).join(",")}`
  const compareIds = parseCompareIds(compareKey)
  const comparing = search.has("compare")
  const setComparison = (ids: string[] | null) => {
    const query = new URLSearchParams(search.toString())
    query.delete("compare")
    if (ids === null)
      router.push(
        workspaceHref(
          `/evals/${encodeURIComponent(runId)}${query.size ? `?${query}` : ""}`
        )
      )
    else
      router.push(
        workspaceHref(
          evalComparisonUrl(
            [runId, ...ids],
            query.toString()
          )
        )
      )
  }
  const other = useCollectionPages<
    EvalPair & { comparisonRun?: EvalRunDetail },
    ApiList<EvalPair & { comparisonRun?: EvalRunDetail }> & { runs: EvalRunDetail[]; running: boolean }
  >(
    React.useCallback(async (options: CollectionListOptions) => {
      const ids = parseCompareIds(compareKey)
      if (ids.length > 3) throw new Error("Compare at most four runs at a time.")
      const pages = await Promise.all(ids.map(id => tracerApi.evals.compare(runId, id, Number(options.cursor ?? 0), options.signal)))
      const offsets = pages.flatMap(page => page.nextOffset === null ? [] : [page.nextOffset])
      return {
        items: pages.flatMap(page => page.pairs.map(pair => ({ ...pair, id: `${page.right.id}:${pair.id}`, comparisonRun: page.right }))),
        runs: pages.map(page => page.right),
        running: pages.some(page => page.left.status === "running" || page.right.status === "running"),
        nextCursor: offsets.length ? String(Math.min(...offsets)) : null,
      }
    }, [compareKey, runId]),
    compareKey,
    3000,
    { refreshLoadedPages: true, shouldPoll: page => !!compareKey && (!page || page.running) }
  )
  const comparisonRuns = other.data?.runs ?? []
  const pairs = React.useMemo<(EvalPair & { comparisonRun?: EvalRunDetail })[]>(
    () => compareKey ? other.items : pairEvalRows(state.items, []),
    [compareKey, other.items, state.items]
  )
  const allRows = React.useMemo(
    () => [
      ...new Map(
        pairs
          .flatMap((pair) =>
            [pair.left, pair.right].filter(
              (row): row is EvalComparisonRow => !!row
            )
          )
          .map((row) => [row.id, row])
      ).values(),
    ],
    [pairs]
  )
  const [checked, setChecked] = React.useState<Set<string>>(() => new Set())
  const [openTrace, setOpenTrace] = React.useState<string | null>(null)
  const [openRunId, setOpenRunId] = React.useState(runId)
  const loadSnapshot = React.useCallback(async (signal: AbortSignal) => {
    const target = await tracerApi.evals.target(openRunId, openTrace!, signal)
    return target.scoringTrace as TraceDetail | undefined
  }, [openRunId, openTrace])
  const [detailsOpen, setDetailsOpen] = React.useState(true)
  const panelOpen = comparing || detailsOpen
  const [narrow, setNarrow] = React.useState(false)
  const [mobilePanelOpen, setMobilePanelOpen] = React.useState(false)
  const mobilePanelTrigger = React.useRef<HTMLButtonElement | null>(null)
  const layoutContainer = React.useRef<HTMLDivElement | null>(null)
  const observeContainer = React.useCallback((element: HTMLDivElement | null) => {
    layoutContainer.current = element
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const isNarrow = entry.contentRect.width < 768
      setNarrow(isNarrow)
      if (!isNarrow) setMobilePanelOpen(false)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [setMobilePanelOpen])
  const detailsId = React.useId()
  const returnFocusRef = React.useRef<HTMLElement | null>(null)
  const computed = useComputedColumns(
    runId,
    allRows,
    `datool:eval-columns:${storageScope}:${runId}`
  )
  const selectView = (id: string | null) => {
    const query = new URLSearchParams(window.location.search)
    if (id) query.set("view", id)
    else query.delete("view")
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query.size ? `?${query}` : ""}`
    )
  }
  const tableView = useTableView({
    resource: "eval-runs",
    settingsStorageKey: `datool:eval-table:${storageScope}:${runId}`,
    orderStorageKey: `datool:eval-column-order:${storageScope}:${runId}`,
    computed,
    selectedView: { id: search.get("view"), onSelect: selectView },
    details: { open: detailsOpen, onOpenChange: setDetailsOpen },
  })
  const scorerKey = JSON.stringify([
    ...new Map(
      [state.data?.run, ...comparisonRuns].flatMap(run => [
        ...(run?.scorerProgress ?? []).map(scorer => [scorer.evaluatorId, scorer.name] as const),
        ...(run?.results ?? []).map(result => [result.evaluatorId, result.evaluatorName] as const),
      ])
    ).entries(),
  ])
  if (state.isLoading) return <LoadingState label="Loading eval traces" />
  if (!state.data)
    return state.error ? (
      <ErrorState error={state.error} onRetry={state.refresh} />
    ) : null
  const run = state.data.run
  const rows = state.items
  const scorers = JSON.parse(scorerKey) as [string, string][]
  const tableColumns = getEvalTableColumns(scorers, computed.columns)
  const selectedRows = allRows.filter((row) => checked.has(row.id))
  const count = selectedRows.length
  const all = allRows.length > 0 && count === allRows.length
  const renderRow = (
    row: EvalComparisonRow | undefined,
    index: number,
    compared = false,
    comparisonRun = comparisonRuns[0],
    baselineRow?: EvalComparisonRow
  ) => {
    const seriesIndex = compared && comparisonRun ? compareIds.findIndex(id => id === comparisonRun.id) + 1 : 0
    const rowRun = compared && comparisonRun ? comparisonRun : run
    const rowLabel = comparisonRun
      ? <span className="flex min-w-0 items-center gap-2" title={rowRun.name ?? rowRun.id}><ComparisonDot index={seriesIndex} /><span className="truncate">{seriesIndex === 0 ? "Baseline" : `Run ${seriesIndex + 1}`} · {rowRun.name ?? rowRun.id}</span></span>
      : undefined
    if (!row)
      return (
        <LogRow
          rowLabel={rowLabel}
          className={
            `cursor-default ${comparisonRun ? comparisonRowClass(seriesIndex) : ""}`
          }
        >
          <td />
          {tableColumns.map((column) => (
            <td
              key={column.id}
              className={`${logTable.cell} !py-4 !align-top text-muted-foreground`}
            >
              {column.id === "name" ? "No matching target in this run" : "—"}
            </td>
          ))}
          <td />
        </LogRow>
      )

    const score = averageEvalScore(row)
    const open = (element: HTMLElement) => {
      returnFocusRef.current = element
      setOpenRunId(compared && comparisonRun ? comparisonRun.id : runId)
      setOpenTrace(row.id)
    }
    return (
      <LogRow
        key={row.id}
        rowLabel={rowLabel}
        data-comparison={compared ? "true" : undefined}
        className={
          comparisonRun ? comparisonRowClass(seriesIndex) : undefined
        }
        aria-label={`${compared ? "Compared" : "Current"} run target ${index + 1}`}
        checked={checked.has(row.id)}
        tabIndex={0}
        onClick={(event) => open(event.currentTarget)}
        onKeyDown={(event) => {
          if (
            event.target !== event.currentTarget ||
            !["Enter", " "].includes(event.key)
          )
            return
          event.preventDefault()
          open(event.currentTarget)
        }}
      >
        <LogRowSelection
          align="top"
          index={index}
          checked={checked.has(row.id)}
          label={`Select ${row.trace.name}`}
          onChange={() =>
            setChecked((current) => {
              const next = new Set(current)
              if (next.has(row.id)) next.delete(row.id)
              else next.add(row.id)
              return next
            })
          }
        />
        <td className={`${logTable.cell} !py-4 !align-top`}>
          <span className="flex items-center gap-2">
            {comparisonRun ? <span title={rowRun.name ?? rowRun.id}><ComparisonDot index={seriesIndex} /></span> : <SpanKindIcon kind={getTraceIconKind(row.trace)} />}
            {comparisonRun && <span className="shrink-0 text-xs text-foreground-muted">{seriesIndex === 0 ? "Baseline" : `Run ${seriesIndex + 1}`}</span>}
            <span className="truncate">{row.trace.name}</span>
          </span>
          {row.stage && row.stage !== "completed" && <p className="mt-1 text-xs text-foreground-muted">{evalStageLabel(row.stage)}</p>}
          {row.executionError && <p className="mt-1 text-xs text-destructive">{row.executionError}</p>}
        </td>
        {[row.trace.input, row.trace.output, row.expectedOutput].map(
          (value, i) => (
            <td key={i} className={`${logTable.cell} !py-4 !align-top`}>
              <Payload value={value} />
            </td>
          )
        )}
        <td className={`${logTable.cell} !py-4 !align-top`}>
          <div className="flex items-center gap-3">
            <PercentageCell value={score} />
            {compared && <EvalMetricDifference value={score} baseline={averageEvalScore(baselineRow)} />}
          </div>
        </td>
        {scorers.map(([id]) => {
          const result = row.results.find((result) => result.evaluatorId === id)
          return (
            <td key={id} className={`${logTable.cell} !py-4 !align-top`}>
              <div className="flex items-center gap-3">
              {result ? (
                <EvalScoreCell result={result} />
              ) : row.scorerStatuses?.[id] ? (
                <ExecutionStatus status={row.scorerStatuses[id]} />
              ) : (
                <PercentageCell value={null} />
              )}
              {compared && <EvalMetricDifference value={comparableScore(result)} baseline={comparableScore(baselineRow?.results.find(result => result.evaluatorId === id))} />}
              </div>
            </td>
          )
        })}
        <td className={`${logTable.cell} !py-4 !align-top`}>
          <div className="flex items-center gap-3">
            <span className="tabular-nums">{formatDuration(row.trace.durationMs)}</span>
            {compared && <EvalMetricDifference value={row.trace.durationMs} baseline={baselineRow?.trace.durationMs} format="duration" />}
          </div>
        </td>
        <td className={`${logTable.cell} !py-4 !align-top`}>
          <Payload
            value={
              row.results
                .map((result) => result.error)
                .filter(Boolean)
                .join("\n") || null
            }
          />
        </td>
        {computed.columns.map((column) => (
          <td key={column.id} className={`${logTable.cell} !py-4 !align-top`}>
            <ComputedValue
              format={column.format}
              cell={computed.cells[column.id]?.[row.id]}
            />
          </td>
        ))}
        <td
          className={`${logTable.cell} cursor-default`}
          onClick={(event) => event.stopPropagation()}
        />
      </LogRow>
    )
  }
  const detailsContent = (
    <aside
      id={narrow ? undefined : detailsId}
      aria-label={comparing ? "Comparisons" : "Eval details"}
      className="h-full min-h-0 flex-1 space-y-5 overflow-y-auto p-4 [overflow-wrap:anywhere]"
    >
      {comparing ? <>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Comparisons</h2>
          <Button variant="ghost-muted" size="icon-sm" aria-label="Stop comparing" onClick={() => { setComparison(null); setMobilePanelOpen(false) }}><X className="size-4" /></Button>
        </div>
        <EvalComparePicker baseline={run} selectedRuns={comparisonRuns} selectedIds={compareIds} onChange={setComparison} />
        {compareIds.length > comparisonRuns.length && !other.error ? <p role="status" className="text-xs text-foreground-muted">Loading comparison…</p> : null}
        {compareKey && other.error ? <ErrorState error={other.error} onRetry={other.refresh} /> : null}
        {comparisonRuns.length ? <EvalComparisonSummary baseline={run} runs={comparisonRuns} /> : !compareIds.length ? <p className="text-xs leading-5 text-foreground-muted">Select another run to see score and duration changes against this baseline.</p> : null}
      </> : <EvalRunSummary run={run} />}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-5 [&>div]:min-w-0">
        <div>
          <h2 className="mb-2 text-xs text-foreground-muted">Operations</h2>
          <div className="text-sm"><EvalGroupLinks run={run} /></div>
        </div>
        {run.datasetId && (
          <div>
            <h2 className="mb-2 text-xs text-foreground-muted">
              Dataset
            </h2>
            <Link
              className="text-sm break-all hover:underline"
              href={workspaceHref(
                `/datasets/${encodeURIComponent(run.datasetId)}`
              )}
            >
              Open dataset
            </Link>
          </div>
        )}
        <details className="text-xs text-foreground-muted">
          <summary className="cursor-pointer">
            Metadata
          </summary>
          <p className="mt-3 break-all">{run.id}</p>
          <pre className="mt-3 font-mono text-xs break-words whitespace-pre-wrap">
            {<JsonCode text={JSON.stringify(run.metadata, null, 2)} />}
          </pre>
        </details>
      </div>
    </aside>
  )
  return (
    <div ref={observeContainer} className="h-full min-h-0 overflow-hidden bg-surface-canvas text-foreground">
      <HeaderSlot name="selection">
        <CollectionSelectionActions
          rows={selectedRows}
          onClear={() => setChecked(new Set())}
          exportName="eval-traces"
        />
      </HeaderSlot>
      <CollectionHeaderControls
        onRefresh={() => {
          state.refresh()
          other.refresh()
        }}
        exportRows={allRows}
        exportName="eval-traces"
        actions={<EvalRunActions run={run} onChanged={state.refresh} />}
      />
      <HeaderSlot name="display">
        <Button
          variant="outline"
          className={headerButtonClass}
          aria-pressed={comparing}
          aria-haspopup={narrow ? "dialog" : undefined}
          onClick={(event) => {
            if (narrow) {
              mobilePanelTrigger.current = event.currentTarget
              setMobilePanelOpen(true)
              if (!comparing) setComparison([])
            } else setComparison(comparing ? null : [])
          }}
        >
          <GitCompareArrows className="size-3.5" />
          Compare
        </Button>
      </HeaderSlot>
      <ResizablePanelGroup orientation="horizontal">
        {!narrow && panelOpen && (
          <ResizablePanel
            id="eval-details"
            defaultSize={comparing ? "300px" : "240px"}
            minSize={comparing ? "240px" : "160px"}
            maxSize={comparing ? "360px" : "50%"}
            onResize={({ inPixels }, _id, previous) => {
              if ((layoutContainer.current?.getBoundingClientRect().width ?? 0) >= 768 && !comparing && previous && previous.inPixels >= 180 && inPixels > 0 && inPixels < 180)
                setDetailsOpen(false)
            }}
          >
            {detailsContent}
          </ResizablePanel>
        )}
        {!narrow && panelOpen && (
          <ResizableHandle withHandle aria-label={comparing ? "Resize comparisons" : "Resize workflow details"} />
        )}
        <ResizablePanel id="eval-table" minSize="30%">
          <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden px-3 py-1">
            <TableViewControls savedView={tableView.savedView}>
              {tableView.storageError ? <Notice variant="error" role="status">{tableView.storageError}</Notice> : null}
              {comparisonRuns.map(otherRun => {
                const changes = evalConfigurationChanges(otherRun, run)
                const judges = changes.filter(change => change.kind === "judge")
                return <Notice key={otherRun.id} variant={judges.length ? "warning" : "default"} className="mb-2">
                  {otherRun.name ?? otherRun.id}: {changes.filter(change => change.kind === "extractor").length} application/prompt changes · {judges.length ? `${judges.length} judge changes — score differences mix application and judge changes.` : "Judge versions unchanged."}
                  {changes.length > 0 && <details><summary className="cursor-pointer">Inspect compared → current settings</summary><pre className="overflow-auto text-xs">{JSON.stringify(changes, null, 2)}</pre></details>}
                </Notice>
              })}
              {other.items.some(pair => pair.inputChanged || pair.referenceChanged) && <Notice variant="warning" className="mb-2">Some loaded pairs have changed inputs or expected references. Inspect those cases before attributing score changes to the application.</Notice>}
              {state.error ? (
                <ErrorState error={state.error} onRetry={state.refresh} />
              ) : null}
              {computed.storageError ? (
                <p role="status" className="mb-2 text-xs text-destructive">
                  {computed.storageError}
                </p>
              ) : null}
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <LogTable
                  pagination={compareKey ? other : state}
                  fillHeight
                  computedColumnStore={computed.store}
                  selectionToolbarClassName="px-0"
                  selectionActions={
                    comparing ? undefined : <Button
                      variant="outline"
                      className={headerButtonClass}
                      aria-expanded={narrow ? mobilePanelOpen : detailsOpen}
                      aria-haspopup={narrow ? "dialog" : undefined}
                      aria-controls={detailsId}
                      onClick={(event) => {
                        if (narrow) {
                          mobilePanelTrigger.current = event.currentTarget
                          setMobilePanelOpen(true)
                        } else setDetailsOpen((open) => !open)
                      }}
                    >
                      {narrow ? <PanelLeft className="size-3.5" /> : detailsOpen ? (
                        <ArrowLeftToLine className="size-3.5" />
                      ) : (
                        <ArrowRightToLine className="size-3.5" />
                      )}
                      {!narrow && <span
                        aria-hidden="true"
                        className={`size-2 shrink-0 rounded-full ${detailsOpen ? "bg-selection-control" : "bg-muted-foreground"}`}
                      />}
                      Details
                    </Button>
                  }
                  settings={tableView.settings}
                  onSettingsChange={tableView.onSettingsChange}
                  enableCardView
                  reorderable
                  columnOrderStore={tableView.columnOrderStore}
                  actionColumnIds={["add-column"]}
                  columnIds={[
                    ...tableColumns.map((column) => column.id),
                    "add-column",
                  ]}
                  widths={[...tableColumns.map((column) => comparing && (column.id === "all-scores" || column.id.startsWith("score:") || column.id === "duration") ? Math.max(column.width, 210) : column.width), 160]}
                >
                  <thead className={logTable.head}>
                    <tr>
                      <th className="px-3" scope="col">
                        <LogSelectAll
                          checked={all}
                          partial={count > 0 && !all}
                          disabled={!allRows.length}
                          label="Select all eval traces"
                          onChange={() =>
                            setChecked(
                              all
                                ? new Set()
                                : new Set(allRows.map((row) => row.id))
                            )
                          }
                        />
                      </th>
                      {[
                        "Name",
                        "Input",
                        "Output",
                        "Expected",
                        "All Scores",
                        ...scorers.map(([, name]) => name),
                        "Duration",
                        "Errors",
                      ].map((name, index) => (
                        <th
                          key={index}
                          scope="col"
                          className={logTable.heading}
                        >
                          {name}
                          {index === 0 ? (
                            <span className="block text-xs">
                              {rows.length} targets
                            </span>
                          ) : null}
                        </th>
                      ))}
                      {computed.columns.map((column) => (
                        <th
                          key={column.id}
                          scope="col"
                          className={logTable.heading}
                          aria-label={column.name}
                        >
                          <ColumnEditor
                            addedFields={computed.columns}
                            column={column}
                            rows={allRows}
                            onSave={(next) =>
                              computed.update(
                                computed.columns.map((current) =>
                                  current.id === next.id ? next : current
                                )
                              )
                            }
                            onDelete={() =>
                              computed.update(
                                computed.columns.filter(
                                  (current) => current.id !== column.id
                                )
                              )
                            }
                          />
                        </th>
                      ))}
                      <th scope="col" className={logTable.heading}>
                        <ColumnEditor
                          addedFields={computed.columns}
                          rows={allRows}
                          onSave={(column) =>
                            computed.update([...computed.columns, column])
                          }
                        />
                      </th>
                    </tr>
                  </thead>
                  <LogTableBody
                    rows={pairs}
                    estimatedRowHeight={300}
                    empty={
                      <tr>
                        <td
                          colSpan={9 + scorers.length + computed.columns.length}
                          className="py-10 text-center text-muted-foreground"
                        >
                          {compareKey && !other.data ? other.error ? "Comparison results unavailable." : "Loading comparison results…" : "No trace targets in this run."}
                        </td>
                      </tr>
                    }
                    renderComparison={
                      comparisonRuns.length
                        ? (pair, index) =>
                            renderRow(
                              pair.right,
                              index,
                              true,
                              pair.comparisonRun,
                              pair.left
                            )
                        : undefined
                    }
                  >
                    {(pair, index) =>
                      renderRow(pair.left, index, false, pair.comparisonRun)
                    }
                  </LogTableBody>
                </LogTable>
              </div>
            </TableViewControls>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      {narrow && (
        <Dialog open={mobilePanelOpen} onOpenChange={setMobilePanelOpen}>
          <DialogContent
            id={detailsId}
            variant="sheet"
            aria-describedby={undefined}
            className="gap-0 bg-background p-0 pb-[env(safe-area-inset-bottom)]"
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              document.getElementById(detailsId)?.querySelector<HTMLElement>('[data-slot="dialog-close"]')?.focus()
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              mobilePanelTrigger.current?.focus()
            }}
          >
            <DialogTitle className="shrink-0 border-b border-border p-4 pr-12 text-sm">
              {comparing ? "Eval comparison" : "Run details"}
            </DialogTitle>
            {detailsContent}
          </DialogContent>
        </Dialog>
      )}
      {openTrace ? (
        <TraceInspectorOverlay
          loadSnapshot={loadSnapshot}
          customColumnDetails={
            <ComputedColumnDetails
              onRemove={(id) => {
                void computed.update(
                  computed.columns.filter((column) => column.id !== id)
                )
              }}
              columns={computed.columns}
              cells={computed.cells}
              rowId={
                allRows.find((row) => row.id === openTrace)?.id ?? openTrace
              }
              action={
                <ColumnEditor
                  addedFields={computed.columns}
                  borderless
                  addLabel="Add custom field"
                  rows={allRows}
                  onSave={(column) =>
                    computed.update([...computed.columns, column])
                  }
                  description="Calculate a custom field for each trace. Fields share the table’s custom columns and saved views."
                />
              }
            />
          }
          key={openTrace}
          initialSpanId={allRows.find(row => row.id === openTrace)?.sourceSpanId ?? undefined}
          traceId={
            allRows.find((row) => row.id === openTrace)?.trace.id ?? openTrace
          }
          onClose={() => setOpenTrace(null)}
          returnFocusRef={returnFocusRef}
        />
      ) : null}
    </div>
  )
}
