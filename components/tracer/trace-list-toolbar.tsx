"use client"
import { CollectionFilterBar } from "./collection-filter"
import { CollectionHeaderControls } from "./collection-header"
import { TRACE_FIXED_FILTERS } from "./trace-list-utils"

type TraceListToolbarProps = {
  isRefreshing: boolean
  onDownloadCsv: () => void
  onDownloadJson: () => void
  onQueryChange: (value: string) => void
  onRefresh: () => void
  filterError: string | null
  query: string
}

export function TraceListToolbar(props: TraceListToolbarProps) {
  return (
    <CollectionHeaderControls onRefresh={props.onRefresh} isRefreshing={props.isRefreshing} onExportJson={props.onDownloadJson} onExportCsv={props.onDownloadCsv}>
      <CollectionFilterBar resource="traces" fixedFilters={TRACE_FIXED_FILTERS} value={props.query} onChange={props.onQueryChange} error={props.filterError} isLoading={props.isRefreshing} />
    </CollectionHeaderControls>
  )
}
