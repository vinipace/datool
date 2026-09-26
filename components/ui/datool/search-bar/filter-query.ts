import type {
  SearchFieldSpec,
  SearchSelectorRange,
  SearchSuggestion,
} from "./search-core"

export type FilterOperator = "=" | "!=" | "<" | "<=" | ">" | ">=" | ":"
export type FilterComparisonClause = {
  path: string[]
  operator: FilterOperator
  value: string | number | boolean | null
  start: number
  end: number
}
export type FilterClause =
  | FilterComparisonClause
  | {
      text: string
      start: number
      end: number
    }

export class FilterSyntaxError extends Error {}

const forbidden = new Set(["__proto__", "prototype", "constructor"])
const identifier = /[a-zA-Z0-9_$-]/
const comparisonOperator = /^(contains(?=\s|$)|<=|>=|!=|=|<|>|:)/
const comparisonContinuation = /^(\.|contains(?=\s|$)|<=|>=|!=|=|<|>|:)/

/** Public spelling; the AST retains : for existing predicate consumers. */
export function formatFilterOperator(operator: FilterOperator) {
  return operator === ":" ? "contains" : operator
}

/** Data-only comparisons and quoted text; adjacent clauses are ANDed. */
export function parseFilterQuery(query: string): FilterClause[] {
  if (query.length > 4000)
    throw new FilterSyntaxError("Filter must be at most 4,000 characters.")
  const clauses: FilterClause[] = []
  let pos = 0
  const fail = (message: string): never => {
    throw new FilterSyntaxError(`${message} at character ${pos + 1}.`)
  }
  const space = () => {
    while (/\s/.test(query[pos] ?? "") && pos < query.length) pos++
  }
  const quoted = () => {
    const quote = query[pos++]
    let result = ""
    while (pos < query.length) {
      const char = query[pos++]
      if (char === quote) return result
      if (char === "\\") {
        if (pos >= query.length) fail("Incomplete escape")
        const escaped = query[pos++]
        if (escaped !== quote && escaped !== "\\")
          fail("Only quotes and backslashes can be escaped")
        result += escaped
      } else result += char
    }
    return fail("Unclosed quote")
  }
  space()
  while (pos < query.length) {
    if (clauses.length >= 50) fail("Use at most 50 clauses")
    const start = pos
    if (query[pos] === '"' || query[pos] === "'") {
      const text = quoted()
      const end = pos
      space()
      // A quoted field followed by a path or operator remains a comparison.
      if (!comparisonContinuation.test(query.slice(pos))) {
        if (!text.trim()) fail("Search text must not be empty")
        if (pos === end && pos < query.length)
          fail("Separate clauses with a space")
        clauses.push({ text, start, end })
        continue
      }
      pos = start
    }
    const path: string[] = []
    do {
      if (path.length) pos++
      let segment = ""
      if (query[pos] === '"' || query[pos] === "'") segment = quoted()
      else
        while (pos < query.length && identifier.test(query[pos]))
          segment += query[pos++]
      if (!segment || forbidden.has(segment)) fail("Invalid field path")
      path.push(segment)
      if (path.length > 20) fail("Field path is too deep")
    } while (query[pos] === ".")
    space()
    const operatorToken = query.slice(pos).match(comparisonOperator)?.[0]
    if (!operatorToken) fail("Expected =, !=, <, <=, >, >= or contains")
    const operator = (
      operatorToken === "contains" ? ":" : operatorToken
    ) as FilterOperator
    pos += operatorToken!.length
    space()
    let value: FilterComparisonClause["value"]
    if (query[pos] === '"' || query[pos] === "'") value = quoted()
    else {
      const raw = query.slice(pos).match(/^[^\s]+/)?.[0]
      if (!raw) fail("Expected a value")
      pos += raw!.length
      if (raw === "null") value = null
      else if (raw === "true" || raw === "false") value = raw === "true"
      else if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw!)) {
        value = Number(raw)
        if (!Number.isFinite(value)) fail("Expected a finite number")
      } else if (/^[a-zA-Z0-9_./@+-]+$/.test(raw!)) value = raw!
      else fail("Quote string values")
    }
    clauses.push({ path, operator: operator!, value: value!, start, end: pos })
    if (pos < query.length && !/\s/.test(query[pos]))
      fail("Separate comparisons with a space")
    space()
  }
  return clauses
}

