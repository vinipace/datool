"use client"

import { createContext, useContext, useMemo, useRef, useState } from "react"
import {
  Canvas,
  type CanvasLayoutChange,
  type WidgetComponents,
  type WidgetEditors,
} from "@/components/ui/canvas"
import { Button } from "@/components/ui/button"
import { DashboardWidgetSkeleton } from "@/components/ui/dashboard-skeleton"
import { Notice } from "@/components/ui/notice"
import {
  scopedWidget,
  type DashboardScope,
} from "@/src/lib/tracer/dashboard-queries"
import type { DashboardWidget } from "@/src/lib/tracer/dashboards"
import type { SemanticResult } from "@/src/lib/semantic/result"
import type { SemanticCatalogMetadata } from "@/src/lib/semantic/catalog"
import { useRemote, type RemoteState } from "./hooks"
import { useProjectScope } from "./project-scope-context"
import { dashboardRequest } from "./dashboard-utils"
import {
  dashboardCanvasWidgets,
  type DashboardWidgetMap,
  type DashboardWidgetProps,
} from "./dashboard-canvas-layout"
import { DashboardWidgetEditor } from "./dashboard-widget-editor"
import { DashboardCatalogContext } from "./dashboard-catalog-context"
import { WidgetResult } from "./dashboard-widget-result"
import { DashboardFilterScopeContext } from "./dashboard-catalog-context"
import { dashboardQueryPlan } from "@/src/lib/tracer/dashboard-query-plan"
import {
  comparisonTimeChart,
  type DashboardCohortResult,
} from "./dashboard-comparison"
import { DashboardTimeChart } from "./dashboard-time-chart"

type Entry = DashboardCohortResult[]
const ResultsContext = createContext<{
  entries: Map<string, Entry>
  barColorIndexes: Map<string, number>
  error: boolean
  setOffset: (id: string, offset: number) => void
} | null>(null)

function MetricWidget({ widget }: DashboardWidgetProps) {
  const context = useContext(ResultsContext)!
  const entry = context.entries.get(widget.id)
  if (!entry && !context.error)
    return <DashboardWidgetSkeleton type={widget.type} />
  if (!entry)
    return (
      <p className="p-4 text-xs text-foreground-muted">
        Unable to load widget data.
      </p>
    )
  if (entry.length > 1 && (widget.type === "line" || widget.type === "stacked"))
    return <DashboardTimeChart {...comparisonTimeChart(widget, entry)} />
  return (
    <>
      {entry.map((cohort) => (
        <div
          key={cohort.offsetKey}
          className={
            ["metric", "line", "stacked"].includes(widget.type) &&
            entry.length === 1
              ? "flex h-full min-h-0 flex-col"
              : undefined
          }
        >
          {cohort.label && (
            <p className="shrink-0 px-4 pt-3 text-xs font-medium">
              {cohort.label}
            </p>
          )}
          <WidgetResult
            widget={widget}
            colorIndex={context.barColorIndexes.get(widget.id)}
            {...cohort}
            setOffset={(offset) => context.setOffset(cohort.offsetKey, offset)}
          />
        </div>
      ))}
    </>
  )
}
const components = {
  metric: MetricWidget,
  bar: MetricWidget,
  donut: MetricWidget,
  table: MetricWidget,
  stacked: MetricWidget,
  line: MetricWidget,
} satisfies WidgetComponents<DashboardWidgetMap>
const editors = {
  metric: DashboardWidgetEditor,
  bar: DashboardWidgetEditor,
  donut: DashboardWidgetEditor,
  table: DashboardWidgetEditor,
  stacked: DashboardWidgetEditor,
  line: DashboardWidgetEditor,
} satisfies WidgetEditors<DashboardWidgetMap>

