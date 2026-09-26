import * as React from "react"
import { LoaderCircle, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DataTableSearchInput,
  type DataTableSearchInputProps,
  type DataTableSearchInputHandle,
} from "./search-input"
import { formatFilterQuery, parseFilterQuery } from "./filter-query"
import { SearchBarSurface } from "./search-bar-surface"
import { FilterToken } from "./filter-token"
import { preserveFixedFilters, singleTextSearch } from "./filter-draft"

/** Only explicit submissions reach the controlled query; typing stays local. */
export function TokenFilterInput<Row extends Record<string, unknown>>({
  fields,
  fixedFilters,
  value,
  onSearchChange,
  inputRef,
  isLoading,
  placeholder,
}: DataTableSearchInputProps<Row>) {
  const valid = (query: string) =>
    !!formatFilterQuery(query, fields) || !query.trim()
  const [draftState, setDraftState] = React.useState(() => ({
    source: value,
    text: valid(value) ? "" : value,
  }))
  const editorRef = React.useRef<DataTableSearchInputHandle>(null)
  const barRef = React.useRef<HTMLDivElement>(null)
  const prefix = preserveFixedFilters(
    valid(value) ? singleTextSearch(value) : "",
    "",
    fixedFilters
  )
  React.useEffect(() => {
    // Existing saved queries also use the single text-search control.
    if (prefix !== value && (!value.trim() || formatFilterQuery(value, fields)))
      onSearchChange(prefix)
  }, [prefix, value, fields, onSearchChange])
  // A saved view replaces any draft tied to the previous query.
  const draft = draftState.source === value ? draftState.text : ""
  const summary = formatFilterQuery(prefix, fields) ?? []
  const clauses = summary.length ? parseFilterQuery(prefix) : []
  const tokens = summary.flatMap((item, index) => {
    const clause = clauses[index]
    const previous = clauses[index - 1]
    const next = clauses[index + 1]
    const fixed =
      "path" in clause &&
      !!fixedFilters?.some((filter) => filter.field === clause.path[0])
    const isDate =
      "path" in clause &&
      fields.some(
        (field) => field.id === clause.path[0] && field.kind === "date"
      )
    if (
      isDate &&
      "path" in clause &&
      clause.operator === "<=" &&
      previous &&
      "path" in previous &&
      previous.operator === ">=" &&
      previous.path[0] === clause.path[0]
    )
      return []
    const rangeEnd =
      isDate &&
      "path" in clause &&
      clause.operator === ">=" &&
      next &&
      "path" in next &&
      next.operator === "<=" &&
      next.path[0] === clause.path[0]
        ? next
        : undefined
    return [
      {
        ...item,
        index,
        clause,
        fixed,
        rangeEnd,
        indices: rangeEnd ? [index, index + 1] : [index],
        raw: rangeEnd ? `${item.raw} ${summary[index + 1].raw}` : item.raw,
        label: rangeEnd
          ? `${"path" in clause && clause.path[0] !== "startedAt" ? `${clause.path[0]}: ` : ""}Custom range`
          : item.label,
      },
    ]
  })
  const write = (next: string, remainingDraft = draft) => {
    if (!valid(next)) return
    const committed = preserveFixedFilters(
      singleTextSearch(next),
      prefix,
      fixedFilters
    )
    setDraftState({ source: committed, text: remainingDraft })
    onSearchChange(committed)
  }
  const submit = (expression: string) => {
    const next = [prefix, expression].filter(Boolean).join(" ")
    if (!valid(next)) return
    write(next, "")
  }
  React.useImperativeHandle(inputRef, () => ({
    focus: () => editorRef.current?.focus(),
    selectAll: () => editorRef.current?.selectAll(),
  }))
  return (
    <SearchBarSurface
      surfaceRef={barRef}
      onFocusInput={() => editorRef.current?.focus()}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {tokens.map(({ indices, index, fixed, ...item }) => (
          <FilterToken
            key={index}
            fields={fields}
            {...item}
            onUpdate={(replacement) => {
              const nextPrefix = summary
                .flatMap((entry, i) =>
                  i === index
                    ? [replacement]
                    : indices.includes(i)
                      ? []
                      : [entry.raw]
                )
                .join(" ")
              write(nextPrefix)
            }}
            onRemove={
              fixed
                ? undefined
                : () => {
                    const nextPrefix = summary
                      .filter((_, i) => !indices.includes(i))
                      .map((entry) => entry.raw)
                      .join(" ")
                    write(nextPrefix)
                    requestAnimationFrame(() => editorRef.current?.focus())
                  }
            }
          />
        ))}
        <DataTableSearchInput
          embedded
          syntax="filter"
          fields={fields}
          inputRef={editorRef}
          suggestionAnchorRef={barRef}
          placeholder={
            summary.length
              ? "Add filter…"
              : (placeholder ?? "Start typing to search…")
          }
          value={draft}
          onSubmit={submit}
          onSearchChange={(text) => setDraftState({ source: value, text })}
        />
      </div>
      <div className="flex h-7 shrink-0 items-center">
        {isLoading ? (
          <LoaderCircle
            role="status"
            aria-label="Updating results"
            className="mx-1 size-3.5 animate-spin text-foreground-muted"
          />
        ) : null}
        {tokens.some((token) => !token.fixed) || draft ? (
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-sm"
            className="size-7"
            aria-label="Clear search"
            title="Clear search"
            onClick={() => {
              write("", "")
              requestAnimationFrame(() => editorRef.current?.focus())
            }}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </SearchBarSurface>
  )
}
