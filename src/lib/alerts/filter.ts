import { z } from "zod"

/** A deliberately bounded SQL-style predicate grammar, never executable SQL. */
type Comparison = {
  field: string
  operator: string
  value: string | number | boolean | null
  relativeSeconds?: number
}
export type AlertFilter =
  Comparison | { join: "AND" | "OR"; left: AlertFilter; right: AlertFilter }
const fields = new Set([
  "id",
  "trace_id",
  "resource",
  "name",
  "status",
  "kind",
  "duration_ms",
  "cost_usd",
  "created",
])
const numericFields = new Set(["duration_ms", "cost_usd"])

export function parseAlertFilter(source: string): AlertFilter | null {
  if (source.length > 2000)
    throw new Error("Filter must be at most 2,000 characters.")
  if (source.includes("\0"))
    throw new Error("Filter cannot contain a null character.")
  if (!source.trim()) return null
  const tokens: string[] = []
  const lexer =
    /\s*(>=|<=|!=|<>|=|>|<|\(|\)|-|\d+(?:\.\d+)?|[A-Za-z_][A-Za-z_0-9.]*|'(?:[^']|'')*'|"(?:[^"]|"")*")/y
  // Identifiers cannot contain whitespace; keeping the lexer separate prevents
  // SQL comments, semicolons, casts, functions and subqueries from reaching pg.
  let offset = 0
  while (offset < source.length) {
    if (!source.slice(offset).trim()) break
    lexer.lastIndex = offset
    const match = lexer.exec(source)
    if (!match)
      throw new Error(
        `Unsupported filter syntax near '${source.slice(offset, offset + 24)}'.`
      )
    tokens.push(match[1])
    offset = lexer.lastIndex
    if (tokens.length > 180) throw new Error("Filter is too complex.")
  }
  let cursor = 0
  const peek = () => tokens[cursor]?.toUpperCase()
  const take = () => tokens[cursor++]
  const expect = (value: string) => {
    if (peek() !== value) throw new Error(`Expected ${value} in filter.`)
    take()
  }
  const literal = (
    raw: string | undefined
  ): string | number | boolean | null => {
    if (!raw) throw new Error("A comparison value is required.")
    if (/^['"]/.test(raw))
      return raw.slice(1, -1).replaceAll(raw[0] + raw[0], raw[0])
    if (/^\d+(\.\d+)?$/.test(raw)) {
      const number = Number(raw)
      if (Number.isFinite(number)) return number
    }
    if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === "true"
    if (/^null$/i.test(raw)) return null
    throw new Error(
      "Quote text values and use finite numbers for numeric comparisons."
    )
  }
  const primary = (depth: number): AlertFilter => {
    if (depth > 12) throw new Error("Filter nesting is too deep.")
    if (peek() === "(") {
      take()
      const result = expression(depth + 1)
      expect(")")
      return result
    }
    const field = take()
    if (
      !field ||
      (!fields.has(field) &&
        !/^span_attributes\.[A-Za-z_][A-Za-z_0-9.]*$/.test(field))
    )
      throw new Error(
        "Use name, status, kind, resource, duration_ms, cost_usd, created, id, trace_id or span_attributes.<key>."
      )
    let operator = take()?.toUpperCase()
    if (operator === "IS") {
      const not = peek() === "NOT"
      if (not) take()
      expect("NULL")
      return { field, operator: not ? "IS NOT NULL" : "IS NULL", value: null }
    }
    if (
      !operator ||
      !["=", "!=", "<>", ">", ">=", "<", "<=", "LIKE"].includes(operator)
    )
      throw new Error("Use =, !=, >, >=, <, <=, LIKE or IS NULL.")
    if (operator === "<>") operator = "!="
    if (
      operator === "LIKE" &&
      (field === "created" || numericFields.has(field))
    )
      throw new Error("LIKE requires a text field.")
    if (field === "created" && peek() === "NOW") {
      take()
      expect("(")
      expect(")")
      expect("-")
      expect("INTERVAL")
      const amount = literal(take())
      let interval: string
      if (typeof amount === "number") interval = `${amount} ${take()}`
      else interval = String(amount)
      const match = /^(\d+) (second|minute|hour|day)s?$/i.exec(interval)
      if (!match || Number(match[1]) > 365)
        throw new Error(
          "Use now() - interval '1 day' (seconds, minutes, hours or days)."
        )
      const scale = { second: 1, minute: 60, hour: 3600, day: 86400 }[
        match[2].toLowerCase()
      ]!
      return {
        field,
        operator,
        value: null,
        relativeSeconds: Number(match[1]) * scale,
      }
    }
    const negative = peek() === "-"
    if (negative) take()
    let value = literal(take())
    if (negative) {
      if (typeof value !== "number")
        throw new Error("Expected a number after '-'.")
      value = -value
    }
    if (numericFields.has(field) && value !== null && typeof value !== "number")
      throw new Error(`${field} requires a number.`)
    if (
      field === "created" &&
      (typeof value !== "string" ||
        value.startsWith("0000") ||
        !(
          z.iso.date().safeParse(value).success ||
          z.iso.datetime({ offset: true }).safeParse(value).success
        ) ||
        !Number.isFinite(Date.parse(value)))
    )
      throw new Error(
        "created requires an ISO date or now() - interval '1 day'."
      )
    if (operator === "LIKE" && typeof value !== "string")
      throw new Error("LIKE requires a quoted string.")
    if (
      operator === "LIKE" &&
      typeof value === "string" &&
      (value.match(/\\+$/)?.[0].length ?? 0) % 2
    )
      throw new Error("LIKE cannot end with an unpaired escape character.")
    if (field === "created" && typeof value === "string")
      value = new Date(value).toISOString()
    return { field, operator, value }
  }
  const conjunction = (depth: number): AlertFilter => {
    let left = primary(depth)
    while (peek() === "AND") {
      take()
      left = { join: "AND", left, right: primary(depth) }
    }
    return left
  }
  const expression = (depth: number): AlertFilter => {
    let left = conjunction(depth)
    while (peek() === "OR") {
      take()
      left = { join: "OR", left, right: conjunction(depth) }
    }
    return left
  }
  const result = expression(0)
  if (cursor !== tokens.length)
    throw new Error(
      "Join comparisons with AND / OR; SQL statements are not supported."
    )
  return result
}

/** Only parser-owned operators enter SQL; every field/path/value is bound. */
export function compileAlertFilter(source: string, parameters: unknown[]) {
  const bind = (value: unknown) => {
    parameters.push(value)
    return `$${parameters.length}`
  }
  const visit = (node: AlertFilter): string => {
    if ("join" in node)
      return `(${visit(node.left)} ${node.join} ${visit(node.right)})`
    const key = bind(
      node.field.startsWith("span_attributes.")
        ? node.field.slice(16)
        : node.field
    )
    // Attribute keys in Datool are flat (e.g. gen_ai.request.model).
    const doc = node.field.startsWith("span_attributes.")
      ? `(payload->'span_attributes'->${key}::text)`
      : `(payload->${key}::text)`
    const scalar = `(${doc} #>> '{}')`
    if (node.operator.startsWith("IS")) return `${scalar} ${node.operator}`
    let actual = scalar
    let expected: string
    if (node.field === "created") {
      actual = `(CASE WHEN pg_input_is_valid(${scalar}, 'timestamptz') THEN ${scalar}::timestamptz END)`
      expected =
        node.relativeSeconds !== undefined
          ? `(now() - ${bind(node.relativeSeconds)}::int * interval '1 second')`
          : `${bind(node.value)}::timestamptz`
    } else if (typeof node.value === "number") {
      actual = `(CASE WHEN jsonb_typeof(${doc}) = 'number' THEN ${scalar}::numeric END)`
      expected = `${bind(node.value)}::numeric`
    } else if (typeof node.value === "boolean") {
      actual = `(CASE WHEN jsonb_typeof(${doc}) = 'boolean' THEN ${scalar}::boolean END)`
      expected = `${bind(node.value)}::boolean`
    } else {
      expected = `${bind(node.value)}::text`
    }
    return `(${actual} ${node.operator} ${expected})`
  }
  const parsed = parseAlertFilter(source)
  return parsed ? visit(parsed) : "true"
}
