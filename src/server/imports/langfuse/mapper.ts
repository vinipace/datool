import type { JsonObject, JsonValue } from "@/src/lib/tracer/contracts"
import type { Kind, SourceRecord } from "./client"
import { SourceError } from "./client"
import { destinationId, type ImportRun } from "./store"

export function object(raw: unknown): SourceRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new SourceError("INVALID_SOURCE_RECORD")
  return raw as SourceRecord
}
export const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length ? value : undefined
export function time(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new SourceError("INVALID_SOURCE_TIMESTAMP")
  return new Date(value).toISOString()
}
export function io(value: unknown, modern: boolean): JsonValue | undefined {
  if (value === undefined) return undefined
  if (modern && typeof value === "string") {
    try {
      return JSON.parse(value) as JsonValue
    } catch {
      return value
    }
  }
  return value as JsonValue
}

const record = (value: unknown): SourceRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as SourceRecord)
    : {}
const amount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
const tokens = (value: unknown): value is number =>
  amount(value) && Number.isSafeInteger(value)
const firstAmount = (...values: unknown[]) => values.find(amount)
const firstTokens = (...values: unknown[]) => values.find(tokens)

/** Explicit provider identities and components; never infer a name or reprice a call. */
export function analyticsAttributes(raw: SourceRecord): JsonObject {
  const result: JsonObject = {}
  const metadata = record(raw.metadata)
  const identity = [
    metadata["attributes.ai.telemetry.functionId"],
    metadata["ai.telemetry.functionId"],
    metadata["attributes.ai.functionId"],
    metadata["ai.functionId"],
  ].find((value) => typeof value === "string" && value.trim().length > 0)
  if (typeof identity === "string") result["ai.telemetry.functionId"] = identity
  const usage = record(raw.usageDetails ?? raw.usage)
  const unit = record(raw.usage).unit
  if (!text(unit) || String(unit).toUpperCase() === "TOKENS") {
    const fields = {
      cache_read_tokens: firstTokens(
        usage.input_cached_tokens,
        usage.cache_read_input_tokens,
        usage.cache_read,
        metadata["attributes.ai.usage.inputTokenDetails.cacheReadTokens"],
        metadata["attributes.ai.usage.cachedInputTokens"]
      ),
      cache_write_tokens: firstTokens(
        usage.cache_creation_input_tokens,
        usage.input_cache_creation_tokens,
        usage.cache_creation
      ),
      reasoning_tokens: firstTokens(
        usage.output_reasoning_tokens,
        usage.reasoning_output_tokens,
        usage.reasoning
      ),
    }
    for (const [key, value] of Object.entries(fields))
      if (value !== undefined) result[`usage.${key}`] = value
  }
  const costs = record(raw.costDetails)
  const breakdown: JsonObject = {}
  const input = firstAmount(costs.input)
  // Langfuse cost buckets are exclusive; Datool output cost includes reasoning.
  const output = firstAmount(costs.output)
  const reasoning = firstAmount(
    costs.output_reasoning_tokens,
    costs.reasoning_output_tokens,
    costs.reasoning
  )
  const cached = firstAmount(
    costs.input_cached_tokens,
    costs.cache_read_input_tokens,
    costs.cache_read
  )
  const written = firstAmount(
    costs.cache_creation_input_tokens,
    costs.input_cache_creation_tokens,
    costs.cache_creation
  )
  if (input !== undefined) breakdown.inputUSD = input
  if (output !== undefined || reasoning !== undefined) {
    const total = (output ?? 0) + (reasoning ?? 0)
    if (amount(total)) breakdown.outputUSD = total
  }
  if (cached !== undefined) breakdown.cacheReadsUSD = cached
  if (written !== undefined) breakdown.cacheWritesUSD = written
  if (Object.keys(breakdown).length) result["cost.breakdown"] = breakdown
  return result
}
export function attributes(
  run: ImportRun,
  kind: Kind,
  raw: SourceRecord,
  synthetic: boolean
): JsonObject {
  const result: JsonObject = {
    "import.source": {
      provider: "langfuse",
      host: run.host,
      projectId: run.source_project_id,
      id: String(raw.id),
      kind,
      reconstructed: synthetic,
    },
  }
  for (const field of [
    "metadata",
    "tags",
    "release",
    "version",
    "environment",
    "userId",
    "public",
    "bookmarked",
    "type",
    "level",
    "statusMessage",
    "modelParameters",
    "promptId",
    "promptName",
    "promptVersion",
    "usage",
    "usageDetails",
    "costDetails",
    "totalCost",
    "latency",
  ])
    if (raw[field] !== undefined)
      result[`langfuse.${field}`] = raw[field] as JsonValue
  if (raw.tags !== undefined) result.tags = raw.tags as JsonValue
  if (typeof raw.model === "string") result["gen_ai.request.model"] = raw.model
  // Only observations contribute usage/cost. Trace totals are aggregates of these same observations.
  if (kind === "observations") {
    Object.assign(result, analyticsAttributes(raw))
    const usage =
      raw.usageDetails && typeof raw.usageDetails === "object"
        ? (raw.usageDetails as SourceRecord)
        : raw.usage && typeof raw.usage === "object"
          ? (raw.usage as SourceRecord)
          : {}
    const legacyUsage =
      raw.usage && typeof raw.usage === "object"
        ? (raw.usage as SourceRecord)
        : {}
    const tokenUnits =
      !text(legacyUsage.unit) ||
      String(legacyUsage.unit).toUpperCase() === "TOKENS"
    for (const [field, value] of Object.entries({
      // Exported totals are inclusive; flat usageDetails buckets are exclusive.
      input_tokens:
        raw.inputUsage ??
        (raw.usageDetails && tokens(usage.input)
          ? usage.input +
            Number(result["usage.cache_read_tokens"] ?? 0) +
            Number(result["usage.cache_write_tokens"] ?? 0)
          : usage.input),
      output_tokens:
        raw.outputUsage ??
        (raw.usageDetails && tokens(usage.output)
          ? usage.output + Number(result["usage.reasoning_tokens"] ?? 0)
          : usage.output),
      total_tokens: raw.totalUsage ?? usage.total,
    }))
      if (
        tokenUnits &&
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
      )
        result[`usage.${field}`] = value
    const cost =
      raw.totalCost ?? raw.calculatedTotalCost ?? legacyUsage.totalCost
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
      result["cost.usd"] = cost
      result["cost.status"] = "known"
    }
    if (typeof raw.timeToFirstToken === "number" && raw.timeToFirstToken >= 0)
      result["ttft.ms"] = raw.timeToFirstToken * 1000
  }
  return result
}
export function observationKind(type: unknown) {
  const kinds = {
    GENERATION: "llm",
    SPAN: "custom",
    EVENT: "custom",
    AGENT: "agent",
    TOOL: "tool",
    CHAIN: "workflow",
    RETRIEVER: "custom",
    EVALUATOR: "score",
    EMBEDDING: "llm",
    GUARDRAIL: "custom",
  } as const
  const kind = kinds[type as keyof typeof kinds]
  if (!kind) throw new SourceError("UNSUPPORTED_OBSERVATION_TYPE")
  return kind
}
export function scoreEnvelope(run: ImportRun, raw: SourceRecord) {
  const modern = run.checkpoint.modes.scores === "modern"
  const subject =
    raw.subject && typeof raw.subject === "object"
      ? (raw.subject as SourceRecord)
      : {}
  let target: { type: string; id: string } | undefined
  if (modern) {
    const type = { trace: "trace", observation: "span", session: "session" }[
      String(subject.kind)
    ]
    const sourceId =
      text(subject.traceId) ??
      text(subject.observationId) ??
      text(subject.sessionId) ??
      text(subject.id)
    // Observation subjects contain traceId too: retain the most specific target.
    const id =
      subject.kind === "observation"
        ? (text(subject.observationId) ?? text(subject.id))
        : sourceId
    if (type && id)
      target = {
        type,
        id: destinationId(
          run,
          type === "trace"
            ? "traces"
            : type === "span"
              ? "observations"
              : "sessions",
          id
        ),
      }
  } else {
    const type = text(raw.observationId)
      ? "span"
      : text(raw.traceId)
        ? "trace"
        : text(raw.sessionId)
          ? "session"
          : undefined
    const id =
      text(raw.observationId) ?? text(raw.traceId) ?? text(raw.sessionId)
    if (type && id)
      target = {
        type,
        id: destinationId(
          run,
          type === "span"
            ? "observations"
            : type === "trace"
              ? "traces"
              : "sessions",
          id
        ),
      }
  }
  const type =
    {
      NUMERIC: "numeric",
      BOOLEAN: "boolean",
      CATEGORICAL: "categorical",
      TEXT: "text",
    }[String(raw.dataType)] ?? String(raw.dataType)
  let value = raw.value
  if (!modern && type === "boolean" && (value === 0 || value === 1))
    value = value === 1
  if (!modern && (type === "categorical" || type === "text"))
    value = raw.stringValue
  return {
    source: {
      provider: "langfuse",
      instance: run.host,
      projectId: run.source_project_id,
      id: String(raw.id),
    },
    record: {
      name: raw.name,
      timestamp: raw.timestamp,
      target: target ?? { type: "unsupported", id: "unmapped" },
      data: { type, value },
      ...(typeof raw.comment === "string" ? { comment: raw.comment } : {}),
      author: raw.authorUserId ?? null,
      metadata: {
        providerSource: raw.source ?? null,
        providerMetadata: raw.metadata ?? null,
      },
      raw,
    },
  }
}
