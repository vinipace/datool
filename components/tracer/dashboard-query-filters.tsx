"use client"

import { useContext, useState, type ReactNode } from "react"
import { Braces, Filter, Hash, Plus, Type, X } from "lucide-react"
import { Combobox, type ComboboxOption } from "@/components/ui/combobox"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  semanticFilterSchema,
  semanticMeasureFilterSchema,
  type SemanticFilter,
  type SemanticFilterCondition,
  type SemanticFilterOperator,
} from "@/src/lib/semantic/query"
import type {
  SemanticDimensionDefinition,
  SemanticMeasureDefinition,
} from "@/src/lib/semantic/model"
import type { DashboardWidget } from "@/src/lib/tracer/dashboards"
import { DashboardCatalogContext } from "./dashboard-catalog-context"

type FilterKind = "metric" | "metadata" | "field"
type FilterMember = SemanticDimensionDefinition | SemanticMeasureDefinition
const isJson = (member: FilterMember | undefined) =>
  member?.kind === "dimension" && member.filterValueType === "json"
type FilterRow = {
  id: string
  kind: FilterKind
  member: string
  value: SemanticFilter | null
  scope: "filters" | "having"
}
const operators: Record<SemanticFilterOperator, string> = {
  equals: "Equals",
  notEquals: "Does not equal",
  gt: "Greater than (gt)",
  gte: "Greater than or equal (gte)",
  lt: "Less than (lt)",
  lte: "Less than or equal (lte)",
  contains: "Contains",
  notContains: "Does not contain",
  startsWith: "Starts with",
  endsWith: "Ends with",
  in: "Is one of",
  notIn: "Is not one of",
  set: "Has a value",
  notSet: "Has no value",
}
const numericOperators: SemanticFilterOperator[] = [
  "gte",
  "lte",
  "gt",
  "lt",
  "equals",
  "notEquals",
  "set",
  "notSet",
]

function availableOperators(
  member: FilterMember | undefined,
  kind: FilterKind,
  valueType: string
) {
  const numeric =
    kind === "metric" || member?.type === "number" || valueType === "number"
  const candidates = numeric
    ? numericOperators
    : isJson(member) && ["boolean", "null"].includes(valueType)
      ? (["equals", "notEquals", "set", "notSet"] as SemanticFilterOperator[])
      : (member?.kind === "dimension" ? member.filterOperators : []).filter(
          (operator) => !["gt", "gte", "lt", "lte"].includes(operator)
        )
  return candidates.filter(
    (operator) =>
      member?.kind === "measure" || member?.filterOperators.includes(operator)
  )
}

