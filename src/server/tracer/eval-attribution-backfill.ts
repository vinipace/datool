import { z } from "zod"
import type { TraceForEvaluation } from "@/src/lib/tracer/contracts"
import {
  invocationGroupSchema,
  type InvocationGroup,
} from "@/src/lib/tracer/groups"
import {
  evalGroupKey,
  type EvalAttribution,
} from "@/src/lib/tracer/eval-attribution"
import { collectEvalAttributions } from "./eval-attribution"

const object = z.record(z.string(), z.unknown())
const group = invocationGroupSchema.nullable().optional()
const spanSchema = z.looseObject({
  id: z.string().min(1),
  traceId: z.string().min(1),
  parentId: z.string().nullable(),
  kind: z.string(),
  group,
  attributes: object,
})
const traceSchema: z.ZodType = z.lazy(() =>
  z.looseObject({
    id: z.string().min(1),
    operation: z.string(),
    attributes: object,
    group,
    selectedSpanId: z.string().min(1).optional(),
    spans: z.array(spanSchema).max(100_000),
    linkedTraces: z.array(traceSchema).optional(),
  })
)
const attributionSchema = z
  .array(
    z.object({
      group: invocationGroupSchema.nullable(),
      models: z.array(z.string().min(1)),
      sourceTraceId: z.string().min(1),
      sourceSpanId: z.string().nullable(),
      promptVersions: z
        .array(
          z.object({
            id: z.string().min(1),
            slug: z.string().min(1),
            version: z.number().int().positive(),
          })
        )
        .optional(),
    })
  )
  .min(1)
  .max(100_000)

export class BackfillSkip extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}
export type GroupReference = { traceId: string; spanId: string | null }
export const referenceKey = (ref: GroupReference) =>
  JSON.stringify([ref.traceId, ref.spanId])
export type FrozenBackfillTarget = {
  id: string
  traceId: string
  snapshot: Record<string, unknown>
  trace: TraceForEvaluation
  saved?: EvalAttribution[]
  missingGroups: Map<string, GroupReference>
}

export function validatedAttributions(value: unknown): EvalAttribution[] {
  const parsed = attributionSchema.safeParse(value)
  if (!parsed.success) throw new BackfillSkip("invalid_saved_attribution")
  const identities = parsed.data.map((a) =>
    a.group ? evalGroupKey(a.group) : "unassigned"
  )
  if (new Set(identities).size !== identities.length)
    throw new BackfillSkip("duplicate_saved_attribution")
  return parsed.data
}

/** Only missing identity labels may come from immutable rows. Never hydrate models,
 * inputs, outputs, missing spans or linked traces from mutable current telemetry. */
export function prepareFrozenTarget(
  id: string,
  traceId: string,
  snapshotJson: string | null
): FrozenBackfillTarget {
  if (!snapshotJson) throw new BackfillSkip("missing_frozen_snapshot")
  let snapshot: Record<string, unknown>
  try {
    snapshot = object.parse(JSON.parse(snapshotJson))
  } catch {
    throw new BackfillSkip("invalid_frozen_snapshot")
  }
  const parsed = traceSchema.safeParse(snapshot.trace)
  if (!parsed.success) throw new BackfillSkip("invalid_frozen_evidence")
  const trace = parsed.data as TraceForEvaluation
  if (trace.id !== traceId) throw new BackfillSkip("snapshot_trace_mismatch")
  const result: FrozenBackfillTarget = {
    id,
    traceId,
    snapshot,
    trace,
    missingGroups: new Map(),
  }
  if (snapshot.attributions !== undefined) {
    result.saved = validatedAttributions(snapshot.attributions)
    return result
  }
  const queue = [trace]
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i]
    if (
      item.operation === "score" ||
      item.attributes["datool.scorer.execution"] === true
    )
      continue
    if (i > 10000) throw new BackfillSkip("too_many_linked_traces")
    const ids = new Set(item.spans.map((s) => s.id))
    if (
      ids.size !== item.spans.length ||
      item.spans.some((s) => s.traceId !== item.id)
    )
      throw new BackfillSkip("invalid_span_identity")
    if (item.selectedSpanId && !ids.has(item.selectedSpanId))
      throw new BackfillSkip("missing_selected_span")
    // Missing scorer parents could otherwise make a judge's child look like workload telemetry.
    if (
      item.spans.some(
        (s) =>
          s.parentId && !ids.has(s.parentId) && s.id !== item.selectedSpanId
      )
    )
      throw new BackfillSkip("incomplete_span_ancestry")
    const refs = [
      {
        ref: { traceId: item.id, spanId: item.selectedSpanId ?? null },
        value: item.group,
      },
      ...item.spans.map((s) => ({
        ref: { traceId: item.id, spanId: s.id },
        value: s.group,
      })),
    ]
    for (const { ref, value } of refs)
      if (value === undefined) result.missingGroups.set(referenceKey(ref), ref)
    queue.push(...(item.linkedTraces ?? []))
  }
  return result
}

