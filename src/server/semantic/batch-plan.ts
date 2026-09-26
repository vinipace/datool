import type { NormalizedSemanticQuery } from "@/src/lib/semantic/query"
const plans = new WeakMap<object, readonly NormalizedSemanticQuery[]>()
export function planSnapshotQueries(
  snapshot: object,
  queries: readonly NormalizedSemanticQuery[]
) {
  plans.set(snapshot, queries)
}
export function snapshotQueries(snapshot: object) {
  return plans.get(snapshot) ?? []
}