export function DashboardRenderer({
  widgets,
  revision = 0,
  scope,
  editable = false,
  catalog,
  onLayoutChange,
  onWidgetChange,
  onWidgetRemove,
}: {
  widgets: DashboardWidget[]
  revision?: number
  scope?: DashboardScope
  editable?: boolean
  catalog?: RemoteState<SemanticCatalogMetadata>
  onLayoutChange?: (layout: CanvasLayoutChange[]) => void
  onWidgetChange?: (widget: DashboardWidget) => void
  onWidgetRemove?: (id: string) => void
}) {
  const projectId = useProjectScope()?.projectId
  const { filter, from, to, timezone } = scope ?? {}
  const resolved = useMemo(() => {
    try {
      return {
        widgets:
          from && to && timezone
            ? widgets.map((widget) =>
                scopedWidget(widget, {
                  filter: filter ?? "",
                  from,
                  to,
                  timezone,
                })
              )
            : widgets,
        error: null,
      }
    } catch (cause) {
      return {
        widgets: [],
        error:
          cause instanceof Error ? cause.message : "Invalid dashboard filter.",
      }
    }
  }, [widgets, filter, from, to, timezone])
  // Layout, titles and series presentation never trigger a metrics request.
  const source = JSON.stringify(
    resolved.widgets.map(({ id, type, query, groups, compare }) => ({
      id,
      type,
      query,
      groups,
      compare,
    }))
  )
  const [pagination, setPagination] = useState({
    source,
    offsets: {} as Record<string, number>,
  })
  if (pagination.source !== source) setPagination({ source, offsets: {} })
  const requests = useMemo(
    () =>
      dashboardQueryPlan(
        JSON.parse(source) as DashboardWidget[],
        pagination.offsets
      ),
    [source, pagination.offsets]
  )
  const forceRevision = useRef(revision)
  const cache =
    scope?.dateFilter !== undefined &&
    scope.rangeEnd !== undefined &&
    !scope.filter
      ? { dateFilter: scope.dateFilter, rangeEnd: scope.rangeEnd }
      : undefined
  // A refresh can advance a relative window without changing what the user is viewing.
  // Keep its last result, but never carry it into another project, filter or widget query.
  const dataKey = JSON.stringify({
    projectId,
    widgets: widgets.map(({ id, type, query, groups, compare }) => ({
      id,
      type,
      query,
      groups,
      compare,
    })),
    offsets: pagination.offsets,
    scope: scope
      ? {
          filter,
          timezone,
          dateFilter: scope.dateFilter,
          ...(!scope.dateFilter ? { from, to } : {}),
        }
      : null,
  })
  const key = JSON.stringify({
    projectId,
    revision,
    ...requests,
    cache,
    dataKey,
  })
  const load = useMemo(() => {
    let attempts = 0
    return async (signal: AbortSignal) => {
      const { batches, cache, revision, projectId, dataKey } = JSON.parse(
        key
      ) as typeof requests & {
        cache?: { dateFilter: string; rangeEnd: number }
        revision: number
        projectId?: string
        dataKey: string
      }
      const force = revision !== forceRevision.current
      forceRevision.current = revision
      const results: SemanticResult[] = []
      let stale = false
      for (const queries of batches) {
        results.push(
          ...(await dashboardRequest<SemanticResult[]>(
            "/api/metrics/batch",
            "POST",
            { queries, ...(cache ? { cache: { ...cache, force } } : {}) },
            {
              signal,
              projectId,
              onResponse: (response) => {
                stale ||= response.headers.get("X-Datool-Cache") === "stale"
              },
            }
          ))
        )
      }
      attempts++
      return { key: dataKey, results, revalidating: stale && attempts < 7 }
    }
  }, [key])
  const state = useRemote(load, [], {
    enabled: requests.batches.length > 0,
    intervalMs: 5_000,
    shouldPoll: (data) => data?.revalidating ?? false,
    keepPreviousData: true,
  })
  const entries = new Map<string, Entry>()
  if (state.data?.key === dataKey) {
    for (const position of requests.positions) {
      const results = state.data.results
      const cohorts = position.cohorts.map((cohort) => ({
        ...cohort,
        result: results[cohort.result],
        summary: cohort.summary === null ? null : results[cohort.summary],
        previous: cohort.previous === null ? null : results[cohort.previous],
        history: cohort.history === null ? null : results[cohort.history],
      }))
      if (cohorts.every((cohort) => cohort.result))
        entries.set(position.id, cohorts)
    }
  }
  const canvasWidgets = useMemo(
    () => dashboardCanvasWidgets(widgets),
    [widgets]
  )
  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col gap-3"
      aria-busy={state.isLoading || state.isRefreshing}
    >
      {resolved.error ? (
        <Notice role="alert" variant="error">
          {resolved.error}
        </Notice>
      ) : widgets.length > 0 && state.error ? (
        <Notice role="alert" variant="error">
          {state.error.message}
          <Button variant="outline" size="sm" onClick={state.refresh}>
            Retry
          </Button>
        </Notice>
      ) : null}
      <DashboardFilterScopeContext value={scope}>
        <DashboardCatalogContext value={catalog ?? null}>
          <ResultsContext
            value={{
              entries,
              barColorIndexes: new Map(
                widgets
                  .filter((widget) => widget.type === "bar")
                  .map((widget, index) => [widget.id, index])
              ),
              error: !!state.error || !!resolved.error,
              setOffset: (id, offset) =>
                setPagination((current) => ({
                  ...current,
                  offsets: { ...current.offsets, [id]: offset },
                })),
            }}
          >
            <Canvas<DashboardWidgetMap>
              widgets={canvasWidgets}
              components={components}
              editors={editors}
              editable={editable}
              widgetVariant="borderless"
              getWidgetLabel={({ props }) => props.widget.title}
              onLayoutChange={onLayoutChange}
              onWidgetPropsChange={
                onWidgetChange
                  ? (_id, props) => onWidgetChange(props.widget)
                  : undefined
              }
              onWidgetRemove={onWidgetRemove}
            />
          </ResultsContext>
        </DashboardCatalogContext>
      </DashboardFilterScopeContext>
    </div>
  )
}
