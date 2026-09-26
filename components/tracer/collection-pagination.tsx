"use client"

export function CollectionPagination({
  canLoadMore,
  isLoadingMore,
  loadMore,
  loadMoreError,
  isLive = true,
}: {
  isLive?: boolean
  canLoadMore: boolean
  isLoadingMore: boolean
  loadMore: () => void
  loadMoreError: Error | null
}) {
  if (isLive && !canLoadMore && !loadMoreError) return null

  return (
    <div className="flex items-center gap-3 px-3 py-2 text-xs text-foreground-muted">
      {!isLive && (
        <span>
          Live refresh paused while browsing history. Refresh to return to the
          newest page.
        </span>
      )}
      {canLoadMore ? (
        <button
          className="ml-auto rounded border px-3 py-1 hover:bg-muted disabled:opacity-50"
          onClick={loadMore}
          disabled={isLoadingMore}
        >
          {isLoadingMore ? "Loading…" : "Load more"}
        </button>
      ) : null}
      {loadMoreError ? <span role="alert">{loadMoreError.message}</span> : null}
    </div>
  )
}
