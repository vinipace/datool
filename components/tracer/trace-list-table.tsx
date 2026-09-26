"use client"

import { logTable } from "./log-table-styles"

import * as React from "react"

import type { TraceSummary } from "@/src/lib/tracer/contracts"
import { cn } from "@/lib/utils"
import { RunningSpinner } from "@/components/ui/execution-status"
import {
  formatCompactDuration,
  formatCount,
  formatTraceDuration,
  getTraceSpanStats,
  getTraceTags,
  statusLabel,
  TRACE_LIST_COLUMNS,
  type TraceListColumnId,
} from "./trace-list-utils"
import { JsonCode } from "./json-code"
import { previewValue } from "./format"
import { LogTableBody, LogRowSelection, LogTable, LogRow } from "./log-table"
import { LogTimestamp } from "./log-timestamp"
import { getTraceIconKind } from "./trace-icon-kind"
import { SpanKindIcon } from "./span-kind-icon"
import type { LogTableSettings } from "@/src/lib/tracer/custom-views"
import type { ColumnOrderStore } from "@/src/lib/tracer/log-column-order"
import type { EvalResult } from "@/src/lib/tracer/contracts"
import { EvalScoreCell } from "./eval-score-cell"
import { ColumnEditor, ComputedValue } from "./eval-computed-columns"
import { usageDisplay } from "./usage-display"

export type TraceTableColumn = {
  id: string
  label: string
  width: number
  after?: TraceListColumnId
  render: (trace: TraceSummary) => React.ReactNode
}

type TraceListTableProps = {
  pagination?: React.ComponentProps<typeof LogTable>["pagination"]
  additionalColumns?: TraceTableColumn[]
  orderStorageKey?: string
  persistenceKey?: string
  emptyMessage?: string
  rowLabel?: (trace: TraceSummary) => string
  isTraceSkipped?: (trace: TraceSummary) => boolean
  checkedIds?: Set<string>
  onCheckedIdsChange?: (ids: Set<string>) => void
  columnTools?: ReturnType<typeof import("./use-computed-columns").useComputedColumns> & { rows: import("@/src/lib/tracer/computed-columns").EvalTableRow[]; orderStorageKey: string }
  scores?: { columns: { id: string; name: string }[]; results: EvalResult[] }
  settings?: LogTableSettings
  onSettingsChange?: React.Dispatch<React.SetStateAction<LogTableSettings>>
  columnOrderStore?: ColumnOrderStore
  enableCardView?: boolean
  animateRows?: boolean
  highlightedCallId?: string
  fillHeight?: boolean
  columns: TraceListColumnId[]
  onOpenTrace: (traceId: string, trigger: HTMLElement) => void
  selectedTraceId: string | null
  traces: TraceSummary[]
}

function TraceTags({ trace }: { trace: TraceSummary }) {
  const tags = getTraceTags(trace.attributes)

  if (tags.length === 0) {
    return <span className="text-empty-foreground">—</span>
  }

  const visible = tags.slice(0, 2)
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      {visible.map((tag) => (
        <span
          className="max-w-28 truncate rounded bg-surface-emphasis px-1.5 py-px text-xs leading-4 text-foreground-secondary"
          key={`${tag.key}:${tag.value}`}
          title={`${tag.key}: ${tag.value}`}
        >
          {tag.key}: {tag.value}
        </span>
      ))}
      {tags.length > visible.length ? (
        <span
          className="shrink-0 text-xs text-foreground-muted"
          title={tags
            .slice(visible.length)
            .map((tag) => `${tag.key}: ${tag.value}`)
            .join(", ")}
        >
          +{tags.length - visible.length}
        </span>
      ) : null}
    </span>
  )
}

