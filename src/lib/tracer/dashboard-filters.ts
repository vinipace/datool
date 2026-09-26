import type {
  NormalizedSemanticQuery,
  SemanticFilter,
} from "@/src/lib/semantic/query"
import type { InvocationSelection } from "@/src/lib/semantic/group-filter"
import type { DashboardWidget } from "./dashboards"

export const groupKey = (group: Pick<InvocationSelection, "type" | "name">) =>
  JSON.stringify([group.type, group.name])
export const versionKey = (
  group: Pick<InvocationSelection, "type" | "name">,
  version: string | null
) => JSON.stringify([group.type, group.name, version])
export const versionLabel = (version: string | null) => version ?? "Unversioned"

export function dashboardGroupFilters(
  model: string,
  groups: InvocationSelection[]
): SemanticFilter[] {
  // OR within each group type; AND between agents and workflows. Each encoded
  // selection binds the name and its versions to the same invocation.
  return (["agent", "workflow"] as const).flatMap((type) => {
    const selected = groups.filter((group) => group.type === type)
    return selected.length
      ? [
          {
            member: `${model}.invocationGroup`,
            operator: "in" as const,
            values: selected.map((group) => JSON.stringify(group)),
          },
        ]
      : []
  })
}

export function dashboardCohorts(
  widget: DashboardWidget
): { label?: string; query: NormalizedSemanticQuery }[] {
  const model = widget.query.measures[0].split(".")[0]
  const groups = widget.groups ?? []
  const compared = groups.find(
    (group) => widget.compare && groupKey(group) === groupKey(widget.compare)
  )
  const queryFor = (selected: InvocationSelection[]) => ({
    ...widget.query,
    filters: [
      ...widget.query.filters,
      ...dashboardGroupFilters(model, selected),
    ],
  })
  return compared?.versions && widget.compare
    ? compared.versions.map((version) => ({
        label: `${compared.name} · ${versionLabel(version)}`,
        query: queryFor([
          ...groups.filter((group) => group.type !== compared.type),
          { ...compared, versions: [version] },
        ]),
      }))
    : [{ query: queryFor(groups) }]
}
