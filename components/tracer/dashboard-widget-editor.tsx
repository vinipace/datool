"use client"

import { dashboardDimensionIcon } from "./dashboard-dimension-icon"

import { useContext, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Combobox, ComboboxMultiple } from "@/components/ui/combobox"
import { Clock3, Database, Group, Hash, Type } from "lucide-react"
import { defaultMetricTrendDirection } from "@/src/lib/tracer/dashboard-metric-comparison"
import {
  dashboardSourceOptions,
  dashboardWidgetOptions,
} from "./dashboard-widget-options"
import { previewDashboardSourceMigration } from "@/src/lib/tracer/dashboard-source-migration"
import { DashboardDefinitionFilter } from "./dashboard-definition-filter"
import { Notice } from "@/components/ui/notice"
import type { WidgetControls } from "@/components/ui/canvas"
import {
  dashboardWidgetSchema,
  expandLegacyDashboardGrouping,
  newDashboardWidget,
  type DashboardWidget,
} from "@/src/lib/tracer/dashboards"
import type { DashboardWidgetProps } from "./dashboard-canvas-layout"
import { DashboardCatalogContext } from "./dashboard-catalog-context"
import { DashboardWidgetFilters } from "./dashboard-widget-filters"
import { MAX_SEMANTIC_DIMENSIONS } from "@/src/lib/semantic/query"

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-2 text-xs font-medium">
      {label}
      {children}
    </label>
  )
}
function editableConfig(widget: DashboardWidget) {
  const {
    title,
    type,
    query,
    series,
    groups,
    compare,
    trendDirection,
    showGroupIcons,
  } = widget
  return JSON.stringify({
    title,
    type,
    query,
    series,
    groups,
    compare,
    trendDirection,
    showGroupIcons,
  })
}

