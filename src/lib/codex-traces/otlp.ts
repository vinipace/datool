import { createHash } from "node:crypto"
import { z } from "zod"
import type { JsonObject, JsonValue } from "../tracer/contracts"
import type { CapturedLog, CapturedSpan, Telemetry } from "./types"

const value: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(value),
    z.record(z.string(), value),
  ])
)
const attributes = z.array(z.object({ key: z.string(), value })).default([])
const nano = z.union([
  z.string().regex(/^\d+$/),
  z.number().nonnegative().finite(),
])
const context = {
  traceId: z.string().default(""),
  spanId: z.string().default(""),
}
const span = z.object({
  ...context,
  parentSpanId: z.string().default(""),
  name: z.string(),
  startTimeUnixNano: nano,
  endTimeUnixNano: nano,
  attributes,
  events: z
    .array(z.object({ name: z.string(), timeUnixNano: nano, attributes }))
    .default([]),
  links: z.array(z.object(context)).default([]),
  status: z
    .object({
      code: z.union([z.number(), z.string()]).optional(),
      message: z.string().optional(),
    })
    .optional(),
})
const log = z.object({
  ...context,
  timeUnixNano: nano.optional(),
  observedTimeUnixNano: nano.optional(),
  eventName: z.string().optional(),
  attributes,
  body: value.optional(),
  severityNumber: z.number().optional(),
  severityText: z.string().optional(),
})
const resource = z.object({ attributes }).optional()
const traces = z.object({
  resourceSpans: z.array(
    z.object({
      resource,
      scopeSpans: z.array(z.object({ spans: z.array(span) })),
    })
  ),
})
const logs = z.object({
  resourceLogs: z.array(
    z.object({
      resource,
      scopeLogs: z.array(z.object({ logRecords: z.array(log) })),
    })
  ),
})

function object(v: JsonValue | undefined): JsonObject {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {}
}
function anyValue(v: JsonValue): JsonValue {
  const o = object(v)
  for (const k of ["stringValue", "boolValue", "doubleValue", "bytesValue"])
    if (o[k] !== undefined) return o[k]!
  if (o.intValue !== undefined) {
    const n = Number(o.intValue)
    return Number.isSafeInteger(n) ? n : String(o.intValue)
  }
  const array = object(o.arrayValue).values
  if (Array.isArray(array)) return array.map(anyValue)
  const kv = object(o.kvlistValue).values
  if (Array.isArray(kv))
    return Object.fromEntries(
      kv.map((e) => {
        const x = object(e)
        return [String(x.key), anyValue(x.value ?? null)]
      })
    )
  return null
}
function attrs(entries: z.infer<typeof attributes>): JsonObject {
  return Object.fromEntries(entries.map((e) => [e.key, anyValue(e.value)]))
}
function milliseconds(n: string | number | undefined): number {
  const ms = Number(n ?? 0) / 1e6
  if (!Number.isFinite(ms) || ms < 0 || ms > 8.64e15)
    throw new Error("Invalid OTLP timestamp")
  return ms
}
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")

/** OTLP/HTTP JSON. Validation is shared by the receiver and journal replay. */
export function decodeOtlp(
  signal: "traces" | "logs",
  body: unknown
): Telemetry {
  const result: Telemetry = { spans: [], logs: [] }
  if (signal === "traces") {
    for (const r of traces.parse(body).resourceSpans)
      for (const s of r.scopeSpans)
        for (const v of s.spans) {
          const start = milliseconds(v.startTimeUnixNano),
            end = milliseconds(v.endTimeUnixNano)
          if (!v.traceId || !v.spanId || end < start)
            throw new Error("Invalid OTLP span identity or interval")
          result.spans.push({
            traceId: v.traceId,
            spanId: v.spanId,
            parentSpanId: v.parentSpanId,
            name: v.name,
            start,
            end,
            attributes: {
              ...attrs(r.resource?.attributes ?? []),
              ...attrs(v.attributes),
              ...(v.status?.message
                ? { "error.message": v.status.message }
                : {}),
            },
            events: v.events.map((e) => ({
              name: e.name,
              at: milliseconds(e.timeUnixNano),
              attributes: attrs(e.attributes),
            })),
            links: v.links,
            error:
              v.status?.code === 2 || v.status?.code === "STATUS_CODE_ERROR",
          })
        }
  } else {
    for (const r of logs.parse(body).resourceLogs)
      for (const s of r.scopeLogs)
        for (const v of s.logRecords) {
          const a = {
            ...attrs(r.resource?.attributes ?? []),
            ...attrs(v.attributes),
          }
          // Rust currently emits timeUnixNano=0; event.timestamp carries source time.
          const recorded =
            typeof a["event.timestamp"] === "string"
              ? Date.parse(a["event.timestamp"])
              : NaN
          const at = Number.isFinite(recorded)
            ? recorded
            : milliseconds(
                v.timeUnixNano && Number(v.timeUnixNano) > 0
                  ? v.timeUnixNano
                  : v.observedTimeUnixNano
              )
          result.logs.push({
            id: fingerprint(v),
            name: String(a["event.name"] ?? v.eventName ?? "log"),
            at,
            traceId: v.traceId,
            spanId: v.spanId,
            attributes: {
              ...a,
              ...(v.body == null ? {} : { "log.body": anyValue(v.body) }),
            },
          })
        }
  }
  if (result.spans.length + result.logs.length > 20_000)
    throw new Error("OTLP batch has too many records")
  return result
}

/** Exporters retry batches and can deliver parents after children. */
export function mergeTelemetry(batches: Telemetry[]): Telemetry {
  const spans = new Map<string, CapturedSpan>(),
    logs = new Map<string, CapturedLog>()
  for (const batch of batches) {
    for (const span of batch.spans)
      spans.set(`${span.traceId}:${span.spanId}`, span)
    for (const log of batch.logs) logs.set(log.id, log)
  }
  return {
    spans: [...spans.values()].sort(
      (a, b) => a.start - b.start || a.spanId.localeCompare(b.spanId)
    ),
    logs: [...logs.values()].sort(
      (a, b) => a.at - b.at || a.id.localeCompare(b.id)
    ),
  }
}