function TraceCell({
  column,
  trace,
  skipped = false,
}: {
  column: TraceListColumnId
  trace: TraceSummary
  skipped?: boolean
}) {
  const stats = getTraceSpanStats(trace)

  switch (column) {
    case "models":
    case "inputTokens":
    case "outputTokens":
    case "cost": {
      const entries = usageDisplay(trace.attributes)
      const labels = column === "models"
        ? ["Model", "Models"]
        : column === "inputTokens"
          ? ["Input tokens"]
          : column === "outputTokens"
            ? ["Output tokens"]
            : ["Estimated cost", "Reported cost"]
      const value = entries.find(([label]) => labels.includes(label))?.[1] ?? "—"
      return <span className="block truncate text-foreground-secondary tabular-nums" title={value}>{value}</span>
    }
    case "created":
      return <LogTimestamp value={trace.startedAt} />
    case "name":
      return (
        <span className="flex min-w-0 items-center gap-2">
          <SpanKindIcon kind={getTraceIconKind(trace)} className={skipped ? "grayscale" : undefined} />
          {trace.status === "running" && <RunningSpinner />}
          <span
            className={cn("min-w-0 truncate font-medium", skipped ? "text-foreground-muted line-through" : "text-foreground")}
            title={trace.operation}
          >
            {trace.name || trace.operation}
          </span>
        </span>
      )
    case "input":
      return <JsonCell value={trace.input} />
    case "output":
      return <JsonCell value={trace.output} />
    case "tags":
      return <TraceTags trace={trace} />
    case "duration":
      return (
        <span className="whitespace-nowrap text-foreground-secondary tabular-nums">
          {formatTraceDuration(trace)}
        </span>
      )
    case "llmDuration":
      return (
        <span className="whitespace-nowrap text-foreground-secondary tabular-nums">
          {formatCompactDuration(stats?.llmDurationMs)}
        </span>
      )
    case "llmCalls":
      return <MetricCell value={stats?.llmCalls} />
    case "toolCalls":
      return <MetricCell value={stats?.toolCalls} />
    case "errors":
      return (
        <MetricCell
          tone={stats?.errorCount ? "error" : "default"}
          value={stats?.errorCount}
        />
      )
  }
}

function JsonCell({ value }: { value: TraceSummary["input"] }) {
  const preview = previewValue(value, 170)
  return (
    <span
      className="block truncate font-mono text-xs leading-4 text-foreground-muted"
      title={previewValue(value, 4_000)}
    >
      <JsonCode text={preview} />
    </span>
  )
}

function MetricCell({
  tone = "default",
  value,
}: {
  tone?: "default" | "error"
  value: number | undefined
}) {
  return (
    <span
      className={cn(
        "whitespace-nowrap tabular-nums",
        tone === "error" ? "text-status-error" : "text-foreground-secondary"
      )}
    >
      {formatCount(value)}
    </span>
  )
}

