"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { tracerApi, type CollectionListOptions } from "./api"
import { CollectionPage } from "./collection-page"
import { CollectionPanel } from "./collection-panel"
import { TraceListTable } from "./trace-list-table"
import { DEFAULT_TRACE_LIST_COLUMNS } from "./trace-list-utils"
import { useCollectionPages } from "./use-collection-pages"
import { useWorkspaceHref } from "./workspace-path"

export function DatasetItemRuns({ itemId }: { itemId: string }) {
  const router = useRouter()
  const workspaceHref = useWorkspaceHref()
  const list = React.useCallback(
    (options: CollectionListOptions) =>
      tracerApi.traces.list({ ...options, datasetItemId: itemId }),
    [itemId]
  )
  const page = useCollectionPages(list, "")
  const [checkedIds, setCheckedIds] = React.useState<Set<string>>(
    () => new Set()
  )
  return (
    <CollectionPanel label="Dataset row runs">
      <CollectionPage
        className="contents"
        state={page}
        loadingLabel="Loading row runs"
        pagination={page}
        selection={{
          rows: page.items.filter((trace) => checkedIds.has(trace.id)),
          onClear: () => setCheckedIds(new Set()),
        }}
        header={{
          children: (
            <span className="text-xs text-foreground-muted">
              Traces for this row
            </span>
          ),
          exportRows: page.items,
          exportName: "dataset-row-runs",
        }}
        isEmpty={!page.items.length}
        empty={
          <p className="p-4 text-sm text-foreground-muted">
            No runs for this row yet.
          </p>
        }
      >
        <TraceListTable
          columns={DEFAULT_TRACE_LIST_COLUMNS}
          persistenceKey="dataset-item-runs"
          traces={page.items}
          selectedTraceId={null}
          checkedIds={checkedIds}
          onCheckedIdsChange={setCheckedIds}
          onOpenTrace={(traceId) =>
            router.push(workspaceHref(`/traces/${encodeURIComponent(traceId)}`))
          }
        />
      </CollectionPage>
    </CollectionPanel>
  )
}
