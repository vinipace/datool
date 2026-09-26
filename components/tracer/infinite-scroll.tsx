"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"

export type InfiniteScrollState = {
  canLoadMore: boolean
  isLoadingMore: boolean
  isFetching?: boolean
  loadMoreError: Error | null
  loadMore: () => void
}

/** Place inside the scroll viewport, after its rows (including virtual spacers). */
export function InfiniteScroll({
  canLoadMore,
  isLoadingMore,
  isFetching,
  loadMoreError,
  loadMore,
}: InfiniteScrollState) {
  const sentinel = React.useRef<HTMLDivElement>(null)
  const requestMore = React.useEffectEvent(loadMore)
  React.useEffect(() => {
    const element = sentinel.current
    if (
      !element ||
      !canLoadMore ||
      isLoadingMore ||
      isFetching ||
      loadMoreError
    )
      return
    let viewport = element.parentElement
    while (
      viewport &&
      !/(auto|scroll)/.test(getComputedStyle(viewport).overflowY)
    )
      viewport = viewport.parentElement
    const onScroll = () => {
      if (
        viewport &&
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
          200
      )
        requestMore()
    }
    // Virtual rows change height as they are measured. Catch reaching the end
    // before those measurements can move the sentinel out of view again.
    viewport?.addEventListener("scroll", onScroll, { passive: true })
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) requestMore()
      },
      { root: viewport, rootMargin: "0px 0px 200px 0px" }
    )
    observer.observe(element)
    return () => {
      observer.disconnect()
      viewport?.removeEventListener("scroll", onScroll)
    }
  }, [canLoadMore, isLoadingMore, isFetching, loadMoreError])

  return (
    <div ref={sentinel} className="min-h-px">
      {isLoadingMore ? (
        <p role="status" className="px-3 py-2 text-xs text-foreground-muted">
          Loading more traces…
        </p>
      ) : null}
      {loadMoreError ? (
        <Notice variant="error" role="alert">
          {loadMoreError.message}
          <Button size="sm" variant="outline" onClick={loadMore}>
            Retry loading traces
          </Button>
        </Notice>
      ) : null}
    </div>
  )
}
