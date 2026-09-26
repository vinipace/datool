import { validation } from "../tracer/errors"

/** PostgreSQL JSONB cannot represent NUL or isolated UTF-16 surrogates. */
export function postgresJson(value: unknown): unknown {
  if (typeof value === "string") return value.toWellFormed().replaceAll("\u0000", "\ufffd")
  if (Array.isArray(value)) return value.map(postgresJson)
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(([key, child]) => [postgresJson(key) as string, postgresJson(child)] as const)
    if (new Set(entries.map(([key]) => key)).size !== entries.length) {
      throw validation("Object keys collide after Unicode normalization.")
    }
    return Object.fromEntries(entries)
  }
  return value
}