export function DashboardWidgetEditor({
  widget,
  onPropsChange,
}: DashboardWidgetProps & WidgetControls<DashboardWidgetProps>) {
  const catalog = useContext(DashboardCatalogContext)
  const source = editableConfig(widget)
  const [migrationOpen, setMigrationOpen] = useState(false)
  const [draft, setDraft] = useState({ source, widget, error: "" })
  if (draft.source !== source) {
    setDraft({ source, widget, error: "" })
  }
  const value = expandLegacyDashboardGrouping(draft.widget)
  const model = catalog?.data?.models.find(
    (item) => item.name === value.query.measures[0]?.split(".")[0]
  )
  const measures =
    model?.members.filter((member) => member.kind === "measure") ?? []
  const groups =
    model?.members.filter(
      (member) =>
        !["evalQuality.groupModel", "evalResults.groupModel"].includes(
          member.name
        ) &&
        (member.kind === "timeDimension" ||
          (member.kind === "dimension" && member.groupable !== false))
    ) ?? []
  const time = value.query.timeDimensions[0]
  const selectedGroups = [
    ...value.query.dimensions,
    ...(time?.granularity ? [time.dimension] : []),
  ]
  const timeMember = groups.find(
    (member) =>
      member.name === time?.dimension && member.kind === "timeDimension"
  )

  function change(next: DashboardWidget) {
    const candidate = {
      ...next,
      id: widget.id,
      width: widget.width,
      layout: widget.layout,
    }
    const numericRating = candidate.query.measures.some((name) =>
      [
        "scoreValues.meanValue",
        "scoreValues.minValue",
        "scoreValues.maxValue",
      ].includes(name)
    )
    const compatible =
      candidate.query.dimensions.includes("scoreValues.definitionId") ||
      candidate.query.filters.some(
        (f) =>
          "member" in f &&
          f.member === "scoreValues.definitionId" &&
          f.operator === "equals" &&
          f.values?.length === 1
      )
    if (numericRating && !compatible) {
      setDraft({
        source,
        widget: candidate,
        error:
          "Numeric ratings require a score definition or grouping by Score definition.",
      })
      return
    }
    const parsed = dashboardWidgetSchema.safeParse(candidate)
    if (!parsed.success) {
      setDraft({
        source,
        widget: candidate,
        error: parsed.error.issues[0].message,
      })
      return
    }
    setDraft({
      source: editableConfig(parsed.data),
      widget: { ...parsed.data, title: candidate.title },
      error: "",
    })
    onPropsChange({ widget: parsed.data })
  }
  function grouping(names: string[], type = value.type): DashboardWidget {
    const members = names.flatMap(
      (name) => groups.find((item) => item.name === name) ?? []
    )
    const selectedTime = members.find(
      (member) => member.kind === "timeDimension"
    )
    const selectedMeasures = ["metric", "bar", "donut"].includes(type)
      ? value.query.measures.slice(0, 1)
      : value.query.measures
    const next = {
      ...value,
      type,
      query: {
        ...value.query,
        offset: 0,
        ...(["line", "stacked"].includes(type) && selectedTime
          ? {
              limit: members.some((member) => member.kind === "dimension")
                ? (model?.maxLimit ?? 100)
                : 100,
            }
          : {}),
        measures: selectedMeasures,
        order:
          ["line", "stacked"].includes(type) && selectedTime
            ? [[selectedTime.name, "asc"] as [string, "asc"]]
            : value.query.order.filter(
                ([name]) =>
                  selectedMeasures.includes(name) || names.includes(name)
              ),
        dimensions: members
          .filter((member) => member.kind === "dimension")
          .map((member) => member.name),
        timeDimensions: [
          {
            dimension: selectedTime?.name ?? time.dimension,
            dateRange: time.dateRange,
            ...(selectedTime
              ? {
                  granularity:
                    selectedTime.name === time.dimension && time.granularity
                      ? time.granularity
                      : selectedTime.granularities.includes("day")
                        ? ("day" as const)
                        : selectedTime.granularities[0],
                }
              : {}),
          },
        ],
      },
    }
    return next
  }

  if (!catalog || catalog.isLoading)
    return (
      <p role="status" className="text-xs text-foreground-muted">
        Loading available metrics…
      </p>
    )
  if (catalog.error)
    return (
      <Notice variant="error" role="alert">
        {catalog.error.message}
        <Button variant="outline" size="sm" onClick={catalog.refresh}>
          Retry metrics
        </Button>
      </Notice>
    )
  if (!model)
    return (
      <Notice variant="error" role="alert">
        This widget's data source is unavailable.
      </Notice>
    )

  const multipleMeasures = !["metric", "bar", "donut"].includes(value.type)
  const definitionSelected =
    value.query.dimensions.includes("scoreValues.definitionId") ||
    value.query.filters.some(
      (f) =>
        "member" in f &&
        f.member === "scoreValues.definitionId" &&
        f.operator === "equals" &&
        f.values?.length === 1
    )
  const migration = previewDashboardSourceMigration(
    value,
    catalog.data?.models ?? []
  )
  const measureOptions = measures.map((member) => ({
    disabled: member.requiresDefinition && !definitionSelected,
    description:
      member.requiresDefinition && !definitionSelected
        ? "Select a score definition or group by definition first."
        : undefined,
    descriptionBelow: true,
    descriptionWrap: true,
    value: member.name,
    label: member.title,
    keywords: [member.name, member.description],
  }))
  function changeMeasures(selected: string[]) {
    change({
      ...value,
      title:
        value.title ===
        measures.find((m) => m.name === value.query.measures[0])?.title
          ? (measures.find((m) => m.name === selected[0])?.title ?? value.title)
          : value.title,
      series: undefined,
      query: { ...value.query, measures: selected, offset: 0, order: [] },
    })
  }

  return (
    <div className="space-y-4">
      {draft.error && (
        <Notice variant="error" role="alert">
          {draft.error} These changes have not been saved.
        </Notice>
      )}
      <Field label="Title">
        <Input
          icon={<Type />}
          value={value.title}
          maxLength={160}
          onChange={(event) => change({ ...value, title: event.target.value })}
        />
      </Field>
      <Field label="Data source">
        <Combobox
          label="Data source"
          icon={<Database />}
          options={dashboardSourceOptions(
            catalog.data?.models ?? [],
            model.name
          )}
          value={model.name}
          onValueChange={(name) => {
            const next = catalog.data?.models.find((item) => item.name === name)
            if (next) {
              change(newDashboardWidget(next))
            }
          }}
        />
      </Field>
      {migration && (
        <Notice>
          <p>This widget uses the original {migration.source} definitions.</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setMigrationOpen(!migrationOpen)}
          >
            Preview source migration
          </Button>
          {migrationOpen && (
            <div className="space-y-2">
              <p>
                {migration.source} → {migration.target}
              </p>
              {migration.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
              <details>
                <summary>Query changes</summary>
                <pre className="overflow-auto text-xs">
                  {JSON.stringify(
                    { before: migration.before, after: migration.after },
                    null,
                    2
                  )}
                </pre>
              </details>
              {migration.unsupported.length ? (
                <p>
                  Requires manual changes: {migration.unsupported.join(", ")}
                </p>
              ) : (
                <Button
                  size="sm"
                  onClick={() => {
                    change(migration.widget)
                    setMigrationOpen(false)
                  }}
                >
                  Apply source migration
                </Button>
              )}
            </div>
          )}
        </Notice>
      )}
      <Field label="Visualization">
        <Combobox
          label="Visualization"
          options={[...dashboardWidgetOptions]}
          value={value.type}
          onValueChange={(selected) => {
            const type = selected as DashboardWidget["type"]
            const nextGroup =
              type === "metric"
                ? []
                : type === "line" || type === "stacked"
                  ? [time.dimension, ...value.query.dimensions.slice(0, 1)]
                  : selectedGroups.length
                    ? selectedGroups
                    : type === "table"
                      ? []
                      : [groups[0]?.name ?? time.dimension]
            const next = grouping(nextGroup, type)
            if (
              ["bar", "donut"].includes(value.type) &&
              ["bar", "donut"].includes(type)
            )
              next.query = value.query
            next.series = undefined
            change(next)
          }}
        />
      </Field>
      {["scoreValues", "evalResults"].includes(model.name) && (
        <DashboardDefinitionFilter widget={value} onChange={change} />
      )}
      <Field label={multipleMeasures ? "Measures" : "Measure"}>
        {multipleMeasures ? (
          <ComboboxMultiple
            label="Measures"
            icon={<Hash />}
            placeholder="Add measure…"
            options={measureOptions}
            value={value.query.measures}
            onValueChange={changeMeasures}
            minSelected={1}
          />
        ) : (
          <Combobox
            label="Measure"
            icon={<Hash />}
            options={measureOptions}
            value={value.query.measures[0]}
            onValueChange={(measure) => changeMeasures([measure])}
          />
        )}
      </Field>
      {value.type === "metric" && (
        <Field label="Improvement direction">
          <Combobox
            label="Improvement direction"
            value={value.trendDirection ?? "auto"}
            options={[
              {
                value: "auto",
                label: `Automatic (${{ increase: "higher is better", decrease: "lower is better", neutral: "neutral" }[defaultMetricTrendDirection(value.query.measures[0])]})`,
              },
              { value: "increase", label: "Higher is better" },
              { value: "decrease", label: "Lower is better" },
              { value: "neutral", label: "Neutral" },
            ]}
            onValueChange={(direction) =>
              change({
                ...value,
                trendDirection:
                  direction === "auto"
                    ? undefined
                    : (direction as "increase" | "decrease" | "neutral"),
              })
            }
          />
        </Field>
      )}
      {value.query.dimensions.some(
        (name) => groups.find((m) => m.name === name)?.overlap
      ) && (
        <Notice>
          Related groups can overlap. Totals across these groups must not be
          added together.
        </Notice>
      )}
      <Field label="Group by">
        {["line", "stacked"].includes(value.type) ? (
          <Combobox
            label="Group by"
            icon={<Group />}
            value={time.dimension}
            onValueChange={(name) =>
              change(grouping([name, ...value.query.dimensions]))
            }
            options={groups
              .filter((member) => member.kind === "timeDimension")
              .map((member) => ({
                value: member.name,
                label: member.title,
                icon: dashboardDimensionIcon(member.name),
              }))}
          />
        ) : (
          <ComboboxMultiple
            label="Group by"
            icon={<Group />}
            placeholder={value.type === "metric" ? "No grouping" : "Add field…"}
            value={selectedGroups}
            disabled={value.type === "metric"}
            minSelected={["bar", "donut"].includes(value.type) ? 1 : 0}
            maxSelected={MAX_SEMANTIC_DIMENSIONS}
            onValueChange={(names) => change(grouping(names))}
            options={groups
              .filter(
                (member) =>
                  member.kind !== "timeDimension" ||
                  !time.granularity ||
                  member.name === time.dimension
              )
              .map((member) => ({
                value: member.name,
                label: member.title,
                keywords: [member.name, member.description],
                icon: dashboardDimensionIcon(member.name),
              }))}
          />
        )}
        {["bar", "donut", "table"].includes(value.type) && (
          <p className="font-normal text-foreground-muted">
            Each combination of selected fields forms a group.
          </p>
        )}
      </Field>
      {["line", "stacked"].includes(value.type) && (
        <Field label="Series by">
          <Combobox
            label="Series by"
            icon={<Group />}
            value={value.query.dimensions[0] ?? ""}
            options={[
              { value: "", label: "Measure only" },
              ...groups
                .filter((member) => member.kind === "dimension")
                .map((member) => ({
                  value: member.name,
                  label: member.title,
                  keywords: [member.name, member.description],
                  icon: dashboardDimensionIcon(member.name),
                })),
            ]}
            onValueChange={(name) => {
              const next = grouping([time.dimension, ...(name ? [name] : [])])
              change(next)
            }}
          />
        </Field>
      )}
      {["bar", "donut", "table"].includes(value.type) &&
        selectedGroups.some((name) => dashboardDimensionIcon(name)) && (
          <label className="flex items-center justify-between gap-3 text-xs font-medium">
            Show group icons
            <Switch
              checked={value.showGroupIcons ?? false}
              onCheckedChange={(checked) =>
                change({ ...value, showGroupIcons: checked })
              }
            />
          </label>
        )}
      {time?.granularity && timeMember?.kind === "timeDimension" && (
        <Field label="Time interval">
          <Combobox
            label="Time interval"
            icon={<Clock3 />}
            options={timeMember.granularities.map((item) => ({
              value: item,
              label: item,
            }))}
            value={time.granularity}
            onValueChange={(selected) => {
              const granularity = timeMember.granularities.find(
                (item) => item === selected
              )
              if (granularity) {
                change({
                  ...value,
                  query: {
                    ...value.query,
                    offset: 0,
                    timeDimensions: [{ ...time, granularity }],
                  },
                })
              }
            }}
          />
        </Field>
      )}
      {["table", "bar", "donut"].includes(value.type) && (
        <>
          <Field label="Sort by">
            <Combobox
              label="Sort by"
              value={value.query.order[0]?.[0] ?? ""}
              options={[
                { value: "", label: "Default order" },
                ...[...value.query.measures, ...value.query.dimensions].map(
                  (name) => ({
                    value: name,
                    label:
                      model.members.find((m) => m.name === name)?.title ?? name,
                  })
                ),
              ]}
              onValueChange={(name) =>
                change({
                  ...value,
                  query: {
                    ...value.query,
                    offset: 0,
                    order: name ? [[name, "desc"]] : [],
                  },
                })
              }
            />
          </Field>
          {value.query.order.length > 0 && (
            <Field label="Sort direction">
              <Combobox
                label="Sort direction"
                value={value.query.order[0][1]}
                options={[
                  { value: "desc", label: "Highest first" },
                  { value: "asc", label: "Lowest first" },
                ]}
                onValueChange={(direction) =>
                  change({
                    ...value,
                    query: {
                      ...value.query,
                      offset: 0,
                      order: [
                        [
                          value.query.order[0][0],
                          direction === "asc" ? "asc" : "desc",
                        ],
                        ...value.query.order.slice(1),
                      ],
                    },
                  })
                }
              />
            </Field>
          )}
        </>
      )}
      <DashboardWidgetFilters
        key={model.name}
        widget={value}
        onChange={change}
      />
    </div>
  )
}
