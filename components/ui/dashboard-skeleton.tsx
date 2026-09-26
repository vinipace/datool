import { Skeleton } from "./skeleton"

type WidgetType = "metric" | "bar" | "donut" | "table" | "line" | "stacked"

/** Fits inside the real widget, so data loading cannot move the canvas. */
export function DashboardWidgetSkeleton({ type }: { type: WidgetType }) {
  return (
    <div
      aria-hidden="true"
      data-slot="dashboard-widget-skeleton"
      className="flex h-full min-h-0 flex-col gap-4 overflow-hidden px-4 pt-2 pb-4"
    >
      {type === "metric" ? (
        <>
          <Skeleton className="h-9 w-28 shrink-0 bg-background" />
          <Skeleton className="h-3 w-24 shrink-0 bg-background" />
          <Skeleton className="mt-auto h-12 w-full bg-background" />
        </>
      ) : type === "bar" || type === "table" ? (
        Array.from({ length: 5 }, (_, index) => (
          <Skeleton
            key={index}
            className="h-8 shrink-0 bg-background"
            style={{ width: type === "bar" ? `${100 - index * 13}%` : "100%" }}
          />
        ))
      ) : type === "donut" ? (
        <Skeleton className="m-auto aspect-square h-3/4 max-w-full rounded-full bg-background" />
      ) : (
        <>
          <Skeleton className="min-h-12 w-full flex-1 bg-background" />
          <div className="flex justify-between">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-3 w-12 bg-background" />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** Used until the saved dashboard layout is available. No collection toolbar. */
export function DashboardSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading dashboard"
      aria-busy="true"
      className="@container/dashboard flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3"
    >
      <Skeleton className="h-5 w-2/5 shrink-0" />
      <div className="grid grid-cols-1 gap-3 @min-[640px]/dashboard:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="flex h-[204px] flex-col rounded-xl bg-muted"
          >
            <div className="flex h-10 shrink-0 items-center px-3">
              <Skeleton className="h-3 w-24 bg-background" />
            </div>
            <DashboardWidgetSkeleton type="metric" />
          </div>
        ))}
        {[0, 1].map((index) => (
          <div
            key={`chart-${index}`}
            className="flex h-[348px] flex-col rounded-xl bg-muted @min-[640px]/dashboard:col-span-2"
          >
            <div className="flex h-10 shrink-0 items-center px-3">
              <Skeleton className="h-3 w-32 bg-background" />
            </div>
            <DashboardWidgetSkeleton type="line" />
          </div>
        ))}
      </div>
    </div>
  )
}