/** Relative dates are rolling durations, resolved once per backend query. */
export function filterDate(value: string, now: number) {
  const relative = value.match(/^-([1-9]\d*)(m|h|d|w)$/)
  if (relative) {
    const units: Record<string, number> = {
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
    }
    const timestamp = now - Number(relative[1]) * units[relative[2]]
    return Math.abs(timestamp) <= 8.64e15 ? timestamp : NaN
  }
  // Avoid Date.parse interpreting malformed relative dates as calendar dates.
  if (value.startsWith("-")) return NaN
  return Date.parse(value)
}

export function validateFilterFields(
  clauses: FilterClause[],
  fields: SearchFieldSpec[]
) {
  for (const clause of clauses) {
    if ("text" in clause) continue
    const field = fields.find((field) => field.id === clause.path[0])
    if (!field || (clause.path.length > 1 && field.kind !== "json")) {
      throw new FilterSyntaxError(
        `Unknown field '${clause.path.join(".")}'. Available fields: ${fields.map((field) => field.id).join(", ")}.`
      )
    }
    if (
      field.kind === "number" &&
      typeof clause.value !== "number" &&
      clause.value !== null
    ) {
      throw new FilterSyntaxError(`${field.id} requires a number or null.`)
    }
    if (
      field.kind === "enum" &&
      clause.operator !== ":" &&
      clause.value !== null &&
      !field.options?.includes(String(clause.value))
    ) {
      throw new FilterSyntaxError(
        `${field.id} must be one of: ${field.options?.join(", ")}.`
      )
    }
    if (
      ["<", "<=", ">", ">="].includes(clause.operator) &&
      field.kind !== "number" &&
      field.kind !== "date" &&
      field.kind !== "json"
    ) {
      throw new FilterSyntaxError(`${field.id} supports =, != and contains.`)
    }
    if (
      ["<", "<=", ">", ">="].includes(clause.operator) &&
      clause.value === null
    ) {
      throw new FilterSyntaxError("null supports only =, != and contains.")
    }
    if (
      field.kind === "date" &&
      clause.value !== null &&
      (typeof clause.value !== "string" ||
        !Number.isFinite(filterDate(clause.value, Date.now())))
    ) {
      throw new FilterSyntaxError(
        `${field.id} requires a quoted ISO date or relative time such as -1h, -3d or -7d.`
      )
    }
  }
}

export function resolveFilterPath(record: unknown, path: string[]): unknown {
  let value = record
  for (const segment of path) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, segment) ||
      forbidden.has(segment)
    )
      return undefined
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}

/** Only registered text, enum and JSON fields participate in full-text search. */
export function fullTextFields(fields: SearchFieldSpec[]) {
  return fields.filter((field) => ["text", "enum", "json"].includes(field.kind))
}

function containsText(value: unknown, text: string): boolean {
  if (typeof value === "string") return value.toLowerCase().includes(text)
  if (value === null || typeof value !== "object") return false
  return Object.values(value).some((child) => containsText(child, text))
}

export function matchesFilter(
  record: unknown,
  clauses: FilterClause[],
  fields: SearchFieldSpec[],
  now = Date.now()
) {
  return clauses.every((clause) => {
    if ("text" in clause) {
      const text = clause.text.toLowerCase()
      return fullTextFields(fields).some((field) =>
        containsText(resolveFilterPath(record, [field.id]), text)
      )
    }
    let actual = resolveFilterPath(record, clause.path)
    let expected: unknown = clause.value
    // Missing fields never match, including != null.
    if (actual === undefined) return false
    if (
      fields.find((field) => field.id === clause.path[0])?.kind === "date" &&
      actual !== null &&
      expected !== null
    ) {
      actual = Date.parse(String(actual))
      expected = filterDate(String(expected), now)
    }
    switch (clause.operator) {
      case "=":
        return actual === expected
      case "!=":
        return actual !== expected
      case ":":
        return typeof actual === "string" && typeof expected === "string"
          ? actual.toLowerCase().includes(expected.toLowerCase())
          : actual === expected
      default: {
        if (typeof actual !== "number" || typeof expected !== "number")
          return false
        if (clause.operator === "<") return actual < expected
        if (clause.operator === "<=") return actual <= expected
        if (clause.operator === ">") return actual > expected
        return actual >= expected
      }
    }
  })
}

