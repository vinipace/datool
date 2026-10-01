"use client"

import { useWorkspaceHref, useWorkspaceStorageScope } from "./workspace-path"

import * as React from "react"
import Link from "next/link"
import { Bot, ChevronLeft, ChevronRight, Workflow } from "lucide-react"

import type { SemanticQueryInput } from "@/src/lib/semantic"
import {
  performanceMeasures,
  performanceTableRow,
  type PerformanceModel,
} from "@/src/lib/tracer/performance-table"
import { Button } from "@/components/ui/button"
import { CollectionFilterBar } from "./collection-filter"
import { useCollectionFilter } from "./use-collection-filter"
import {
  filterDate,
  parseFilterQuery,
} from "@/components/ui/datool/search-bar/filter-query"
import { tracerApi } from "./api"
import { HeaderSlot } from "./collection-header"
import { CollectionPanel } from "./collection-panel"
import { CollectionPage } from "./collection-page"
import { ColumnEditor, ComputedValue } from "./eval-computed-columns"
import { CollectionRow, CollectionRowSelection, CollectionSelectAll, CollectionTable, CollectionTableBody } from "./collection-table"
import { useComputedColumns } from "./use-computed-columns"
import { useTableView } from "./use-table-view"
import { Notice } from "@/components/ui/notice"
import { formatDuration } from "./format"
import { useRemote } from "./hooks"
import { collectionTable } from "./collection-table-styles"
import { EmptyState } from "./primitives"
import { SpanKindIcon } from "./span-kind-icon"

const PAGE_SIZE = 50
const columns = [
  { id: "name", label: "Name", width: 300 },
  {
    id: "versionCount",
    label: "Versions",
    width: 120,
    title: "Distinct recorded versions in the selected time range; excludes operations without a version",
  },
  { id: "count", label: "Operations", width: 150 },
  {
    id: "errorRate",
    label: "Error rate",
    width: 180,
    title:
      "Errored / (completed + errored); excludes running and cancelled operations",
  },
  { id: "runningCount", label: "Running", width: 130 },
  { id: "cancelledCount", label: "Cancelled", width: 130 },
  { id: "meanDurationMs", label: "Avg latency", width: 150 },
  { id: "p95DurationMs", label: "P95 latency", width: 150 },
  { id: "reportedCostUsd", label: "Reported cost (USD)", width: 180 },
]
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
})

function latency(value: number | null) {
  return value === null ? "—" : formatDuration(Math.round(value * 100) / 100)
}

