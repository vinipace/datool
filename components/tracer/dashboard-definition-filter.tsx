"use client"

import { useCallback, useContext } from "react"
import { Combobox, type ComboboxOption } from "@/components/ui/combobox"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import type { DashboardWidget } from "@/src/lib/tracer/dashboards"
import { semanticQuerySchema } from "@/src/lib/semantic/query"
import type { SemanticResult } from "@/src/lib/semantic/result"
import { DashboardFilterScopeContext } from "./dashboard-catalog-context"
import { dashboardRequest } from "./dashboard-utils"
import { useRemote } from "./hooks"
import { ScorerIcon } from "./scorer-icon"

/** The same definition selector protects numeric ratings and makes scorer comparisons explicit. */
export function DashboardDefinitionFilter({
  widget,
  onChange,
}: {
  widget: DashboardWidget
  onChange: (widget: DashboardWidget) => void
}) {
  const model = widget.query.measures[0].split(".")[0]
  const ratings = model === "scoreValues"
  const member = `${model}.${ratings ? "definitionId" : "evaluatorVersionId"}`
  const label = ratings ? "Score definition" : "Scorer version"
  const name = `${model}.${ratings ? "name" : "evaluatorName"}`
  const scope = useContext(DashboardFilterScopeContext)
  const time = widget.query.timeDimensions[0]
  const source = JSON.stringify({
    time: {
      ...time,
      granularity: undefined,
      dateRange: scope ? [scope.from, scope.to] : time.dateRange,
    },
    timezone: scope?.timezone ?? widget.query.timezone,
    member,
    name,
    model,
    dimensions: ratings
      ? [
          member,
          name,
          "scoreValues.evaluatorName",
          "scoreValues.evaluatorVersion",
          "scoreValues.type",
          "scoreValues.scale",
          "scoreValues.origin",
        ]
      : [member, name, "evalResults.evaluatorVersion"],
  })
  const load = useCallback(
    async (signal: AbortSignal) => {
      const config = JSON.parse(source)
      return dashboardRequest<SemanticResult>(
        "/api/metrics/query",
        "POST",
        semanticQuerySchema.parse({
          measures: [
            `${config.model}.${config.model === "scoreValues" ? "count" : "executionCount"}`,
          ],
          dimensions: config.dimensions,
          timeDimensions: [config.time],
          timezone: config.timezone,
          order: [[config.name, "asc"]],
          limit: 5000,
          total: true,
        }),
        { signal }
      )
    },
    [source]
  )
  const state = useRemote(load, [])
  const selected = widget.query.filters.find(
    (f) => "member" in f && f.member === member && f.operator === "equals"
  )
  const value =
    selected && "member" in selected ? String(selected.values?.[0] ?? "") : ""
  const options: ComboboxOption[] = (state.data?.data ?? [])
    .flatMap((row) => {
      if (typeof row[member] !== "string") return []
      const scorer = row[`${model}.evaluatorName`]
      const scoreName = row[name]
      const version = row[`${model}.evaluatorVersion`]
      const title =
        ratings && scorer
          ? [
              scorer,
              scoreName !== "score" && scoreName !== scorer ? scoreName : null,
            ]
              .filter(Boolean)
              .join(" · ")
          : String(scoreName ?? row[member])
      const description = [
        version ? `Version ${version}` : null,
        ratings && row["scoreValues.origin"] !== "evaluator"
          ? row["scoreValues.origin"]
          : null,
        ratings ? row["scoreValues.type"] : null,
        ratings ? row["scoreValues.scale"] : null,
      ]
        .filter(Boolean)
        .join(" · ")
      return [
        {
          value: row[member],
          label: title,
          description: description || row[member],
          descriptionBelow: true,
          descriptionWrap: true,
          keywords: [row[member], String(scoreName ?? ""), description],
        },
      ]
    })
    .sort(
      (a, b) =>
        a.label.localeCompare(b.label) ||
        a.description!.localeCompare(b.description!, undefined, {
          numeric: true,
        })
    )
  if (value && !options.some((o) => o.value === value))
    options.push({
      value,
      label: value,
      description: "Saved selection",
      descriptionBelow: true,
      descriptionWrap: true,
    })

  function selectDefinition(next: string) {
    const definition = state.data?.data.find((row) => row[member] === next)
    const defaultMetric =
      ratings &&
      widget.type === "metric" &&
      widget.query.measures.length === 1 &&
      ["scoreValues.count", "scoreValues.numericCount"].includes(
        widget.query.measures[0]
      )
    const average =
      defaultMetric && definition?.["scoreValues.type"] === "numeric"
    // Returning to all definitions must not combine values on unrelated scales.
    const resetNumeric =
      ratings &&
      widget.type === "metric" &&
      !next &&
      !widget.query.dimensions.includes(member) &&
      widget.query.measures.some((measure) =>
        [
          "scoreValues.meanValue",
          "scoreValues.minValue",
          "scoreValues.maxValue",
        ].includes(measure)
      )
    onChange({
      ...widget,
      title:
        average && ["Saved ratings", "Numeric ratings"].includes(widget.title)
          ? options.find((option) => option.value === next)!.label
          : widget.title,
      query: {
        ...widget.query,
        ...(average || resetNumeric
          ? {
              measures: [
                average ? "scoreValues.meanValue" : "scoreValues.count",
              ],
              order: [],
              having: [],
            }
          : {}),
        offset: 0,
        filters: [
          ...widget.query.filters.filter(
            (f) => !("member" in f && f.member === member)
          ),
          ...(next
            ? [{ member, operator: "equals" as const, values: [next] }]
            : []),
        ],
      },
    })
  }
  return (
    <div className="space-y-2">
      <label className="block space-y-2 text-xs font-medium">
        {label}
        <Combobox
          label={label}
          icon={<ScorerIcon />}
          value={value}
          options={[
            {
              value: "",
              label: ratings ? "All definitions (counts only)" : "All scorers",
            },
            ...options,
          ]}
          disabled={state.isLoading}
          onValueChange={selectDefinition}
        />
      </label>
      {state.isLoading && (
        <p role="status" className="text-xs text-foreground-muted">
          Loading definitions…
        </p>
      )}
      {state.error && (
        <Notice variant="error" role="alert">
          {state.error.message}
          <Button size="sm" variant="outline" onClick={state.refresh}>
            Retry definitions
          </Button>
        </Notice>
      )}
      {state.data?.meta.page.total !== undefined &&
        state.data.meta.page.total > options.length && (
          <p className="text-xs text-foreground-muted">
            More definitions exist. Use a definition ID in Filters to select one
            outside this list.
          </p>
        )}
    </div>
  )
}
