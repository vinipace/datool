"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"

export type CollectionScrollState = {
  canLoadMore: boolean
  isLoading: boolean
  isLoadingMore: boolean
  isRefreshing: boolean
  /** Includes silent polling so an intersecting sentinel retries after it settles. */
  isFetching?: boolean
  error: Error | null
  loadMoreError: Error | null
  loadMore: () => void
  refresh: () => void
}

/** Observes the end of the loaded rows inside their own scroll viewport. */
export function CollectionScrollBoundary({
  scrollRef,
  state,
  label,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  state: CollectionScrollState
  label: string
}) {
  const target = React.useRef<HTMLDivElement>(null)
  const {
    canLoadMore,
    isLoading,
    isLoadingMore,
    isRefreshing,
    error,
    loadMoreError,
  } = state
  const isFetching = state.isFetching ?? isRefreshing
  const loadNext = React.useEffectEvent(state.loadMore)

  React.useEffect(() => {
    if (
      !canLoadMore ||
      isLoading ||
      isLoadingMore ||
      isFetching ||
      error ||
      loadMoreError
    )
      return
    const root = scrollRef.current
    const sentinel = target.current
    if (!root || !sentinel) return
    let requested = false
    const observer = new IntersectionObserver(
      (entries) => {
        if (!requested && entries.some((entry) => entry.isIntersecting)) {
          requested = true
          loadNext()
        }
      },
      { root, rootMargin: "0px 0px 200px 0px" }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [
    canLoadMore,
    isLoading,
    isLoadingMore,
    isFetching,
    error,
    loadMoreError,
    scrollRef,
  ])

  const failure = loadMoreError ?? error
  if (failure)
    return (
      <div
        role="alert"
        className="flex items-center gap-2 px-3 py-2 text-xs text-destructive"
      >
        <span>
          Could not load {label}. {failure.message}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={loadMoreError ? state.loadMore : state.refresh}
        >
          Retry
        </Button>
      </div>
    )

  return (
    <div ref={target} className="min-h-px">
      {isLoading || isLoadingMore ? (
        <div role="status" className="px-3 py-2 text-xs text-foreground-muted">
          Loading {label}…
        </div>
      ) : null}
    </div>
  )
}
