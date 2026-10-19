import { sql, type SQL } from "drizzle-orm"

import { validation, notFound, TracerError } from "@/src/server/tracer/errors"
import type { BuildContext } from "../context"
import { assertBuildProject, asIsoDate } from "../context"

export async function prepareOperations(context: BuildContext) {
  return assertBuildProject(context)
}

export function jsonValue(value: unknown) {
  return sql`${JSON.stringify(value ?? {})}::jsonb`
}

export function nullableJsonValue(value: unknown) {
  return value === null || value === undefined
    ? sql`null::jsonb`
    : sql`${JSON.stringify(value)}::jsonb`
}

export function iso(value: unknown) {
  return value instanceof Date ? value.toISOString() : asIsoDate(value)
}

export function decodeJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T
    } catch {
      // node-postgres decodes JSONB scalar strings to their primitive text
      // value, while some drivers return the serialized JSON representation.
      // Preserve the primitive rather than silently turning it into null.
      return value as T
    }
  }
  return value as T
}

export function requireText(value: unknown, label: string, max = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw validation(`${label} must be a non-empty string of at most ${max} characters.`)
  return value.trim()
}

export function pageLimit(value: unknown, fallback = 50) {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100)
    throw validation("limit must be an integer between 1 and 100.")
  return value
}

export function pageCursor(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string" || value.length > 256) throw validation("cursor is invalid.")
  return value
}

export function ensureRows<T>(rows: T[], resource: string, id: string): T {
  const row = rows[0]
  if (!row) throw notFound(resource, id)
  return row
}

export function assertChanged(result: { rowCount?: number | null }, message: string) {
  if (!result.rowCount) throw new TracerError("CONFLICT", message)
}

export function sqlAnd(parts: SQL[]) {
  return parts.length ? sql.join(parts, sql` and `) : sql`true`
}

export function asInt(value: unknown, fallback = 0) {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}
