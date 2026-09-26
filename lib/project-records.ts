import { randomUUID } from "node:crypto"

export const recordKinds = ["trace", "evaluation", "prompt", "dataset"] as const
export type RecordKind = (typeof recordKinds)[number]

export type ProjectRecord = {
  id: string
  projectId: string
  kind: RecordKind
  name: string
  data: unknown
  createdAt: Date
  updatedAt: Date
}

export type Pagination = { page: number; pageSize: number; offset: number }

export const MAX_RECORD_DATA_BYTES = 256 * 1024
export const MAX_PROJECT_REQUEST_BYTES = 8 * 1024
export const MAX_RECORD_REQUEST_BYTES = MAX_RECORD_DATA_BYTES + 8 * 1024

const recordKindSet = new Set<string>(recordKinds)

export function isRecordKind(value: unknown): value is RecordKind {
  return typeof value === "string" && recordKindSet.has(value)
}

export function parsePagination(searchParams: URLSearchParams): Pagination | null {
  const page = parsePositiveInteger(searchParams.get("page") ?? "1", 1, 10_000)
  const pageSize = parsePositiveInteger(searchParams.get("pageSize") ?? "25", 1, 100)

  if (page === null || pageSize === null) return null
  return { page, pageSize, offset: (page - 1) * pageSize }
}

function parsePositiveInteger(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return null
  return parsed
}

export function parseProjectCreate(input: unknown): { name: string; slug: string } | null {
  if (!isPlainObject(input) || !hasOnlyKeys(input, ["name", "slug"])) return null
  const name = parseName(input.name)
  if (!name) return null
  const slug = input.slug === undefined ? slugify(name) : parseSlug(input.slug)
  return slug ? { name, slug } : null
}

export function parseProjectUpdate(input: unknown): { name?: string; slug?: string } | null {
  if (!isPlainObject(input) || !hasOnlyKeys(input, ["name", "slug"])) return null
  const update: { name?: string; slug?: string } = {}
  if (input.name !== undefined) {
    const name = parseName(input.name)
    if (!name) return null
    update.name = name
  }
  if (input.slug !== undefined) {
    const slug = parseSlug(input.slug)
    if (!slug) return null
    update.slug = slug
  }
  return Object.keys(update).length > 0 ? update : null
}

export function parseRecordCreate(
  input: unknown,
): { kind: RecordKind; name: string; data: unknown; dataJson: string } | null {
  if (!isPlainObject(input) || !hasOnlyKeys(input, ["kind", "name", "data"])) return null
  if (!isRecordKind(input.kind)) return null
  const name = parseName(input.name)
  const dataJson = input.data === undefined || !isPlainObject(input.data) ? null : serializeRecordData(input.data)
  if (!name || dataJson === null) return null
  return { kind: input.kind, name, data: input.data, dataJson }
}

export function parseRecordUpdate(
  input: unknown,
): { name?: string; data?: unknown; dataJson?: string } | null {
  if (!isPlainObject(input) || !hasOnlyKeys(input, ["name", "data"])) return null
  const hasName = Object.hasOwn(input, "name")
  const hasData = Object.hasOwn(input, "data")
  if (!hasName && !hasData) return null
  const update: { name?: string; data?: unknown; dataJson?: string } = {}
  if (hasName) {
    const name = parseName(input.name)
    if (!name) return null
    update.name = name
  }
  if (hasData) {
    if (!isPlainObject(input.data)) return null
    const dataJson = serializeRecordData(input.data)
    if (dataJson === null) return null
    update.data = input.data
    update.dataJson = dataJson
  }
  return update
}

export function newRecordId() {
  return randomUUID()
}

export function serializeRecordData(data: unknown): string | null {
  try {
    const serialized = JSON.stringify(data)
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_RECORD_DATA_BYTES) {
      return null
    }
    return serialized
  } catch {
    return null
  }
}

function parseName(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 160 ? trimmed : null
}

function parseSlug(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim().toLowerCase()
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed) && trimmed.length <= 120 ? trimmed : null
}

function slugify(name: string): string | null {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
  return parseSlug(slug)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(input: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(input).every((key) => keys.includes(key))
}
