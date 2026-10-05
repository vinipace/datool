"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { TextSearchInput } from "@/components/ui/datool/search-bar/text-search-input"
import {
  CollectionDisplaySkeleton,
  CollectionTableSkeleton,
} from "@/components/ui/collection-skeleton"
import { CollectionHeaderControls, HeaderSlot } from "./collection-header"
import { CollectionHeaderContext } from "./collection-header-context"
import { CollectionPagination } from "./collection-pagination"
import { ErrorState } from "./primitives"
import { TableViewControls } from "./table-view-controls"
import type { PageViewCollectionData } from "./page-view-surface-context"
import {
  CollectionSelectionActions,
  type CollectionSelection,
} from "./collection-selection-actions"

type CollectionPageProps = React.PropsWithChildren<{
  state: {
    data: unknown | null
    error: Error | null
    isLoading: boolean
    isRefreshing: boolean
    refresh: () => void
  }
  loadingLabel: string
  header?: Omit<
    React.ComponentProps<typeof CollectionHeaderControls>,
    "onRefresh" | "isRefreshing"
  >
  pagination?: React.ComponentProps<typeof CollectionPagination>
  pageRows?: unknown[]
  savedView?: React.ComponentProps<typeof TableViewControls>["savedView"]
  selection?: CollectionSelection
  toolbar?: React.ReactNode
  empty?: React.ReactNode
  isEmpty?: boolean
  className?: string
}>

/** Standard collection chrome. Resource pages retain their queries, rows and actions. */
export function CollectionPage({
  state,
  loadingLabel,
  header,
  pagination,
  pageRows,
  savedView,
  selection,
  toolbar,
  empty,
  isEmpty = false,
  className,
  children,
}: CollectionPageProps) {
  const { displayIconOnly } = React.useContext(CollectionHeaderContext)
  const pageData = React.useMemo<PageViewCollectionData>(() => {
    const collection = state.data as { items?: unknown[]; total?: number } | null
    return {
      rows: pageRows ?? header?.exportRows ?? (Array.isArray(state.data) ? state.data : collection?.items ?? []),
      total: collection?.total ?? null,
      isLoading: state.isLoading, isRefreshing: state.isRefreshing,
      error: state.error?.message ?? pagination?.loadMoreError?.message ?? null,
      hasMore: pagination?.canLoadMore ?? false, isLoadingMore: pagination?.isLoadingMore ?? false,
      refresh: state.refresh, loadMore: pagination?.loadMore,
    }
  }, [state.data, state.isLoading, state.isRefreshing, state.error, state.refresh, pageRows, header?.exportRows, pagination])
  const hasData = state.data != null
  const showContent = hasData || (!state.isLoading && !state.error)
  return (
    <div
      className={cn(
        "flex h-full min-h-0 w-full flex-col bg-surface-canvas p-2 text-foreground",
        className
      )}
    >
      <TableViewControls savedView={savedView} pageData={pageData}>
        {selection && (
          <HeaderSlot name="selection">
            <CollectionSelectionActions
              {...selection}
              exportName={header?.exportName}
            />
          </HeaderSlot>
        )}
        <CollectionHeaderControls
          {...header}
          onRefresh={state.refresh}
          isRefreshing={state.isRefreshing}
        />
        {toolbar && <div className="shrink-0">{toolbar}</div>}
        {state.error && (
          <div role="alert" className="shrink-0">
            <ErrorState error={state.error} onRetry={state.refresh} />
          </div>
        )}
        {state.isLoading && !hasData && (
          <>
            <HeaderSlot name="display">
              <CollectionDisplaySkeleton iconOnly={displayIconOnly} />
            </HeaderSlot>
            <CollectionTableSkeleton label={loadingLabel} />
          </>
        )}
        {showContent && (isEmpty && empty != null ? <>
          {empty}
          <div className="hidden">{children}</div>
        </> : children)}
        {showContent && pagination && (
          <div className="shrink-0">
            <CollectionPagination {...pagination} />
          </div>
        )}
      </TableViewControls>
    </div>
  )
}

/** Plain-text search for local collections; structured filters use CollectionFilterBar. */
export function CollectionSearch({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <TextSearchInput
      label={label}
      placeholder={`${label}…`}
      value={value}
      onChange={onChange}
    />
  )
}
