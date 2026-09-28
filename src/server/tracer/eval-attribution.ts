import { readModel } from "@/src/lib/tracer/usage"
import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import type {
  JsonObject,
  Span,
  TraceForEvaluation,
} from "@/src/lib/tracer/contracts"
import type { InvocationGroup } from "@/src/lib/tracer/groups"
import {
  evalGroupKey,
  type EvalAttribution,
} from "@/src/lib/tracer/eval-attribution"
import { getTracerProjectId, type TracerDatabase } from "./db"

function recordedModel(attributes: JsonObject): string | null {
  return readModel(attributes) ?? null
}

/** One indexed pass over each span graph; model sets propagate from leaves to parents. */
function spanModelSets(spans: Span[]) {
  const byId = new Map(spans.map((span) => [span.id, span]))
  const children = new Map<string, string[]>()
  for (const span of spans)
    if (span.parentId && byId.has(span.parentId)) {
      const siblings = children.get(span.parentId) ?? []
      siblings.push(span.id)
      children.set(span.parentId, siblings)
    }
  const excluded = new Set<string>()
  const queue = spans
    .filter(
      (span) =>
        span.kind === "score" ||
        span.attributes["datool.scorer.execution"] === true ||
        span.attributes["datool.execution.role"] === "scorer"
    )
    .map((span) => span.id)
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    if (excluded.has(id)) continue
    excluded.add(id)
    queue.push(...(children.get(id) ?? []))
  }
  const models = new Map<string, Set<string>>()
  const remaining = new Map<string, number>()
  const leaves: string[] = []
  const all = new Set<string>()
  for (const span of spans)
    if (!excluded.has(span.id)) {
      const model = recordedModel(span.attributes)
      models.set(span.id, new Set(model ? [model] : []))
      if (model) all.add(model)
      const count = (children.get(span.id) ?? []).filter(
        (id) => !excluded.has(id)
      ).length
      remaining.set(span.id, count)
      if (!count) leaves.push(span.id)
    }
  for (let i = 0; i < leaves.length; i++) {
    const id = leaves[i]
    const parent = byId.get(id)?.parentId
    if (!parent || !models.has(parent)) continue
    for (const model of models.get(id)!) models.get(parent)!.add(model)
    const count = remaining.get(parent)! - 1
    remaining.set(parent, count)
    if (!count) leaves.push(parent)
  }
  // A parent graph has at most one outgoing edge per node. Nodes left after
  // leaf removal form disjoint cycles; all nodes in a cycle share its models.
  const cycles = new Set(
    [...remaining].filter(([, count]) => count > 0).map(([id]) => id)
  )
  while (cycles.size) {
    const members: string[] = []
    const union = new Set<string>()
    let id = cycles.values().next().value!
    while (cycles.delete(id)) {
      members.push(id)
      for (const model of models.get(id)!) union.add(model)
      id = byId.get(id)!.parentId!
    }
    for (const member of members) models.set(member, union)
  }
  return { models, all }
}