export function TraceListTable({
  pagination,
  columns,
  additionalColumns = [],
  orderStorageKey,
  persistenceKey,
  emptyMessage = "No captured traces match the current filters.",
  rowLabel,
  isTraceSkipped,
  onOpenTrace,
  selectedTraceId,
  traces,
  fillHeight = false,
  highlightedCallId,
  scores,
  settings,
  onSettingsChange,
  columnOrderStore,
  enableCardView = true,
  animateRows = false,
  columnTools,
  checkedIds: controlledCheckedIds,
  onCheckedIdsChange,
}: TraceListTableProps) {
  const [localCheckedIds, setLocalCheckedIds] = React.useState<Set<string>>(() => new Set())
  const checkedIds = controlledCheckedIds ?? localCheckedIds
  function setCheckedIds(update: (current: Set<string>) => Set<string>) {
    const next = update(checkedIds)
    if (onCheckedIdsChange) onCheckedIdsChange(next)
    else setLocalCheckedIds(next)
  }
  const checkedCount = traces.filter((trace) => checkedIds.has(trace.id)).length
  const allChecked = traces.length > 0 && checkedCount === traces.length
  const selectAllRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = checkedCount > 0 && !allChecked
    }
  }, [checkedCount, allChecked])

  function toggleTrace(id: string) {
    setCheckedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const enabledColumns: TraceTableColumn[] = TRACE_LIST_COLUMNS.filter(
    (column) => column.id === "name" || columns.includes(column.id)
  ).map((column) => ({
    id: column.id, label: column.label, width: column.minWidth,
    render: (trace) => <TraceCell column={column.id} trace={trace} skipped={isTraceSkipped?.(trace)} />,
  }))
  // Iterate backwards so columns sharing an anchor retain their supplied order.
  for (const column of [...additionalColumns].reverse()) {
    const anchor = column.after ? enabledColumns.findIndex((entry) => entry.id === column.after) : -1
    if (anchor >= 0) enabledColumns.splice(anchor + 1, 0, column)
  }
  enabledColumns.push(...additionalColumns.filter((column) => !enabledColumns.includes(column)))
  return (
    <div className="overflow-x-auto" style={fillHeight ? { height: "100%", overflow: "hidden" } : undefined}>
      <LogTable pagination={pagination} persistenceKey={persistenceKey} computedColumnStore={columnTools?.store} settings={settings} onSettingsChange={onSettingsChange} columnOrderStore={columnOrderStore} enableCardView={enableCardView} animateRows={animateRows} fillHeight={fillHeight} orderStorageKey={orderStorageKey ?? columnTools?.orderStorageKey} actionColumnIds={columnTools ? ["add-column"] : []} columnIds={[...enabledColumns.map((column) => column.id), ...(scores?.columns.map(column => `score:${column.id}`) ?? []), ...(columnTools?.columns.map(column => `computed:${column.id}`) ?? []), ...(columnTools ? ["add-column"] : [])]} widths={[...enabledColumns.map((column) => column.width), ...(scores?.columns.map(() => 140) ?? []), ...(columnTools?.columns.map(() => 180) ?? []), ...(columnTools ? [160] : [])]}>
        <caption className="sr-only">
          Trace log rows. Press Enter or Space on a focused row to open its
          inspector.
        </caption>
        <thead className={logTable.head}>
          <tr>
            <th scope="col" className="px-3 align-middle">
              <input
                ref={selectAllRef}
                type="checkbox"
                aria-label="Select all visible traces"
                checked={allChecked}
                disabled={traces.length === 0}
                className="size-4 cursor-pointer accent-selection-control"
                onChange={() => setCheckedIds((current) => {
                  const next = new Set(current)
                  for (const trace of traces) {
                    if (allChecked) next.delete(trace.id)
                    else next.add(trace.id)
                  }
                  return next
                })}
              />
            </th>
            {enabledColumns.map((column) => (
              <th
                className={logTable.heading}
                key={column.id}
                scope="col"
              >
                <span className="block truncate">{column.label}</span>
              </th>
            ))}
            {scores?.columns.map(column => <th key={column.id} scope="col" className={logTable.heading}>{column.name}</th>)}
            {columnTools?.columns.map(column => <th key={column.id} scope="col" className={logTable.heading} aria-label={column.name}><ColumnEditor addedFields={columnTools.columns} description="Calculate a value for each trace. Columns are saved for this app in this browser." column={column} rows={columnTools.rows} onSave={next => columnTools.update(columnTools.columns.map(current => current.id === next.id ? next : current))} onDelete={() => columnTools.update(columnTools.columns.filter(current => current.id !== column.id))} /></th>)}
            {columnTools && <th scope="col" className={logTable.heading}><ColumnEditor addedFields={columnTools.columns} description="Calculate a value for each trace. Columns are saved for this app in this browser." rows={columnTools.rows} onSave={column => columnTools.update([...columnTools.columns, column])} /></th>}
          </tr>
        </thead>
        <LogTableBody rows={traces} empty={traces.length === 0 ? (
            <tr>
              <td
                className="px-3 py-10 text-center text-sm text-foreground-subtle"
                colSpan={enabledColumns.length + 1 + (scores?.columns.length ?? 0) + (columnTools ? columnTools.columns.length + 1 : 0)}
              >
                {emptyMessage}
              </td>
            </tr>
          ) : null}>{(trace, index) => {
            const latestRun = !!highlightedCallId && trace.attributes["datool.call.id"] === highlightedCallId
            return (
            <LogRow
              aria-label={rowLabel?.(trace) ?? `Open ${trace.name || trace.operation}, ${statusLabel(trace.status)}${latestRun ? ", latest run" : ""}`}
              data-latest-run={latestRun || undefined}
              className={trace.status === "running" ? logTable.runningRow : undefined}
              style={latestRun ? { backgroundColor: trace.status === "running" ? undefined : "var(--info-background)", boxShadow: "inset 3px 0 var(--info)" } : undefined}
              checked={checkedIds.has(trace.id)}
              active={selectedTraceId === trace.id}
              key={trace.id}
              onClick={(event) => onOpenTrace(trace.id, event.currentTarget)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return
                if (event.key !== "Enter" && event.key !== " ") return
                event.preventDefault()
                onOpenTrace(trace.id, event.currentTarget)
              }}
              tabIndex={0}
            >
              <LogRowSelection index={index} checked={checkedIds.has(trace.id)} label={`Select trace ${index + 1}: ${trace.name || trace.operation}`} onChange={() => toggleTrace(trace.id)} />
              {enabledColumns.map((column) => (
                <td
                  className={logTable.cell}
                  key={column.id}
                >
                  {column.render(trace)}
                </td>
              ))}
              {scores?.columns.map(column => <td key={column.id} className={logTable.cell}><EvalScoreCell result={scores.results.find(result => result.traceId === trace.id && result.evaluatorId === column.id)} /></td>)}
              {columnTools?.columns.map(column => <td key={column.id} className={logTable.cell}><ComputedValue format={column.format} cell={columnTools.cells[column.id]?.[trace.id]} /></td>)}
              {columnTools && <td className={logTable.cell} onClick={event => event.stopPropagation()} />}
            </LogRow>
          )}}</LogTableBody>
      </LogTable>
    </div>
  )
}
