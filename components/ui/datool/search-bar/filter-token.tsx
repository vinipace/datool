import * as React from "react"
import {
  Braces,
  CalendarDays,
  Check,
  ChevronDown,
  Hash,
  Search,
  Tag,
  TextCursorInput,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import {
  filterDate,
  formatFilterOperator,
  parseFilterQuery,
  validateFilterFields,
  type FilterClause,
  type FilterComparisonClause,
} from "./filter-query"
import type { SearchFieldSpec } from "./search-core"
import { quoteFilterText as quote } from "./filter-draft"

const icons = {
  date: CalendarDays,
  enum: Tag,
  json: Braces,
  number: Hash,
  text: TextCursorInput,
  fulltext: Search,
}
const tones = {
  fulltext:
    "text-filter-fulltext border-filter-fulltext/70 bg-filter-fulltext/5",
  date: "text-filter-date border-filter-date/70 bg-filter-date/5",
  enum: "text-filter-enum border-filter-enum/70 bg-filter-enum/5",
  json: "text-filter-json border-filter-json/70 bg-filter-json/5",
  number: "text-filter-number border-filter-number/70 bg-filter-number/5",
  text: "text-filter-text border-filter-text/70 bg-filter-text/5",
}
const datePresets = [
  ["-1h", "Past 1 hour"],
  ["-6h", "Past 6 hours"],
  ["-12h", "Past 12 hours"],
  ["-1d", "Past 1 day"],
  ["-3d", "Past 3 days"],
  ["-7d", "Past 7 days"],
  ["-14d", "Past 14 days"],
  ["-30d", "Past 30 days"],
  ["-90d", "Past 90 days"],
] as const

const operatorLabels = {
  "=": "is",
  "!=": "is not",
  ":": "contains",
  "<": "<",
  "<=": "≤",
  ">": ">",
  ">=": "≥",
} as const

function filterPath(path: string[]) {
  return path
    .map((part) => (/^[\w$-]+$/.test(part) ? part : quote(part)))
    .join(".")
}

function fieldTitle(path: string[]) {
  if (path.length > 1) return filterPath(path)
  return path[0]
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function FilterToken({
  clause,
  rangeEnd,
  raw,
  label,
  fields,
  onUpdate,
  onRemove,
}: {
  clause: FilterClause
  rangeEnd?: FilterComparisonClause
  raw: string
  label: string
  fields: SearchFieldSpec[]
  onUpdate: (value: string) => void
  onRemove?: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const removing = React.useRef(false)
  const field =
    "path" in clause
      ? fields.find((item) => item.id === clause.path[0])
      : undefined
  const kind = "text" in clause ? "fulltext" : (field?.kind ?? "text")
  const Icon = icons[kind]
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) removing.current = false
        setOpen(next)
      }}
    >
      <span
        data-filter-kind={kind}
        className={cn(
          "inline-flex h-7 max-w-full shrink-0 items-center rounded border text-xs transition-colors focus-within:ring-2 focus-within:ring-ring",
          tones[kind]
        )}
      >
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Edit ${label}`}
            title={raw}
            className={cn(
              "h-full min-w-0 shrink gap-1 rounded-sm px-1.5 text-xs text-inherit hover:bg-current/10 hover:text-inherit has-[>svg]:px-1.5 data-[state=open]:bg-current/10",
              onRemove && "rounded-r-none"
            )}
          >
            <Icon className="size-3.5" />
            <span className="max-w-64 truncate">{label}</span>
            <ChevronDown className="size-3 opacity-70" />
          </Button>
        </PopoverTrigger>
        {onRemove ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-full w-5 rounded-sm rounded-l-none text-inherit opacity-70 hover:bg-current/10 hover:text-inherit hover:opacity-100"
            aria-label={`Remove ${label}`}
            onClick={onRemove}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </span>
      <PopoverContent
        onCloseAutoFocus={(event) => {
          // Removal already restores focus to the search field. The trigger
          // may now represent another token, so it must not reclaim focus.
          if (removing.current) event.preventDefault()
        }}
        aria-label={
          kind === "fulltext"
            ? "Edit full-text search"
            : `Edit ${field?.id ?? "filter"}`
        }
      >
        <FilterTokenEditor
          key={raw}
          clause={clause}
          rangeEnd={rangeEnd}
          raw={raw}
          fields={fields}
          onRemove={
            onRemove
              ? () => {
                  removing.current = true
                  setOpen(false)
                  onRemove()
                }
              : undefined
          }
          onUpdate={(next) => {
            onUpdate(next)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

function localDate(value: unknown) {
  if (typeof value !== "string") return ""
  const timestamp = filterDate(value, Date.now())
  if (!Number.isFinite(timestamp)) return ""
  const date = new Date(timestamp)
  return new Date(timestamp - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16)
}

function FilterTokenEditor({
  clause,
  rangeEnd,
  raw,
  fields,
  onUpdate,
  onRemove,
}: {
  clause: FilterClause
  rangeEnd?: FilterComparisonClause
  raw: string
  fields: SearchFieldSpec[]
  onUpdate: (value: string) => void
  onRemove?: () => void
}) {
  const fulltext = "text" in clause
  const field =
    "path" in clause
      ? fields.find((item) => item.id === clause.path[0])
      : undefined
  const isEnum =
    field?.kind === "enum" &&
    "value" in clause &&
    typeof clause.value === "string"
  const literalText =
    "value" in clause &&
    typeof clause.value === "string" &&
    field?.kind !== "date"
  const [draft, setDraft] = React.useState(
    fulltext ? clause.text : literalText ? String(clause.value) : raw
  )
  const [operator, setOperator] = React.useState(
    "operator" in clause ? clause.operator : "="
  )
  const [error, setError] = React.useState<string | null>(null)
  const [custom, setCustom] = React.useState(false)
  const [from, setFrom] = React.useState(
    rangeEnd && "value" in clause ? localDate(clause.value) : ""
  )
  const [to, setTo] = React.useState(rangeEnd ? localDate(rangeEnd.value) : "")
  const id = React.useId()
  const apply = (expression: string) => {
    try {
      const clauses = parseFilterQuery(expression)
      if (!clauses.length) throw new Error("Enter a filter value.")
      validateFilterFields(clauses, fields)
      onUpdate(expression)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Invalid filter.")
    }
  }
  const dateField = field?.kind === "date" ? field.id : null
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (custom && dateField) {
          const start = new Date(from)
          const end = new Date(to)
          if (
            !from ||
            !to ||
            !Number.isFinite(start.getTime()) ||
            !Number.isFinite(end.getTime()) ||
            start >= end
          ) {
            setError("Choose an end date after the start date.")
            return
          }
          apply(
            `${dateField} >= ${quote(start.toISOString())} ${dateField} <= ${quote(end.toISOString())}`
          )
        } else {
          apply(
            fulltext
              ? quote(draft)
              : literalText && "path" in clause
                ? `${filterPath(clause.path)} ${formatFilterOperator(operator)} ${quote(draft)}`
                : draft
          )
        }
      }}
    >
      <label
        htmlFor={id}
        className="col-span-2 block text-xs font-medium text-foreground-muted"
      >
        {fulltext ? (
          "Full-text search"
        ) : dateField ? (
          "Time range"
        ) : (
          <code className="syntax-code font-mono" data-language="filter">
            <span className="token property">{fieldTitle(clause.path)}</span>{" "}
            <span className="token operator">{operatorLabels[operator]}</span>
          </code>
        )}
      </label>
      {dateField && !custom ? (
        <div className="max-h-60 overflow-y-auto">
          {datePresets.map(([value, label]) => (
            <Button
              key={value}
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-between"
              onClick={() => apply(`${dateField} >= ${value}`)}
            >
              {label}
              {"value" in clause &&
              clause.value === value &&
              clause.operator === ">=" ? (
                <Check className="size-3.5 text-filter-date" />
              ) : null}
            </Button>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() => setCustom(true)}
          >
            Custom range…
          </Button>
        </div>
      ) : null}
      {custom ? (
        <div className="space-y-3">
          <label className="block space-y-1 text-xs text-foreground-muted">
            From
            <Input
              type="datetime-local"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label className="block space-y-1 text-xs text-foreground-muted">
            To
            <Input
              type="datetime-local"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <p className="text-xs text-foreground-muted">
            Dates use your local time zone.
          </p>
        </div>
      ) : isEnum ? (
        <div className="flex gap-2">
          <Select
            aria-label="Operator"
            className="w-28"
            value={operator}
            onChange={(event) =>
              setOperator(event.target.value as typeof operator)
            }
          >
            <option value="=">is</option>
            <option value="!=">is not</option>
            <option value=":">contains</option>
          </Select>
          <Select
            id={id}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          >
            {!field.options?.includes(draft) ? (
              <option value={draft}>{draft}</option>
            ) : null}
            {field.options?.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <Input
          className="focus-visible:ring-selection-control"
          id={id}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.target.select()}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          placeholder={
            fulltext
              ? "Search text"
              : literalText
                ? "Value"
                : "Field, operator and value"
          }
        />
      )}
      <div className="flex justify-end gap-1">
        {onRemove ? (
          <Button
            type="button"
            variant="ghost-muted"
            size="sm"
            className="h-7 px-2 text-xs hover:bg-transparent"
            onClick={onRemove}
          >
            Remove
          </Button>
        ) : null}
        <Button
          type="submit"
          variant="ghost-muted"
          size="sm"
          className="h-7 px-2 text-xs hover:bg-transparent"
        >
          Update
        </Button>
      </div>
      {error ? (
        <p
          id={`${id}-error`}
          role="alert"
          className="col-span-2 text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
    </form>
  )
}