/** Resolve only explicit groups and observed workload models in the frozen scope. */
export function collectEvalAttributions(
  trace: TraceForEvaluation
): EvalAttribution[] {
  const collected = new Map<string, EvalAttribution>()
  const add = (
    group: InvocationGroup | null,
    models: Iterable<string>,
    item: TraceForEvaluation,
    spanId: string | null
  ) => {
    const key = group ? evalGroupKey(group) : "unassigned"
    const previous = collected.get(key)
    collected.set(key, {
      group,
      models: [...new Set([...(previous?.models ?? []), ...models])].sort(),
      sourceTraceId: previous?.sourceTraceId ?? item.id,
      sourceSpanId: previous?.sourceSpanId ?? spanId,
    })
  }
  const visited = new Set<TraceForEvaluation>()
  const ordered: TraceForEvaluation[] = []
  const queue = [trace]
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i]
    if (
      visited.has(item) ||
      item.operation === "score" ||
      item.attributes["datool.scorer.execution"] === true
    )
      continue
    visited.add(item)
    ordered.push(item)
    queue.push(...(item.linkedTraces ?? []))
  }
  const traceModels = new Map<TraceForEvaluation, Set<string>>()
  const spanModels = new Map<TraceForEvaluation, Map<string, Set<string>>>()
  for (const item of ordered.reverse()) {
    const { models, all } = spanModelSets(item.spans)
    const rootModel = recordedModel(item.attributes)
    if (rootModel) all.add(rootModel)
    for (const linked of item.linkedTraces ?? [])
      for (const model of traceModels.get(linked) ?? []) all.add(model)
    traceModels.set(item, all)
    spanModels.set(item, models)
  }
  for (const item of ordered.reverse()) {
    const models = spanModels.get(item)!
    if (item.group)
      add(item.group, traceModels.get(item)!, item, item.selectedSpanId ?? null)
    for (const span of item.spans)
      if (span.group && models.has(span.id))
        add(span.group, models.get(span.id)!, item, span.id)
  }
  if (!collected.size)
    add(null, traceModels.get(trace) ?? [], trace, trace.selectedSpanId ?? null)
  const prompts = new Map<
    string,
    { id: string; slug: string; version: number }
  >()
  const recordPrompt = (attributes: JsonObject) => {
    const id = attributes["datool.prompt.id"]
    const slug = attributes["datool.prompt.slug"]
    const version = attributes["datool.prompt.version"]
    if (
      typeof id === "string" &&
      id &&
      typeof slug === "string" &&
      slug &&
      typeof version === "number" &&
      Number.isSafeInteger(version) &&
      version > 0
    )
      prompts.set(JSON.stringify([id, version]), { id, slug, version })
  }
  for (const item of ordered) {
    recordPrompt(item.attributes)
    for (const span of item.spans)
      if (spanModels.get(item)?.has(span.id)) recordPrompt(span.attributes)
  }
  const promptVersions = [...prompts.values()].sort(
    (a, b) => a.id.localeCompare(b.id) || a.version - b.version
  )
  return [...collected.values()].map((item) =>
    promptVersions.length ? { ...item, promptVersions } : item
  )
}

const identity = (parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex")

export type EvalAttributionWrite = {
  targetId: string
  attributions: EvalAttribution[]
}

/** Caller owns the transaction. Bound parameters and statements by chunks, not memberships. */
export async function saveEvalAttributions(
  db: TracerDatabase,
  runId: string,
  targets: EvalAttributionWrite[],
  replace = false
) {
  if (!targets.length) return
  const project = getTracerProjectId(db)
  const groups = new Map<string, InvocationGroup>()
  const rows = targets.flatMap((target) =>
    target.attributions.map((item) => {
      const key = item.group ? evalGroupKey(item.group) : null
      if (item.group) groups.set(key!, item.group)
      return { targetId: target.targetId, item, key }
    })
  )
  const chunkSize = 1000
  for (let i = 0; replace && i < targets.length; i += chunkSize) {
    const ids = targets
      .slice(i, i + chunkSize)
      .map((target) => sql`${target.targetId}`)
    await db.execute(
      sql`delete from eval_target_attributions where project_id=${project} and run_id=${runId} and target_id in (${sql.join(ids, sql`, `)})`
    )
  }
  await saveEvalRunGroups(db, runId, [...groups.values()])
  for (let i = 0; i < rows.length; i += chunkSize) {
    await db.execute(
      sql`insert into eval_target_attributions(id,project_id,run_id,target_id,group_type,group_name,group_version,models_json,source_trace_id,source_span_id,prompt_versions_json) values ${sql.join(
        rows
          .slice(i, i + chunkSize)
          .map(
            ({ targetId, item, key }) =>
              sql`(${identity([project, runId, targetId, key])},${project},${runId},${targetId},${item.group?.type ?? null},${item.group?.name ?? null},${item.group?.version ?? null},${JSON.stringify(item.models)}::jsonb,${item.sourceTraceId},${item.sourceSpanId},${JSON.stringify(item.promptVersions ?? [])}::jsonb)`
          ),
        sql`, `
      )}`
    )
  }
}

/** Shared by normal capture and the historical repair; existing identities are preserved. */
export async function saveEvalRunGroups(
  db: TracerDatabase,
  runId: string,
  values: InvocationGroup[]
) {
  const project = getTracerProjectId(db)
  const groups = new Map(values.map((group) => [evalGroupKey(group), group]))
  const chunkSize = 1000
  // Consistent ordering protects concurrent targets sharing group identities.
  const unique = [...groups].sort(([a], [b]) => a.localeCompare(b))
  for (let i = 0; i < unique.length; i += chunkSize) {
    await db.execute(
      sql`insert into eval_run_groups(id,project_id,run_id,group_type,group_name,group_version) values ${sql.join(
        unique
          .slice(i, i + chunkSize)
          .map(
            ([key, group]) =>
              sql`(${identity([project, runId, key])},${project},${runId},${group.type},${group.name},${group.version ?? null})`
          ),
        sql`, `
      )} on conflict(id) do nothing`
    )
  }
}