export function resolveFrozenTarget(
  target: FrozenBackfillTarget,
  groups: Map<string, InvocationGroup | null>
): EvalAttribution[] {
  if (target.saved) return target.saved
  const resolve = (ref: GroupReference) => {
    const key = referenceKey(ref)
    if (!groups.has(key))
      throw new BackfillSkip("missing_immutable_group_source")
    return groups.get(key)!
  }
  const queue = [target.trace]
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i]
    if (
      item.operation === "score" ||
      item.attributes["datool.scorer.execution"] === true
    )
      continue
    if (item.group === undefined)
      item.group = resolve({
        traceId: item.id,
        spanId: item.selectedSpanId ?? null,
      })
    for (const span of item.spans)
      if (span.group === undefined)
        span.group = resolve({ traceId: item.id, spanId: span.id })
    queue.push(...(item.linkedTraces ?? []))
  }
  return collectEvalAttributions(target.trace)
}

export type BackfillTargetIdentity = {
  id: string
  traceId: string
  datasetItemId: string | null
}
export type BackfillResultIdentity = {
  id: string
  targetId: string | null
  traceId: string
  datasetItemId: string | null
  metadata: string
}

/** Explicit target references win; an absent reference may use a unique legacy
 * trace/item pair. A broken explicit reference must never silently fall back. */
export function linkBackfillResults(
  targets: BackfillTargetIdentity[],
  results: BackfillResultIdentity[]
) {
  const byId = new Map(targets.map((t) => [t.id, t]))
  const pairs = new Map<string, BackfillTargetIdentity[]>()
  const key = (item: { traceId: string; datasetItemId: string | null }) =>
    JSON.stringify([item.traceId, item.datasetItemId])
  for (const target of targets) {
    const values = pairs.get(key(target)) ?? []
    values.push(target)
    pairs.set(key(target), values)
  }
  return results.flatMap((result) => {
    if (result.targetId) {
      if (!byId.has(result.targetId))
        throw new BackfillSkip("invalid_result_target")
      return []
    }
    let metadata: Record<string, unknown>
    try {
      metadata = object.parse(JSON.parse(result.metadata))
    } catch {
      throw new BackfillSkip("invalid_result_metadata")
    }
    const explicit = metadata.evalTargetId
    const candidates = Object.hasOwn(metadata, "evalTargetId")
      ? typeof explicit === "string" && byId.has(explicit)
        ? [byId.get(explicit)!]
        : []
      : (pairs.get(key(result)) ?? [])
    if (candidates.length !== 1)
      throw new BackfillSkip(
        candidates.length ? "ambiguous_result_target" : "missing_result_target"
      )
    if (key(candidates[0]) !== key(result))
      throw new BackfillSkip("result_target_scope_mismatch")
    return [{ id: result.id, targetId: candidates[0].id }]
  })
}
