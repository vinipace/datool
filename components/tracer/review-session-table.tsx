"use client"

import { Clock3, SkipForward } from "lucide-react"
import type {
  ReviewItem,
  ReviewSessionTable as ReviewSessionTableData,
} from "@/src/lib/tracer/reviews"
import { TraceListTable } from "./trace-list-table"
import { DEFAULT_TRACE_LIST_COLUMNS } from "./trace-list-utils"
import { formatDate } from "./format"
import { cn } from "@/lib/utils"
import { ResultIcon } from "./result-icon"
import { PercentageCell } from "./percentage-cell"

function reviewItemStatus(item: ReviewItem) {
  return item.skippedAt ? "Skipped" : item.label === "AI-labelled" ? `AI-labelled · ${item.reviewedAt ? "Complete" : "Pending"}` : item.reviewedAt ? "Reviewed" : "Pending"
}

export function ReviewSessionTable({
  session,
  checkedIds,
  onCheckedIdsChange,
  onOpen,
}: {
  session: ReviewSessionTableData
  checkedIds: Set<string>
  onCheckedIdsChange: (ids: Set<string>) => void
  onOpen: (itemId: string) => void
}) {
  const items = new Map(session.items.map((item) => [item.traceId, item]))
  const scoresByItem = new Map<
    string,
    Map<string, ReviewSessionTableData["scores"][number]>
  >()
  for (const score of session.scores) {
    let values = scoresByItem.get(score.itemId)
    if (!values) {
      values = new Map()
      scoresByItem.set(score.itemId, values)
    }
    values.set(score.humanScoreId, score)
  }
  return (
    <TraceListTable
      persistenceKey="review-session"
      fillHeight
      columns={DEFAULT_TRACE_LIST_COLUMNS}
      traces={session.traces}
      selectedTraceId={null}
      checkedIds={checkedIds}
      onCheckedIdsChange={onCheckedIdsChange}
      onOpenTrace={(traceId) => onOpen(items.get(traceId)!.id)}
      isTraceSkipped={(trace) => !!items.get(trace.id)?.skippedAt}
      rowLabel={(trace) =>
        `Review ${trace.name || trace.operation}, ${reviewItemStatus(items.get(trace.id)!)}`
      }
      orderStorageKey="datool:review-session:columns"
      emptyMessage="This session has no traces."
      additionalColumns={[
        {
          id: "review-status",
          label: "Review status",
          width: 210,
          after: "name",
          render: (trace) => {
            const item = items.get(trace.id)!
            const reviewed = !item.skippedAt && !!item.reviewedAt
            const Icon = item.skippedAt ? SkipForward : Clock3
            return (
              <span
                className={cn(
                  "flex items-center gap-2",
                  item.skippedAt
                    ? "text-warning"
                    : reviewed
                      ? "text-success"
                      : "text-foreground-secondary"
                )}
              >
                {reviewed ? (
                  <span aria-hidden="true">
                    <ResultIcon success label="Reviewed" />
                  </span>
                ) : (
                  <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                )}
                {reviewItemStatus(item)}
              </span>
            )
          },
        },
        {
          id: "reviewed-at",
          label: "Reviewed at",
          width: 180,
          after: "name",
          render: (trace) => {
            const item = items.get(trace.id)!
            return (
              <span className="text-foreground-secondary">
                {item.reviewedAt ? formatDate(item.reviewedAt) : "—"}
              </span>
            )
          },
        },
        ...session.scoreColumns.map((column) => ({
          id: `review-score:${column.id}`,
          label: column.name,
          width: column.type === "numeric" ? 140 : 220,
          after: "name" as const,
          render: (trace: ReviewSessionTableData["traces"][number]) => {
            const score = scoresByItem
              .get(items.get(trace.id)!.id)
              ?.get(column.id)
            const value = score?.value
            if (
              value == null ||
              (typeof value === "number" && value >= 0 && value <= 1)
            ) {
              return <PercentageCell value={value} />
            }
            return (
              <span
                className={cn(
                  "block truncate text-foreground-secondary",
                  column.type === "numeric" && "tabular-nums"
                )}
                title={score?.valueLabel ?? undefined}
              >
                {score?.valueLabel ?? "—"}
              </span>
            )
          },
        })),
      ]}
    />
  )
}
