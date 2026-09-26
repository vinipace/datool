"use client"

import { Braces, Plus } from "lucide-react"
import { Combobox } from "@/components/ui/combobox"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import type { TraceSummary } from "@/src/lib/tracer/contracts"
import { tracerApi } from "./api"
import { useCollectionPages } from "./use-collection-pages"
import { useCollectionFilter } from "./use-collection-filter"
import { LoadingState } from "./primitives"
import { SpanKindIcon } from "./span-kind-icon"
import { InfiniteScroll } from "./infinite-scroll"
import { getTraceIconKind } from "./trace-icon-kind"

export function ScorerTracePicker({
  className,
  excludedIds,
  onAdd,
  onAddJson,
}: {
  className?: string
  excludedIds: string[]
  onAdd: (trace: TraceSummary) => void
  onAddJson: () => void
}) {
  const filter = useCollectionFilter("traces", "", { persist: false })
  const traces = useCollectionPages(
    tracerApi.traces.list,
    filter.filter,
    60_000
  )
  const searching =
    filter.value.trim() !== filter.filter ||
    traces.isLoading ||
    traces.isRefreshing
  const available = traces.items.filter(
    (trace) => !excludedIds.includes(trace.id)
  )
  return (
    <Combobox
      label="Add data"
      placeholder="Add data"
      variant="row"
      className={className}
      icon={<Plus />}
      value={null}
      onSearchChange={filter.onChange}
      searchPlaceholder="Search traces or enter a filter…"
      popupClassName="w-96"
      options={[
        { value: "json", label: "JSON", icon: Braces },
        ...(!searching && !filter.error
          ? available.map((trace) => ({
              value: trace.id,
              label: trace.name || trace.id,
              leading: <SpanKindIcon kind={getTraceIconKind(trace)} />,
              description: trace.id,
              descriptionBelow: true,
            }))
          : []),
      ]}
      onValueChange={(id) => {
        if (id === "json") onAddJson()
        else {
          const trace = available.find((trace) => trace.id === id)
          if (trace) onAdd(trace)
        }
      }}
      virtualized
      listFooter={
        <InfiniteScroll
          {...traces}
          canLoadMore={traces.canLoadMore && !searching && !filter.error}
          isFetching={traces.isFetching || searching}
        />
      }
      popupFooter={
        searching ||
        filter.error ||
        traces.error ||
        !available.length ? (
          <div className="space-y-2 border-t border-border p-2">
            {filter.error ? (
              <Notice variant="error" role="alert">
                {filter.error}
              </Notice>
            ) : traces.error ? (
              <Notice variant="error" role="alert">
                {traces.error.message}{" "}
                <Button size="sm" variant="ghost" onClick={traces.refresh}>
                  Retry traces
                </Button>
              </Notice>
            ) : searching ? (
              <LoadingState compact label="Loading traces" />
            ) : !available.length ? (
              <p className="px-2 py-1 text-xs text-foreground-muted">
                No matching traces to add.
              </p>
            ) : null}
          </div>
        ) : undefined
      }
    />
  )
}
