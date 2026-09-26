import { Skeleton } from "./skeleton"

/** Keep the configuration/chat split while the route or prompt is loading. */
export function PromptEditorSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading prompt"
      className="@container flex h-full min-h-0 flex-col"
    >
      <span className="sr-only">Loading prompt</span>
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-8 w-20" />
      </div>
      <div className="grid min-h-0 flex-1 grid-rows-2 @min-[800px]:grid-cols-[36%_1fr] @min-[800px]:grid-rows-1">
        <div className="overflow-hidden border-b border-border px-4 @min-[800px]:border-r @min-[800px]:border-b-0">
          <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-3">
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-9 w-64" />
          </div>
          <div className="space-y-3 border-b border-border px-3 py-4">
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-8 w-20" />
          </div>
          {[0, 1, 2, 3].map((index) => (
            <div
              key={index}
              className="flex items-center justify-between gap-3 border-b border-border px-3 py-3"
            >
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-9 w-64" />
            </div>
          ))}
        </div>
        <div className="flex min-h-0 flex-col justify-end gap-3 p-4">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-24 w-full rounded-2xl" />
        </div>
      </div>
    </div>
  )
}
