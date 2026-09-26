export type SearchFieldKind = "date" | "enum" | "json" | "number" | "text"

export type SearchField<Row> = {
  getValue: (row: Row) => unknown
  id: string
  kind: SearchFieldKind
  label?: string
  options?: string[]
  sample?: string
}

export type SearchFieldSpec = Omit<SearchField<unknown>, "getValue">

export type SearchSuggestion = {
  group: "filters" | "input" | "values"
  id: string
  insertText: string
  keepOpen?: boolean
  label: string
  mode: "append" | "replace-token" | "replace-whole"
}

export type SearchTokenOperator =
  | ":"
  | "."
  | "<"
  | ">"
  | "="
  | "!="
  | "<="
  | ">="

export type SearchSelectorRange = {
  end: number
  fieldId: string
  operator: SearchTokenOperator
  start: number
  token: string
}

type SearchTokenRange = {
  end: number
  start: number
  token: string
}

type TokenContext<Row> = {
  end: number
  field?: SearchField<Row>
  fragment: string
  operator?: SearchTokenOperator
  start: number
  token: string
}

type MatchedSearchToken<Row> = {
  field?: SearchField<Row>
  fieldId: string
  fragment: string
  operator: SearchTokenOperator
}

function withSuggestionMode(
  suggestion: SearchSuggestion,
  mode: SearchSuggestion["mode"]
): SearchSuggestion {
  return {
    ...suggestion,
    mode,
  }
}

function matchSearchToken<Row>(
  token: string,
  fields: SearchField<Row>[]
): MatchedSearchToken<Row> | null {
  const match = token.match(/^([a-zA-Z0-9_.-]+)(:|>|<|\.)(.*)$/)

  if (!match) {
    return null
  }

  const [, fieldId, operator, fragment] = match

  return {
    field: fields.find((item) => item.id === fieldId),
    fieldId,
    fragment,
    operator: operator as SearchTokenOperator,
  }
}

function isSupportedOperator<Row>(
  field: SearchField<Row>,
  operator: SearchTokenOperator
) {
  switch (field.kind) {
    case "date":
    case "number":
      return operator === ":" || operator === ">" || operator === "<"
    case "json":
      return operator === ":" || operator === "."
    default:
      return operator === ":"
  }
}

function getSearchTokenRanges(value: string) {
  const ranges: SearchTokenRange[] = []
  let tokenStart = -1
  let isQuoted = false
  let isEscaped = false

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]

    if (tokenStart === -1) {
      if (/\s/.test(character)) {
        continue
      }

      tokenStart = index
    }

    if (isEscaped) {
      isEscaped = false
      continue
    }

    if (character === "\\") {
      isEscaped = true
      continue
    }

    if (character === '"') {
      isQuoted = !isQuoted
      continue
    }

    if (!isQuoted && /\s/.test(character)) {
      ranges.push({
        end: index,
        start: tokenStart,
        token: value.slice(tokenStart, index),
      })
      tokenStart = -1
    }
  }

  if (tokenStart !== -1) {
    ranges.push({
      end: value.length,
      start: tokenStart,
      token: value.slice(tokenStart),
    })
  }

  return ranges
}

export function splitSearchQuery(value: string) {
  return getSearchTokenRanges(value).map((range) => range.token)
}

