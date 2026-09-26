import { formatFilterQuery, parseFilterQuery } from "./filter-query"
import type { SearchFieldSpec, SearchSuggestion } from "./search-core"

export type FixedFilter = { field: string; defaultExpression: string }

/** Keep required fields editable, restoring their current value when omitted. */
export function preserveFixedFilters(
  query: string,
  previous: string,
  fixedFilters: readonly FixedFilter[] = []
) {
  if (!fixedFilters.length) return query
  // Incomplete incoming expressions remain drafts in the search bar.
  let clauses
  let previousClauses
  try {
    clauses = parseFilterQuery(query)
    previousClauses = parseFilterQuery(previous)
  } catch {
    return query
  }
  const missing = fixedFilters.flatMap(({ field, defaultExpression }) => {
    if (clauses.some((clause) => "path" in clause && clause.path[0] === field))
      return []
    const retained = previousClauses
      .filter((clause) => "path" in clause && clause.path[0] === field)
      .map((clause) => previous.slice(clause.start, clause.end))
    return retained.length ? retained : [defaultExpression]
  })
  return [...missing, query].filter(Boolean).join(" ")
}

export function quoteFilterText(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

/** Replace the text search in place, preserving every structured comparison. */
export function singleTextSearch(query: string) {
  const clauses = parseFilterQuery(query)
  const phrases = clauses.filter((clause) => "text" in clause)
  if (phrases.length < 2) return query
  const latest = phrases[phrases.length - 1]
  return clauses
    .flatMap((clause) => {
      if (!("text" in clause)) return [query.slice(clause.start, clause.end)]
      return clause === phrases[0]
        ? [query.slice(latest.start, latest.end)]
        : []
    })
    .join(" ")
}

/** Drafts always offer literal search; valid expressions also offer structured submission. */
export function filterDraftSuggestions(
  value: string,
  fields: SearchFieldSpec[]
): SearchSuggestion[] {
  const text = value.trim()
  if (!text) return []
  const summary = formatFilterQuery(text, fields)
  const clauses = summary ? parseFilterQuery(text) : []
  const singlePhrase =
    clauses.length === 1 && "text" in clauses[0] ? clauses[0].text : null
  const suggestions: SearchSuggestion[] = []
  if (summary && singlePhrase === null) {
    suggestions.push({
      id: "submit-filter",
      group: "input",
      mode: "replace-whole",
      label: text,
      insertText: text,
    })
  }
  suggestions.push({
    id: "submit-fulltext",
    group: "input",
    mode: "replace-whole",
    label: singlePhrase ?? text,
    insertText: quoteFilterText(singlePhrase ?? text),
  })
  return suggestions
}
