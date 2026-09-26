import { Skeleton } from "@/components/ui/skeleton"
import { buttonVariants } from "@/components/ui/button"
import { Columns3 } from "lucide-react"
import { cn } from "@/lib/utils"

/** Reserves the table-owned Display slot until its columns are available. */
export function CollectionDisplaySkeleton({
  iconOnly = false,
}: {
  iconOnly?: boolean
}) {
  return (
    <div
      aria-hidden="true"
      data-slot="collection-display-skeleton"
      className={cn(
        buttonVariants({ variant: "outline" }),
        "pointer-events-none relative h-8 shrink-0 gap-1.5 rounded-md px-2 text-xs shadow-none"
      )}
    >
      <Columns3 className="invisible size-3.5" />
      {!iconOnly && (
        <span className="invisible hidden @min-[640px]/page:inline">
          Display
        </span>
      )}
      <Skeleton className="absolute inset-0" />
    </div>
  )
}

/** Route fallback only; mounted collections keep their real search and actions. */
export function CollectionToolbarSkeleton() {
  return (
    <div
      aria-hidden="true"
      data-slot="collection-toolbar-skeleton"
      className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2"
    >
      <Skeleton className="h-9 min-w-0 flex-1 rounded border border-border-strong" />
      <div className="flex shrink-0 items-center gap-1">
        <Skeleton className="hidden size-8 @min-[480px]/page:block" />
        <CollectionDisplaySkeleton />
        <Skeleton className="size-8" />
      </div>
    </div>
  )
}

const columns =
  "grid grid-cols-[44px_minmax(260px,2fr)_minmax(220px,2fr)_repeat(3,minmax(140px,1fr))]"
const textWidths = ["w-2/3", "w-1/2", "w-4/5", "w-3/5"]

/** Traces reserves its histogram and count throughout route and data loading. */
export function CollectionHistogramSkeleton() {
  return (
    <>
      <Skeleton data-slot="collection-histogram-skeleton" className="my-2 h-[76px] shrink-0" />
      <div aria-hidden="true" className="flex h-7 shrink-0 items-center px-3">
        <Skeleton className="h-2.5 w-20" />
      </div>
    </>
  )
}

/** Matches the shared table's 48px header, 40px rows and 2px row gaps. */
export function CollectionTableSkeleton({ label }: { label: string }) {
  return (
    <div
      role="status"
      data-slot="collection-table-skeleton"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="min-h-0 overflow-hidden py-0.5">
        <div className={`${columns} h-12 items-center`}>
          <div className="flex justify-center">
            <Skeleton className="size-3.5" />
          </div>
          {Array.from({ length: 5 }, (_, column) => (
            <div
              key={column}
              className="flex h-full items-center border-r border-border px-3 last:border-r-0"
            >
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </div>
        <div className="mt-0.5 space-y-0.5">
          {Array.from({ length: 24 }, (_, row) => (
            <div
              key={row}
              className={`${columns} h-10 items-center rounded-md bg-surface-row`}
              style={{ opacity: 0.85 ** row }}
            >
              <div className="flex justify-center">
                <Skeleton className="h-2.5 w-2 bg-border" />
              </div>
              {Array.from({ length: 5 }, (_, column) => (
                <div
                  key={column}
                  className="flex min-w-0 items-center gap-2 px-3"
                >
                  {column === 0 && (
                    <Skeleton className="size-5 shrink-0 bg-border" />
                  )}
                  <Skeleton
                    className={`h-3 bg-border ${textWidths[(row + column) % textWidths.length]}`}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