function percent(value: number | null) {
  return value === null
    ? "—"
    : `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
}

function PerformanceResults({
  model,
  search,
}: {
  model: PerformanceModel
  search: string
}) {
  const workspaceHref = useWorkspaceHref()
  const [offset, setOffset] = React.useState(0)
  const [checkedIds, setCheckedIds] = React.useState<Set<string>>(new Set())
  const kind = model === "agents" ? "agent" : "workflow"
  const load = React.useCallback(
    (signal: AbortSignal) => {
      const now = Date.now()
      const operators = {
        "=": "equals",
        "!=": "notEquals",
        ":": "contains",
        ">": "gt",
        ">=": "gte",
        "<": "lt",
        "<=": "lte",
      } as const
      const clauses = parseFilterQuery(search)
      let from = 0
      let to = now
      for (const clause of clauses) {
        if ("text" in clause || clause.path[0] !== "startedAt") continue
        if (clause.value === null || clause.operator === "!=")
          throw new Error("Use startedAt >= or <= to filter the time range.")
        const time = filterDate(String(clause.value), now)
        if ([">", ">="].includes(clause.operator))
          from = Math.max(from, time + (clause.operator === ">" ? 1 : 0))
        else if (["<", "<="].includes(clause.operator))
          to = Math.min(to, time - (clause.operator === "<" ? 1 : 0))
        else {
          from = Math.max(from, time)
          to = Math.min(to, time)
        }
      }
      const filters: NonNullable<SemanticQueryInput["filters"]> = clauses
        .filter((clause) => "text" in clause || clause.path[0] !== "startedAt")
        .map((clause) => {
          if ("text" in clause) {
            return {
              member: `${model}.fullText`,
              operator: "contains",
              values: [clause.text],
            }
          }
          return {
            member: `${model}.${clause.path[0]}`,
            operator:
              clause.value === null
                ? clause.operator === "!="
                  ? "set"
                  : "notSet"
                : operators[clause.operator],
            ...(clause.value === null
              ? {}
              : {
                  values: [
                    clause.path[0] === "startedAt"
                      ? new Date(
                          filterDate(String(clause.value), now)
                        ).toISOString()
                      : clause.value,
                  ],
                }),
          }
        })
      const query: SemanticQueryInput = {
        measures: performanceMeasures.map((name) => `${model}.${name}`),
        dimensions: [`${model}.name`],
        timeDimensions: [
          {
            dimension: `${model}.startedAt`,
            dateRange: [
              new Date(from).toISOString(),
              new Date(to).toISOString(),
            ],
          },
        ],
        filters,
        order: [
          [`${model}.count`, "desc"],
          [`${model}.name`, "asc"],
        ],
        limit: PAGE_SIZE,
        offset,
        total: true,
      }
      return tracerApi.performance(query, signal)
    },
    [model, offset, search]
  )
  const { data, error, isLoading, isRefreshing, refresh } = useRemote(
    load,
    [load],
    { intervalMs: 15_000 }
  )
  const rows = React.useMemo(
    () => (data?.data ?? []).map((row) => performanceTableRow(row, model)),
    [data, model]
  )
  const total = data?.meta.page.total ?? 0
  const checkedRows = rows.filter((row) => checkedIds.has(row.id))
  const allChecked = rows.length > 0 && checkedRows.length === rows.length
  const storageScope = useWorkspaceStorageScope()
  const tableScope = `performance:${storageScope}:${model}`
  const computed = useComputedColumns(
    `performance:${model}`,
    rows,
    `datool:${tableScope}:fields`
  )
  const tableView = useTableView({
    resource: model,
    settingsStorageKey: `datool:${tableScope}:settings`,
    orderStorageKey: `datool:${tableScope}:columns`,
    computed,
  })

  return (
    <CollectionPage
      className="contents"
      state={{ data, error, isLoading, isRefreshing, refresh }}
      loadingLabel={`Loading ${model} performance`}
      selection={{
        rows: (data?.data ?? []).filter((_, index) => checkedIds.has(rows[index].id)),
        onClear: () => setCheckedIds(new Set()),
      }}
      header={{ exportRows: data?.data ?? [], exportName: model }}
      savedView={tableView.savedView}
      toolbar={
        computed.storageError || tableView.storageError ? (
          <Notice variant="error" role="status" className="mb-2">
            {computed.storageError || tableView.storageError}
          </Notice>
        ) : null
      }
    >
      <CollectionTable
        fillHeight
        reorderable
        enableCardView
        settings={tableView.settings}
        onSettingsChange={tableView.onSettingsChange}
        columnOrderStore={tableView.columnOrderStore}
        computedColumnStore={computed.store}
        actionColumnIds={["add-column"]}
        columnIds={[
          ...columns.map((column) => column.id),
          ...computed.columns.map((column) => `computed:${column.id}`),
          "add-column",
        ]}
        widths={[
          ...columns.map((column) => column.width),
          ...computed.columns.map(() => 240),
          160,
        ]}
      >
        <thead className={collectionTable.head}>
          <tr>
            <th className="px-3" scope="col">
              <CollectionSelectAll
                label={`Select all visible ${model}`}
                checked={allChecked}
                partial={checkedRows.length > 0 && !allChecked}
                disabled={!rows.length}
                onChange={() => setCheckedIds(allChecked ? new Set() : new Set(rows.map((row) => row.id)))}
              />
            </th>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={collectionTable.heading}
                title={column.title}
              >
                {column.label}
              </th>
            ))}
            {computed.columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                aria-label={column.name}
                className={collectionTable.heading}
              >
                <ColumnEditor
                  resource="performance"
                  column={column}
                  addedFields={computed.columns}
                  rows={rows}
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
            <th
              scope="col"
              aria-label="Add column"
              className={collectionTable.heading}
            >
              <ColumnEditor
                borderless
                resource="performance"
                addedFields={computed.columns}
                rows={rows}
                onSave={(column) =>
                  computed.update([...computed.columns, column])
                }
              />
            </th>
          </tr>
        </thead>
        <CollectionTableBody
          rows={rows}
          empty={
            <tr>
              <td colSpan={columns.length + computed.columns.length + 2}>
                <EmptyState
                  icon={kind === "agent" ? Bot : Workflow}
                  title={
                    search
                      ? `No matching ${model}`
                      : `No ${model} in this time range`
                  }
                  detail={
                    search
                      ? "Try another name or a wider time range."
                      : `Record a named ${kind} to start tracking performance.`
                  }
                />
              </td>
            </tr>
          }
        >
          {(row, index) => {
            const { name, metrics } = row
            const count = metrics.count ?? 0
            const complete = metrics.completeCostCount ?? 0
            const cost = metrics.reportedCostUsd
            const filter = `groupType = ${JSON.stringify(kind)} groupName = ${JSON.stringify(name)}`
            const href = workspaceHref(
              `/traces?${new URLSearchParams({ filter })}`
            )
            return (
              <CollectionRow key={row.id} checked={checkedIds.has(row.id)} className="cursor-default">
                <CollectionRowSelection
                  index={offset + index}
                  checked={checkedIds.has(row.id)}
                  label={`Select ${name}`}
                  onChange={() => setCheckedIds((current) => {
                    const next = new Set(current)
                    if (next.has(row.id)) next.delete(row.id)
                    else next.add(row.id)
                    return next
                  })}
                />
                <td className={`${collectionTable.cell} font-medium`}>
                  <Link
                    className="flex max-w-full items-center gap-2 rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    href={href}
                  >
                    <SpanKindIcon kind={kind} />
                    <span className="truncate" title={name}>
                      {name}
                    </span>
                  </Link>
                </td>
                <td className={`${collectionTable.cell} tabular-nums`}>
                  {metrics.versionCount?.toLocaleString() ?? "—"}
                </td>
                <td className={`${collectionTable.cell} tabular-nums`}>
                  {count.toLocaleString()}
                </td>
                <td
                  className={`${collectionTable.cell} whitespace-nowrap tabular-nums`}
                >
                  <span
                    className={metrics.erroredCount ? "text-destructive" : ""}
                  >
                    {percent(metrics.errorRate)}
                  </span>
                  <span className="ml-1 text-xs text-foreground-muted">
                    ({metrics.erroredCount} errors)
                  </span>
                </td>
                <td className={`${collectionTable.cell} tabular-nums`}>
                  {metrics.runningCount}
                </td>
                <td className={`${collectionTable.cell} tabular-nums`}>
                  {metrics.cancelledCount}
                </td>
                <td
                  className={`${collectionTable.cell} tabular-nums`}
                  title={`${metrics.durationSampleCount} completed/errored latency samples`}
                >
                  {latency(metrics.meanDurationMs)}
                </td>
                <td
                  className={`${collectionTable.cell} tabular-nums`}
                  title="Nearest-rank 95th percentile of completed/errored latency samples"
                >
                  {latency(metrics.p95DurationMs)}
                </td>
                <td className={`${collectionTable.cell} tabular-nums`}>
                  {cost === null ? (
                    <span className="text-foreground-muted">Not reported</span>
                  ) : (
                    <>
                      {usd.format(cost)}
                      {complete < count ? (
                        <span className="ml-1 text-xs text-foreground-muted">
                          Partial
                        </span>
                      ) : null}
                    </>
                  )}
                </td>
                {computed.columns.map((column) => (
                  <td key={column.id} className={collectionTable.cell}>
                    <div className={collectionTable.compactContent}>
                      <ComputedValue
                        cell={computed.cells[column.id]?.[row.id]}
                        format={column.format}
                      />
                    </div>
                  </td>
                ))}
                <td className={collectionTable.cell} />
              </CollectionRow>
            )
          }}
        </CollectionTableBody>
      </CollectionTable>
      <div className="flex shrink-0 items-center justify-between gap-3 px-1 py-3 text-xs text-foreground-muted">
        <span>
          {rows.length
            ? `${offset + 1}–${offset + rows.length} of ${total}`
            : "0 results"}
          {data
            ? ` · Updated ${new Date(data.meta.asOf).toLocaleTimeString()}`
            : ""}
        </span>
        <div className="flex gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Previous page"
            disabled={offset === 0 || isRefreshing}
            onClick={() => {
              setCheckedIds(new Set())
              setOffset(Math.max(0, offset - PAGE_SIZE))
            }}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Next page"
            disabled={offset + PAGE_SIZE >= total || isRefreshing}
            onClick={() => {
              setCheckedIds(new Set())
              setOffset(offset + PAGE_SIZE)
            }}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </CollectionPage>
  )
}

export function PerformancePage({
  model,
  initialFilter = "startedAt >= -7d",
}: {
  model: PerformanceModel
  initialFilter?: string
}) {
  const search = useCollectionFilter(model, initialFilter)
  const storageScope = useWorkspaceStorageScope()
  return (
    <CollectionPanel label={model === "agents" ? "Agents" : "Workflows"}>
      <HeaderSlot name="filter">
        <CollectionFilterBar
          resource={model}
          value={search.value}
          onChange={(value) => {
            search.onChange(value)
          }}
          error={search.error}
        />
      </HeaderSlot>
      <PerformanceResults
        key={JSON.stringify([storageScope, model, search.filter])}
        model={model}
        search={search.filter}
      />
    </CollectionPanel>
  )
}
