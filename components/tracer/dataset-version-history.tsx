"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { tracerApi, type CollectionListOptions } from "./api"
import { useCollectionPages } from "./use-collection-pages"
import { CollectionPagination } from "./collection-pagination"
import { ErrorState, LoadingState } from "./primitives"
import { JsonCode } from "./json-code"
import { formatDate } from "./format"

const labels = {
  item_created: "Row created",
  item_updated: "Row updated",
  item_deleted: "Row deleted",
  settings_updated: "Dataset settings updated",
}

export function DatasetVersionHistory({ datasetId, onClose }: { datasetId: string; onClose: () => void }) {
  const list = React.useCallback((options: CollectionListOptions) => tracerApi.datasets.versions(datasetId, options), [datasetId])
  const page = useCollectionPages(list, "", 0)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const selected = page.items.find(item => item.id === selectedId) ?? page.items[0]
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="flex h-[min(42rem,90svh)] max-w-4xl flex-col overflow-hidden bg-background">
        <DialogHeader>
          <DialogTitle>Dataset version history</DialogTitle>
          <DialogDescription>Browse saved changes and compare previous values.</DialogDescription>
        </DialogHeader>
        {page.isLoading ? <LoadingState label="Loading version history" /> : page.error ? <ErrorState error={page.error} onRetry={page.refresh} /> : !selected ? (
          <p className="py-12 text-center text-sm text-foreground-muted">No changes recorded yet. Edits will appear here automatically.</p>
        ) : (
          <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
            <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
              {page.items.map(version => (
                <Button key={version.id} variant={version.id === selected.id ? "secondary" : "ghost"}
                  className="h-auto shrink-0 flex-col items-start gap-1 text-left" onClick={() => setSelectedId(version.id)}>
                  <span className="flex w-full justify-between gap-3 text-xs"><span>#{version.revision}</span><span className="font-mono">{version.id.slice(0, 8)}</span></span>
                  <span>{labels[version.kind]}</span>
                  <span className="text-xs text-foreground-muted">{formatDate(version.createdAt)}</span>
                </Button>
              ))}
              <CollectionPagination {...page} />
            </div>
            <div
              aria-label="Version changes"
              className="min-h-0 overflow-y-auto"
              role="region"
              tabIndex={0}
            >
              <p className="mb-3 text-xs text-foreground-muted">{selected.itemId ? `Row ${selected.itemId.slice(-8)}` : "Dataset details and schemas"}</p>
              {(["before", "after"] as const).map(side => (
                <section key={side} className="mb-4">
                  <h3 className="mb-2 text-sm font-medium">{side === "before" ? "Before" : "After"}</h3>
                  <pre className="overflow-x-auto rounded-md border border-border bg-muted p-3 text-xs whitespace-pre-wrap break-words">
                    <JsonCode text={JSON.stringify(selected[side], null, 2)} />
                  </pre>
                </section>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