function unescapeSearchTokenValue(value: string) {
  return value.replace(/\\(["\\])/g, "$1")
}

function unquoteSearchTokenValue(value: string) {
  const trimmedValue = value.trim()

  if (
    trimmedValue.length >= 2 &&
    trimmedValue.startsWith('"') &&
    trimmedValue.endsWith('"')
  ) {
    return unescapeSearchTokenValue(trimmedValue.slice(1, -1))
  }

  return unescapeSearchTokenValue(trimmedValue)
}

export function quoteSearchTokenValue(value: string) {
  if (!value || /[\s"]/u.test(value)) {
    return `"${value.replace(/["\\]/g, "\\$&")}"`
  }

  return value
}

function buildBaseSuggestions<Row>(fields: SearchField<Row>[]) {
  return fields.flatMap<SearchSuggestion>((field) => {
    switch (field.kind) {
      case "date":
      case "number":
        return [
          {
            group: "filters",
            id: `${field.id}-eq`,
            insertText: `${field.id}:`,
            keepOpen: true,
            label: `${field.id}:`,
            mode: "append",
          },
          {
            group: "filters",
            id: `${field.id}-gt`,
            insertText: `${field.id}>`,
            keepOpen: true,
            label: `${field.id}>`,
            mode: "append",
          },
          {
            group: "filters",
            id: `${field.id}-lt`,
            insertText: `${field.id}<`,
            keepOpen: true,
            label: `${field.id}<`,
            mode: "append",
          },
        ]
      case "json":
        return [
          {
            group: "filters",
            id: `${field.id}-dot`,
            insertText: `${field.id}.`,
            keepOpen: true,
            label: `${field.id}.`,
            mode: "append",
          },
          {
            group: "filters",
            id: `${field.id}-eq`,
            insertText: `${field.id}:`,
            keepOpen: true,
            label: `${field.id}:`,
            mode: "append",
          },
        ]
      default:
        return [
          {
            group: "filters",
            id: `${field.id}-eq`,
            insertText: `${field.id}:`,
            keepOpen: true,
            label: `${field.id}:`,
            mode: "append",
          },
        ]
    }
  })
}

function getTokenContext<Row>(
  value: string,
  cursor: number,
  fields: SearchField<Row>[]
): TokenContext<Row> {
  const tokenRange = getSearchTokenRanges(value).find(
    (range) => cursor >= range.start && cursor <= range.end
  )
  const start = tokenRange?.start ?? cursor
  const end = tokenRange?.end ?? cursor
  const token = tokenRange?.token ?? ""
  const match = matchSearchToken(token, fields)

  if (!match) {
    return {
      end,
      fragment: token,
      start,
      token,
    }
  }

  return {
    end,
    field: match.field,
    fragment: match.fragment,
    operator: match.operator,
    start,
    token,
  }
}

export function getSelectorHighlightRanges<Row>(
  value: string,
  fields: SearchField<Row>[]
) {
  const ranges: SearchSelectorRange[] = []

  for (const { end, start, token } of getSearchTokenRanges(value)) {
    const parsedToken = matchSearchToken(token, fields)

    if (!parsedToken?.field) {
      continue
    }

    if (!isSupportedOperator(parsedToken.field, parsedToken.operator)) {
      continue
    }

    ranges.push({
      end,
      fieldId: parsedToken.field.id,
      operator: parsedToken.operator,
      start,
      token,
    })
  }

  return ranges
}

export function getSearchSuggestions<Row>(
  value: string,
  cursor: number,
  fields: SearchField<Row>[]
) {
  const token = getTokenContext(value, cursor, fields)
  const hasTokenFragment = token.fragment.trim().length > 0
  const inputSuggestion = value
    ? [
        {
          group: "input" as const,
          id: "input-value",
          insertText: value,
          label: value,
          mode: "replace-whole" as const,
        },
      ]
    : []

  if (!token.field || !token.operator) {
    const baseSuggestions = buildBaseSuggestions(fields)
    const filteredSuggestions = !token.fragment.trim()
      ? baseSuggestions
      : baseSuggestions.filter((suggestion) =>
          suggestion.label
            .toLowerCase()
            .includes(token.fragment.trim().toLowerCase())
        )

    if (hasTokenFragment) {
      return [
        ...inputSuggestion,
        ...filteredSuggestions.map((suggestion) =>
          withSuggestionMode(suggestion, "replace-token")
        ),
      ]
    }

    return [...inputSuggestion, ...filteredSuggestions]
  }

  if (token.field.kind === "enum" && token.operator === ":") {
    const selectedValue = unquoteSearchTokenValue(token.fragment).toLowerCase()

    if (
      selectedValue &&
      (token.field.options ?? []).some(
        (option) => option.toLowerCase() === selectedValue
      )
    ) {
      return inputSuggestion
    }

    const fieldId = token.field.id
    const valueSuggestions = (token.field.options ?? [])
      .filter((option) => option.toLowerCase().includes(selectedValue))
      .map<SearchSuggestion>((option) => ({
        group: "values",
        id: `${fieldId}-${option}`,
        insertText: `${fieldId}:${quoteSearchTokenValue(option)}`,
        label: option,
        mode: "replace-token",
      }))

    return [...inputSuggestion, ...valueSuggestions]
  }

  if (token.field.kind === "date") {
    const sample = token.field.sample ?? new Date().toISOString()
    const suggestions = [
      {
        group: "values" as const,
        id: `${token.field.id}-today`,
        insertText: `${token.field.id}${token.operator}today`,
        label: "today",
        mode: "replace-token" as const,
      },
      {
        group: "values" as const,
        id: `${token.field.id}-7d`,
        insertText: `${token.field.id}${token.operator}-7d`,
        label: "-7d",
        mode: "replace-token" as const,
      },
      {
        group: "values" as const,
        id: `${token.field.id}-sample`,
        insertText: `${token.field.id}${token.operator}${sample}`,
        label: sample,
        mode: "replace-token" as const,
      },
    ]

    if (token.operator === ":") {
      suggestions[1] = {
        group: "values",
        id: `${token.field.id}-7d`,
        insertText: `${token.field.id}:>-7d`,
        label: ">-7d",
        mode: "replace-token",
      }
      suggestions[2] = {
        group: "values",
        id: `${token.field.id}-sample`,
        insertText: `${token.field.id}:>${sample}`,
        label: `>${sample}`,
        mode: "replace-token",
      }
    }

    const filteredSuggestions = !token.fragment.trim()
      ? suggestions
      : suggestions.filter((suggestion) =>
          suggestion.label
            .toLowerCase()
            .includes(token.fragment.trim().toLowerCase())
        )

    return [...inputSuggestion, ...filteredSuggestions]
  }

  const filteredSuggestions = buildBaseSuggestions([token.field]).filter(
    (suggestion) =>
      suggestion.label.toLowerCase().includes(token.token.trim().toLowerCase())
  )

  return [...inputSuggestion, ...filteredSuggestions]
}

export function applySuggestionToValue<Row>(
  value: string,
  cursor: number,
  fields: SearchField<Row>[],
  suggestion: SearchSuggestion
) {
  const token = getTokenContext(value, cursor, fields)
  const nextValue =
    suggestion.mode === "replace-whole"
      ? suggestion.insertText
      : suggestion.mode === "append"
        ? `${value.trimEnd()}${value.trim() ? " " : ""}${suggestion.insertText}`
        : `${value.slice(0, token.start)}${suggestion.insertText}${value.slice(token.end)}`
  const nextCursor =
    suggestion.mode === "append"
      ? nextValue.length
      : suggestion.mode === "replace-whole"
        ? suggestion.insertText.length
        : token.start + suggestion.insertText.length

  return {
    keepOpen: Boolean(suggestion.keepOpen),
    selectionStart: nextCursor,
    value: nextValue,
  }
}
