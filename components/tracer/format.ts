import type { JsonValue } from "@/src/lib/tracer/contracts"
import { parseSelector, resolveJsonSelector } from "@/src/lib/tracer/selectors"

export type SelectorResult =
  | { kind: "empty"; value: null }
  | { kind: "invalid"; message: string; value: null }
  | { kind: "missing"; segment: string; value: null }
  | { kind: "value"; value: unknown }

export function formatDate(
  value: string | null | undefined,
  options?: Intl.DateTimeFormatOptions
) {
  if (!value) return "—"

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    year: "numeric",
    ...options,
  }).format(date)
}

export function formatRelative(value: string | null | undefined) {
  if (!value) return "—"

  const timestamp = new Date(value).getTime()
  if (Number.isNaN(timestamp)) return value
  const seconds = Math.round((timestamp - Date.now()) / 1000)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second")
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour")
  return formatter.format(Math.round(hours / 24), "day")
}

export function formatDuration(value: number | null | undefined) {
  if (value === null || value === undefined) return "Running"
  if (value < 1000) return `${value}ms`
  if (value < 60_000)
    return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)}s`
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`
}

export function formatScore(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—"
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
  }).format(value)
}

export function stringifyJson(value: unknown, spacing = 2) {
  try {
    const serialised = JSON.stringify(value, null, spacing)
    return serialised === undefined ? "undefined" : serialised
  } catch {
    return "[unserializable value]"
  }
}

export function previewValue(value: unknown, maxLength = 92) {
  if (value === null || value === undefined) return "—"

  const raw =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : stringifyJson(value, 0)

  return raw.length > maxLength
    ? `${raw.slice(0, Math.max(0, maxLength - 1))}…`
    : raw
}

/** Resolves dot-only paths without evaluating code or allowing prototype traversal. */
export function selectJson(value: unknown, selector: string): SelectorResult {
  const trimmed = selector.trim()
  if (!trimmed) return { kind: "empty", value: null }

  const segments = parseSelector(trimmed)
  if (!segments) {
    return {
      kind: "invalid",
      message: "Use dot-separated object keys and numeric array indexes only.",
      value: null,
    }
  }

  for (let index = 0; index < segments.length; index += 1) {
    const selected = resolveJsonSelector(
      value as JsonValue,
      segments.slice(0, index + 1).join(".")
    )
    if (selected === undefined) {
      return { kind: "missing", segment: segments[index], value: null }
    }
  }

  return {
    kind: "value",
    value: resolveJsonSelector(value as JsonValue, trimmed),
  }
}

export function jsonOrNull(value: string): JsonValue | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  return JSON.parse(trimmed) as JsonValue
}

export function statusLabel(value: string) {
  return value.replaceAll("-", " ")
}