// Tolerant, cursor-aware context for incomplete expressions in the editor.
function activeClause(value: string, cursor: number) {
  let start = 0
  // Complete clauses followed by whitespace can safely be skipped.
  for (let index = 0; index < cursor; index++) {
    if (!/\s/.test(value[index])) continue
    try {
      const clauses = parseFilterQuery(value.slice(start, index))
      if (
        clauses.length === 1 &&
        !(
          "text" in clauses[0] &&
          comparisonContinuation.test(value.slice(index).trimStart())
        )
      )
        start = index + 1
    } catch {
      /* Keep the incomplete clause. */
    }
  }
  while (start < cursor && /\s/.test(value[start])) start++
  let end = cursor
  let quote = ""
  let escaped = false
  for (let index = start; index < value.length; index++) {
    end = index + 1
    const char = value[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = ""
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (index >= cursor && /\s/.test(char)) {
      try {
        if (parseFilterQuery(value.slice(start, index)).length === 1) {
          end = index
          break
        }
      } catch {
        /* Still typing. */
      }
    }
    end = index + 1
  }
  return { start, end, fragment: value.slice(start, cursor) }
}

export function getFilterSuggestions(
  value: string,
  cursor: number,
  fields: SearchFieldSpec[]
): SearchSuggestion[] {
  const { fragment } = activeClause(value, cursor)
  const match = fragment.match(
    /^([\w.-]+)\s*(contains(?=\s|$)|>=|<=|!=|=|>|<|:)\s*(.*)$/
  )
  const operator = match?.[2] === ":" ? "contains" : match?.[2]
  const field = fields.find((field) => field.id === match?.[1])
  if (field?.kind === "date" && match) {
    return [
      { value: "-1h", label: "Past hour" },
      { value: "-24h", label: "Past 24 hours" },
      { value: "-3d", label: "Past 3 days" },
      { value: "-7d", label: "Past 7 days" },
    ]
      .filter((option) => option.value.includes(match[3].replace(/['"]/g, "")))
      .map((option) => ({
        id: `${field.id}-${option.value}`,
        group: "values",
        label: `${option.label} (${option.value})`,
        insertText: `${field.id} ${operator} ${option.value} `,
        mode: "replace-token",
      }))
  }
  if (field?.options && match) {
    return field.options
      .filter((option) =>
        option
          .toLowerCase()
          .includes(match[3].replace(/['"]/g, "").toLowerCase())
      )
      .map((option) => ({
        id: `${field.id}-${option}`,
        group: "values",
        label: option,
        insertText: `${field.id} ${operator} ${JSON.stringify(option)} `,
        mode: "replace-token",
      }))
  }
  return fields
    .filter((field) => {
      const query = fragment.trim().toLowerCase()
      return [field.id, field.label].some((name) =>
        name?.toLowerCase().startsWith(query)
      )
    })
    .flatMap((field) => {
      const operators =
        field.kind === "json"
          ? ["."]
          : field.kind === "date"
            ? [" >= ", " < ", " = "]
            : field.kind === "number"
              ? [" = ", " < ", " > "]
              : [" = ", " contains "]
      return operators.map((operator): SearchSuggestion => ({
        id: `${field.id}${operator}`,
        group: "filters",
        label: `${field.label ?? field.id}${operator}`,
        insertText: `${field.id}${operator}`,
        keepOpen: true,
        mode: "replace-token",
      }))
    })
}

export function applyFilterSuggestion(
  value: string,
  cursor: number,
  _fields: SearchFieldSpec[],
  suggestion: SearchSuggestion
) {
  const { start, end } = activeClause(value, cursor)
  return {
    value: value.slice(0, start) + suggestion.insertText + value.slice(end),
    selectionStart: start + suggestion.insertText.length,
    keepOpen: Boolean(suggestion.keepOpen),
  }
}

export function getFilterHighlightRanges(
  value: string,
  fields: SearchFieldSpec[]
): SearchSelectorRange[] {
  // Retain highlighting for complete clauses while the final clause is incomplete.
  let clauses: FilterClause[] = []
  for (let end = value.length; end > 0; end--) {
    if (end !== value.length && !/\s/.test(value[end])) continue
    try {
      clauses = parseFilterQuery(value.slice(0, end))
      break
    } catch {
      /* Try the preceding boundary. */
    }
  }
  return clauses
    .filter((clause) => {
      try {
        validateFilterFields([clause], fields)
        return true
      } catch {
        return false
      }
    })
    .map((clause) => ({
      start: clause.start,
      end: clause.end,
      fieldId: "text" in clause ? "$text" : clause.path[0],
      operator: "text" in clause ? ":" : clause.operator,
      token: value.slice(clause.start, clause.end),
    }))
}

/** Presentation only: never feeds formatted labels back into the filter value. */
export function formatFilterQuery(value: string, fields: SearchFieldSpec[]) {
  try {
    const clauses = parseFilterQuery(value)
    validateFilterFields(clauses, fields)
    if (!clauses.length) return null

    return clauses.map((clause) => {
      if ("text" in clause) {
        return {
          raw: value.slice(clause.start, clause.end),
          label: JSON.stringify(clause.text),
        }
      }
      const field = fields.find((field) => field.id === clause.path[0])!
      const raw = value.slice(clause.start, clause.end)
      const fieldLabel = field.label ?? field.id
        .replace(
          /([a-z0-9])([A-Z])/g,
          (_, before: string, after: string) =>
            `${before} ${after.toLowerCase()}`
        )
        .replace(/[_-]/g, " ")
        .replace(/^./, (letter) => letter.toUpperCase())
      // Keep nested paths exact, including quoted keys containing literal dots.
      const label =
        clause.path.length === 1
          ? fieldLabel
          : clause.path
              .map((segment) =>
                /^[\w$-]+$/.test(segment) ? segment : JSON.stringify(segment)
              )
              .join(".")
      const relative =
        field.kind === "date" && typeof clause.value === "string"
          ? clause.value.match(/^-([1-9]\d*)(m|h|d|w)$/)
          : null
      if (relative && clause.operator === ">=") {
        const units: Record<string, string> = {
          m: "minute",
          h: "hour",
          d: "day",
          w: "week",
        }
        const duration = `${relative[1]} ${units[relative[2]]}${relative[1] === "1" ? "" : "s"}`
        const prefix = field.id === "startedAt" ? "" : `${fieldLabel}: `
        return { raw, label: `${prefix}Past ${duration}` }
      }
      const operatorLabels: Record<FilterOperator, string> = {
        "=": ":",
        "!=": "≠",
        "<": "<",
        "<=": "≤",
        ">": ">",
        ">=": "≥",
        ":": "contains",
      }
      const displayValue =
        field.kind === "enum" && typeof clause.value === "string"
          ? clause.value.replace(/^./, (letter) => letter.toUpperCase())
          : typeof clause.value === "string"
            ? JSON.stringify(clause.value)
            : String(clause.value)
      const operator =
        clause.operator === ":" &&
        (typeof clause.value !== "string" || field.kind === "date")
          ? ":"
          : operatorLabels[clause.operator]
      return {
        raw,
        label: `${label}${operator === ":" ? ": " : ` ${operator} `}${displayValue}`,
      }
    })
  } catch {
    // Invalid or incomplete input must stay visible and editable as written.
    return null
  }
}
