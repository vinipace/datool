"use client"
import { useEffect, useRef, useState } from "react"
import type { Evaluator } from "@/src/lib/tracer/contracts"
import { librarySelectionEvaluator } from "@/src/lib/tracer/scorer-libraries"

import { ScorerCombobox } from "@/components/ui/scorer-combobox"
import { LoadingState } from "@/components/ui/loading-state"
import { Notice } from "@/components/ui/notice"
import { Button } from "@/components/ui/button"
import { scorerTraceUrl } from "@/src/lib/tracer/scorer-traces"
import { tracerApi } from "./api"
import { useCollectionPages } from "./use-collection-pages"
import { useWorkspaceHref } from "./workspace-path"

/** Project-scoped catalog, pagination and creation destination shared by all callers. */
export function ScorerPicker({
  traceIds = [],
  ...props
}: {
  value: string[]
  onValueChange: (ids: string[]) => void
  disabled?: boolean
  maxSelected?: number
  className?: string
  showCreate?: boolean
  traceIds?: string[]
}) {
  const scorers = useCollectionPages(tracerApi.evaluators.list, "", 60_000)
  const href = useWorkspaceHref()
  const error = scorers.error ?? scorers.loadMoreError
  const [added, setAdded] = useState<Evaluator[]>([])
  const [pending, setPending] = useState(false)
  const [selectionError, setSelectionError] = useState("")
  const busy = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const select = async (ids: string[]) => {
    if (busy.current) return
    const libraryId = ids.find((id) => librarySelectionEvaluator(id))
    const evaluator = libraryId && librarySelectionEvaluator(libraryId)
    setSelectionError("")
    if (!evaluator) {
      props.onValueChange(ids)
      return
    }
    busy.current = true
    setPending(true)
    try {
      const scorer = await tracerApi.evaluators.useLibrary(evaluator)
      if (!mounted.current) return
      setAdded((items) => [
        ...items.filter((item) => item.id !== scorer.id),
        scorer,
      ])
      props.onValueChange([
        ...new Set(ids.map((id) => (id === libraryId ? scorer.id : id))),
      ])
      scorers.refresh()
    } catch (error) {
      if (mounted.current)
        setSelectionError(
          error instanceof Error ? error.message : "Unable to select scorer."
        )
    } finally {
      busy.current = false
      if (mounted.current) setPending(false)
    }
  }
  return (
    <>
      <ScorerCombobox
        {...props}
        scorers={[
          ...scorers.items,
          ...added.filter(
            (item) => !scorers.items.some((existing) => existing.id === item.id)
          ),
        ]}
        onValueChange={select}
        selecting={pending}
        loading={scorers.isLoading}
        error={Boolean(error)}
        createHref={href(scorerTraceUrl(traceIds))}
        popupStatus={
          <>
            {pending && <LoadingState compact label="Selecting scorer" />}
            {scorers.isLoading && (
              <LoadingState compact label="Loading scorers" />
            )}
            {error && (
              <Notice variant="error">
                {error.message}{" "}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={scorers.error ? scorers.refresh : scorers.loadMore}
                >
                  Retry
                </Button>
              </Notice>
            )}
            {scorers.canLoadMore && !error && (
              <Button
                type="button"
                size="sm"
                variant="ghost-muted"
                loading={scorers.isLoadingMore}
                onClick={scorers.loadMore}
              >
                More scorers
              </Button>
            )}
          </>
        }
      />
      {selectionError && (
        <Notice variant="error" role="alert">
          {selectionError}
        </Notice>
      )}
    </>
  )
}
