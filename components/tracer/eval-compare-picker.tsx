"use client"

import { ChevronsUpDown } from "lucide-react"
import { ComboboxMultiple } from "@/components/ui/combobox"
import { ComparisonDot } from "@/components/ui/comparison-series"
import type { EvalRunSummary } from "@/src/lib/tracer/contracts"
import { tracerApi } from "./api"
import { useCollectionPages } from "./use-collection-pages"
import { CollectionPagination } from "./collection-pagination"
import { ErrorState } from "./primitives"
import { formatDate } from "./format"

export function EvalComparePicker({
  baseline,
  selectedRuns,
  selectedIds,
  onChange,
}: {
  baseline: EvalRunSummary
  selectedRuns: EvalRunSummary[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
}) {
  const runs = useCollectionPages(tracerApi.evals.list, "")
  const ids = [baseline.id, ...selectedIds]
  const available = new Map(
    [...runs.items, ...selectedRuns, baseline].map((run) => [run.id, run])
  )
  const options = [...new Set([...ids, ...available.keys()])].map((id) => {
    const run = available.get(id)
    const index = ids.indexOf(id)
    return {
      value: id,
      label: run?.name ?? id,
      description: run ? formatDate(run.createdAt) : "Loading run…",
      descriptionBelow: true,
      leading: index >= 0 ? <ComparisonDot index={index} /> : undefined,
      badge:
        id === baseline.id ? (
          <span className="text-xs text-foreground-muted">Baseline</span>
        ) : undefined,
    }
  })
  return (
    <div className="space-y-2">
      <ComboboxMultiple
        label="Comparison runs"
        options={options}
        value={ids}
        disabledValues={[baseline.id]}
        minSelected={1}
        maxSelected={4}
        onValueChange={(next) =>
          onChange(next.filter((id) => id !== baseline.id))
        }
        className="h-auto w-full justify-between rounded-lg bg-muted p-3 text-left"
        popupClassName="w-[min(30rem,calc(100vw-2rem))]"
        triggerContent={
          <>
            <span className="min-w-0 flex-1 space-y-3">
              {ids.map((id, index) => (
                <span key={id} className="flex items-start gap-2">
                  <ComparisonDot index={index} className="mt-1.5" />
                  <span className="min-w-0 flex-1">
                    <span
                      className="block text-sm break-words whitespace-normal"
                      title={available.get(id)?.name ?? id}
                    >
                      {available.get(id)?.name ?? id}
                    </span>
                    <span className="block text-xs font-normal text-foreground-muted">
                      {index === 0 ? "Baseline" : `Run ${index + 1}`} ·{" "}
                      {available.get(id)
                        ? formatDate(available.get(id)!.createdAt)
                        : "Loading…"}
                    </span>
                  </span>
                </span>
              ))}
              {ids.length === 1 && (
                <span className="block text-xs font-normal text-foreground-muted">
                  Add runs to compare…
                </span>
              )}
            </span>
            <ChevronsUpDown className="size-3.5 text-foreground-muted" />
          </>
        }
        popupFooter={
          <>
            <p className="px-3 py-2 text-xs text-foreground-muted">
              Choose up to 4 runs. The baseline stays selected.
            </p>
            <CollectionPagination {...runs} />
          </>
        }
        emptyContent={
          runs.isLoading ? "Loading runs…" : "No matching eval runs"
        }
      />
      {runs.error ? (
        <ErrorState error={runs.error} onRetry={runs.refresh} />
      ) : null}
    </div>
  )
}
