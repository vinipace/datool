import { Layers } from "lucide-react"
import { Fragment } from "react"
import type { SemanticDataRow } from "@/src/lib/semantic/result"
import { SpanKindIcon } from "./span-kind-icon"
import type { TraceIconKind } from "./trace-icon-kind"
import {
  dashboardDimensionText,
  dashboardDimensionIcon,
  dashboardGroupText,
} from "./dashboard-dimension-icon"

const kinds: Record<string, TraceIconKind> = {
  "logs.agentName": "agent",
  "agents.name": "agent",
  "logs.workflowName": "workflow",
  "workflows.name": "workflow",
  "logs.functionName": "llm",
  "logs.stepName": "task",
}

export function DashboardGroupLabel({
  dimensions,
  row,
}: {
  dimensions: string[]
  row: SemanticDataRow
}) {
  return (
    <span
      className="flex min-w-0 items-center gap-2"
      title={dashboardGroupText(dimensions, row)}
    >
      {dimensions.map((dimension, index) => (
        <Fragment key={dimension}>
          {index > 0 && (
            <span className="shrink-0" aria-hidden="true">
              ·
            </span>
          )}
          <DashboardDimensionLabel
            dimension={dimension}
            value={row[dimension]}
          />
        </Fragment>
      ))}
    </span>
  )
}

export function DashboardDimensionLabel({
  dimension,
  value,
  wrap = false,
}: {
  dimension: string
  value: unknown
  wrap?: boolean
}) {
  const kind = kinds[dimension]
  const label = dashboardDimensionText(dimension, value)
  return (
    <span className="flex min-w-0 items-center gap-2" title={label}>
      {kind ? (
        <SpanKindIcon kind={kind} />
      ) : dashboardDimensionIcon(dimension) ? (
        <Layers className="size-4 shrink-0" aria-hidden="true" />
      ) : null}
      <span className={wrap ? "min-w-0 break-words" : "truncate"}>{label}</span>
    </span>
  )
}
