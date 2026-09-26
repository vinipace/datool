import type { InvocationGroup } from "./groups"

/** Frozen workload identity, independent of the scorer and its model. */
export type EvalAttribution = {
  group: InvocationGroup | null
  models: string[]
  sourceTraceId: string
  sourceSpanId: string | null
}

export const evalGroupKey = (group: InvocationGroup) =>
  JSON.stringify([group.type, group.name, group.version ?? null])

export function uniqueEvalGroups(groups: InvocationGroup[]) {
  return [
    ...new Map(groups.map((group) => [evalGroupKey(group), group])).values(),
  ].sort((a, b) => evalGroupKey(a).localeCompare(evalGroupKey(b)))
}
