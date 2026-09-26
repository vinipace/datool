import { CircleDashed } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  CollectionHistogramSkeleton,
  CollectionTableSkeleton,
  CollectionToolbarSkeleton,
} from "./collection-skeleton"

export function LoadingState({
  label = "Loading data",
  compact = false,
}: {
  label?: string
  compact?: boolean
}) {
  return (
    <div
      role={compact ? "status" : undefined}
      className={cn(
        "flex items-center justify-center text-sm text-foreground-muted",
        compact ? "min-h-16 gap-2" : "min-h-72 flex-col gap-3"
      )}
    >
      <CircleDashed
        aria-hidden="true"
        className={cn(
          "motion-safe:animate-spin",
          compact ? "size-4" : "size-5"
        )}
      />
      {label}
    </div>
  )
}

/** Lightweight route fallback: keep it independent of tables and inspectors. */
export function PageLoading({ histogram = false }: { histogram?: boolean }) {
  return (
    <div className="@container/page flex h-full min-h-72 min-w-0 flex-col overflow-hidden bg-background">
      <CollectionToolbarSkeleton />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-1">
        {histogram && <CollectionHistogramSkeleton />}
        <CollectionTableSkeleton label="Loading page" />
      </div>
    </div>
  )
}