function QueryFilter({
  row,
  members,
  onChange,
  onRemove,
}: {
  row: FilterRow
  members: FilterMember[]
  onChange: (filter: SemanticFilterCondition) => void
  onRemove: () => void
}) {
  const initial = row.value && "member" in row.value ? row.value : null
  const [draft, setDraft] = useState(() => ({
    member: initial?.member ?? row.member,
    operator:
      initial?.operator ??
      ((row.kind === "metric" ? "gte" : "equals") as SemanticFilterOperator),
    path: initial?.path ?? [],
    value: initial?.values?.join(", ") ?? "",
    valueType:
      initial?.values?.[0] === null
        ? "null"
        : typeof initial?.values?.[0] === "number"
          ? "number"
          : typeof initial?.values?.[0] === "boolean"
            ? "boolean"
            : "string",
  }))
  const definition = members.find((member) => member.name === draft.member)
  const json = isJson(definition)
  const numeric =
    row.kind === "metric" ||
    definition?.type === "number" ||
    draft.valueType === "number"
  const choices =
    row.kind === "metric"
      ? members.filter(
          (member) =>
            member.type === "number" || member.name.endsWith(".metrics")
        )
      : row.kind === "metadata"
        ? members.filter(
            (member) => isJson(member) && !member.name.endsWith(".metrics")
          )
        : members.filter((member) => member.name === row.member)
  const allowed = availableOperators(definition, row.kind, draft.valueType)
  const title =
    row.kind === "metric"
      ? "Metric value"
      : row.kind === "metadata"
        ? "Metadata"
        : (definition?.title ?? "Filter")
  const [error, setError] = useState("")
  function update(patch: Partial<typeof draft>) {
    const next = { ...draft, ...patch }
    setDraft(next)
    const member = members.find((item) => item.name === next.member)
    const json = isJson(member)
    const unary = next.operator === "set" || next.operator === "notSet"
    const number =
      row.kind === "metric" ||
      member?.type === "number" ||
      next.valueType === "number"
    if (
      (json && (!next.path.length || next.path.some((segment) => !segment))) ||
      (!unary && !next.value.trim() && next.valueType !== "null")
    ) {
      setError("Complete the filter to save it.")
      return
    }
    const values = (
      next.operator === "in" || next.operator === "notIn"
        ? next.value.split(",").map((part) => part.trim())
        : [next.value]
    ).map((value) =>
      number
        ? Number(value)
        : json && next.valueType === "null"
          ? null
          : json && next.valueType === "boolean"
            ? value === "true"
            : value
    )
    const parsed = (
      member?.kind === "measure"
        ? semanticMeasureFilterSchema
        : semanticFilterSchema
    ).safeParse({
      member: next.member,
      operator: next.operator,
      ...(json ? { path: next.path } : {}),
      ...(!unary ? { values } : {}),
    })
    if (
      !parsed.success ||
      !availableOperators(member, row.kind, next.valueType).includes(
        next.operator
      ) ||
      (!unary && number && values.some((value) => !Number.isFinite(value)))
    ) {
      setError("Enter a valid filter value.")
      return
    }
    setError("")
    onChange(parsed.data as SemanticFilterCondition)
  }
  if (row.value && !("member" in row.value))
    return (
      <div className="flex items-start gap-2 rounded-md border border-border p-3">
        <p className="min-w-0 flex-1 text-xs text-foreground-muted">
          Saved filter group ({"and" in row.value ? "all" : "any"} conditions)
        </p>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Remove filter group"
          onClick={onRemove}
        >
          <X />
        </Button>
      </div>
    )
  return (
    <div
      role="group"
      aria-label={`${title} filter`}
      className="space-y-2 rounded-md border border-border p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">{title}</p>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Remove ${title} filter`}
          onClick={onRemove}
        >
          <X />
        </Button>
      </div>
      {choices.length > 1 && (
        <Combobox
          label={`${title} field`}
          icon={numeric ? <Hash /> : <Braces />}
          value={draft.member}
          options={choices.map((member) => ({
            value: member.name,
            label:
              member.kind === "measure"
                ? `${member.title} · Aggregate`
                : member.title,
          }))}
          onValueChange={(member) =>
            update({
              member,
              path: [],
              value: "",
              operator: row.kind === "metric" ? "gte" : "equals",
            })
          }
        />
      )}
      {choices.length === 1 && row.kind === "metric" && (
        <p className="text-xs text-foreground-muted">{choices[0].title}</p>
      )}
      {definition?.kind === "measure" && (
        <p className="text-xs text-foreground-muted">Applies after grouping.</p>
      )}
      {json && (
        <Input
          aria-label={row.kind === "metric" ? "Metric key" : "Metadata key"}
          icon={<Braces />}
          placeholder={row.kind === "metric" ? "Metric key" : "Metadata key"}
          value={draft.path[0] ?? ""}
          onChange={(event) => update({ path: [event.target.value] })}
        />
      )}
      {json && row.kind !== "metric" && (
        <Combobox
          label="Metadata value type"
          icon={<Type />}
          value={draft.valueType}
          options={["string", "number", "boolean", "null"].map((value) => ({
            value,
            label: value,
          }))}
          onValueChange={(valueType) =>
            update({
              valueType,
              value: valueType === "boolean" ? "true" : "",
              operator: "equals",
            })
          }
        />
      )}
      <Combobox
        label={`${title} operator`}
        icon={<Filter />}
        value={draft.operator}
        options={allowed.map((value) => ({ value, label: operators[value] }))}
        onValueChange={(operator) =>
          update({ operator: operator as SemanticFilterOperator })
        }
      />
      {!["set", "notSet"].includes(draft.operator) &&
        draft.valueType !== "null" &&
        (json && draft.valueType === "boolean" ? (
          <Combobox
            label={`${title} value`}
            value={draft.value}
            options={[
              { value: "true", label: "True" },
              { value: "false", label: "False" },
            ]}
            onValueChange={(value) => update({ value })}
          />
        ) : (
          <Input
            aria-label={`${title} value`}
            icon={numeric ? <Hash /> : <Type />}
            type={numeric ? "number" : "text"}
            step={numeric ? "any" : undefined}
            placeholder={
              draft.operator === "in" || draft.operator === "notIn"
                ? "Values separated by commas"
                : "Value"
            }
            value={draft.value}
            onChange={(event) => update({ value: event.target.value })}
          />
        ))}
      {error && (
        <p role="status" className="text-xs text-foreground-muted">
          {error}
        </p>
      )}
    </div>
  )
}

export function DashboardQueryFilters({
  widget,
  onChange,
  extraOptions,
  onExtraAdd,
  children,
}: {
  widget: DashboardWidget
  onChange: (widget: DashboardWidget) => void
  extraOptions: ComboboxOption[]
  onExtraAdd: (value: string) => void
  children: ReactNode
}) {
  const catalog = useContext(DashboardCatalogContext)
  const model = widget.query.measures[0].split(".")[0]
  const traceLatency = [
    ...widget.query.measures,
    ...(widget.query.having ?? []).map((filter) => filter.member),
  ].some((member) =>
    ["logs.p95LatencyMs", "logs.meanLatencyMs"].includes(member)
  )
  const members =
    catalog?.data?.models
      .find((item) => item.name === model)
      ?.members.filter(
        (member): member is FilterMember =>
          (member.kind === "measure" || member.kind === "dimension") &&
          member.name !== `${model}.invocationGroup` &&
          (!traceLatency ||
            !["logs.spanName", "logs.spanCostUsd", "logs.hasCost"].includes(
              member.name
            ) ||
            widget.query.filters.some(
              (filter) => "member" in filter && filter.member === member.name
            ))
      ) ?? []
  const source = JSON.stringify([
    widget.query.filters,
    widget.query.having ?? [],
  ])
  const createRows = () =>
    (["filters", "having"] as const).flatMap((scope) =>
      (widget.query[scope] ?? []).map((value): FilterRow => {
        const member = "member" in value ? value.member : ""
        const definition = members.find((item) => item.name === member)
        return {
          id: crypto.randomUUID(),
          value,
          scope,
          member,
          kind:
            definition?.type === "number" || member.endsWith(".metrics")
              ? "metric"
              : isJson(definition)
                ? "metadata"
                : "field",
        }
      })
    )
  const [draft, setDraft] = useState(() => ({ source, rows: createRows() }))
  if (draft.source !== source) setDraft({ source, rows: createRows() })
  function commit(rows: FilterRow[]) {
    const filters = rows.flatMap((row) =>
      row.scope === "filters" && row.value ? [row.value] : []
    )
    const having = rows.flatMap((row) =>
      row.scope === "having" && row.value && "member" in row.value
        ? [row.value]
        : []
    )
    setDraft({ source: JSON.stringify([filters, having]), rows })
    onChange({
      ...widget,
      query: {
        ...widget.query,
        offset: 0,
        filters,
        having: having.length ? having : undefined,
      },
    })
  }
  const metric = members
    .filter(
      (member) => member.type === "number" || member.name.endsWith(".metrics")
    )
    .sort((a, b) => Number(b.type === "number") - Number(a.type === "number"))
  const metadata =
    members.find((member) => member.name.endsWith(".metadata")) ??
    members.find(
      (member) => isJson(member) && !member.name.endsWith(".metrics")
    )
  const fields = members
    .filter(
      (member) =>
        member.kind === "dimension" &&
        member.type !== "number" &&
        !member.filterValueType &&
        !/\.group(?:Type|Name|Version)$/.test(member.name)
    )
    .filter(
      (member, index, all) =>
        all.findIndex(
          (item) => item.title.toLowerCase() === member.title.toLowerCase()
        ) === index
    )
  return (
    <section
      aria-label="Widget filters"
      className="space-y-3 border-t border-border pt-4"
    >
      <h2 className="text-xs font-medium">Filters</h2>
      {children}
      {draft.rows.map((row) => (
        <QueryFilter
          key={row.id}
          row={row}
          members={members}
          onChange={(value) =>
            commit(
              draft.rows.map((item) =>
                item.id === row.id
                  ? {
                      ...item,
                      value,
                      member: value.member,
                      scope:
                        members.find((member) => member.name === value.member)
                          ?.kind === "measure"
                          ? "having"
                          : "filters",
                    }
                  : item
              )
            )
          }
          onRemove={() =>
            commit(draft.rows.filter((item) => item.id !== row.id))
          }
        />
      ))}
      <Combobox
        label="Add filter"
        placeholder="Add filter"
        icon={<Plus />}
        value={null}
        options={[
          ...extraOptions,
          ...(metric.length
            ? [{ value: "metric", label: "Metric value", icon: Hash }]
            : []),
          ...(metadata
            ? [{ value: "metadata", label: "Metadata", icon: Braces }]
            : []),
          ...fields.map((member) => ({
            value: member.name,
            label: member.title,
            icon: Filter,
          })),
        ]}
        onValueChange={(selected) => {
          if (extraOptions.some((option) => option.value === selected))
            return onExtraAdd(selected)
          const kind =
            selected === "metric" || selected === "metadata"
              ? selected
              : "field"
          const member =
            selected === "metric"
              ? metric[0].name
              : selected === "metadata"
                ? metadata!.name
                : selected
          setDraft({
            ...draft,
            rows: [
              ...draft.rows,
              {
                id: crypto.randomUUID(),
                kind,
                member,
                value: null,
                scope:
                  members.find((item) => item.name === member)?.kind ===
                  "measure"
                    ? "having"
                    : "filters",
              },
            ],
          })
        }}
      />
    </section>
  )
}
