"use client"

import * as React from "react"
import {
  ArrowLeft,
  ChevronRight,
  Copy,
  FileText,
  RefreshCw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/ui/loading-state"
import { Notice } from "@/components/ui/notice"
import { InspectorSection } from "@/components/ui/inspector-section"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { StructuredValueView } from "@/components/ui/structured-value-view"
import { CollectionSearch } from "@/components/tracer/collection-page"
import { useRemote } from "@/components/tracer/hooks"
import { useCollectionPages } from "@/components/tracer/use-collection-pages"
import { InfiniteScroll } from "@/components/tracer/infinite-scroll"
import type { CollectionListOptions } from "@/components/tracer/api"
import { collectionTable } from "@/components/tracer/collection-table-styles"
import { buildCall, buildOperations } from "../shared/build-api"
import type {
  KnowledgePage,
  KnowledgePageDetail,
  KnowledgePageList,
  KnowledgeSourceStatus,
} from "@/src/lib/build/knowledge"

function pagePath(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

export function KnowledgePages({
  sourceId,
  sourceStatus,
  settings,
}: {
  sourceId: string
  sourceStatus: KnowledgeSourceStatus
  settings: React.ReactNode
}) {
  const [search, setSearch] = React.useState("")
  const [query, setQuery] = React.useState("")
  const pageTrigger = React.useRef<HTMLButtonElement | null>(null)
  const viewport = React.useRef<HTMLDivElement | null>(null)
  const [selected, setSelected] = React.useState<{
    page: KnowledgePage
    revision: number
  } | null>(null)
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim())
    }, 250)
    return () => clearTimeout(timer)
  }, [search])
  const list = React.useCallback(
    async ({ filter, cursor, limit, signal }: CollectionListOptions) => {
      const [expectedRevision, offset] = cursor
        ? cursor.split(":").map(Number)
        : [null, 0]
      const page = await buildCall<KnowledgePageList>(
        buildOperations.listKnowledgePages,
        { sourceId, search: filter, offset, limit },
        { signal }
      )
      if (expectedRevision !== null && page.revision !== expectedRevision)
        throw new Error(
          "The website index changed. Refresh the page list to continue."
        )
      const nextOffset = offset + page.items.length
      return {
        items: page.items.map((item) => ({
          ...item,
          id: item.url,
          revision: page.revision,
        })),
        nextCursor:
          nextOffset < page.filteredTotal
            ? `${page.revision}:${nextOffset}`
            : null,
        total: page.filteredTotal,
        sourceTotal: page.total,
        collectionKey: `${sourceId}:${filter ?? ""}`,
      }
    },
    [sourceId]
  )
  const state = useCollectionPages(list, query, 0, { shouldPoll: () => false })
  const collectionKey = `${sourceId}:${query}`
  const data = state.data?.collectionKey === collectionKey ? state.data : null
  const items = data ? state.items : []
  const loading = !data && !state.error

  return (
    <section
      aria-label="Indexed pages"
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 border-t border-border pt-5"
    >
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h3 className="flex-1 text-sm font-medium">Indexed pages</h3>
        {data ? (
          <span className="text-xs text-foreground-muted">
            {data.sourceTotal.toLocaleString()} pages
          </span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh indexed pages"
          loading={state.isRefreshing}
          onClick={() => {
            viewport.current?.scrollTo({ top: 0 })
            state.refresh()
          }}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      <search
        className="shrink-0"
        onKeyDown={(event) => {
          // This browser lives inside the source edit form. Searching must never
          // submit that form and enqueue a new index.
          if (event.key === "Enter" && event.target instanceof HTMLInputElement)
            event.preventDefault()
        }}
      >
        <CollectionSearch
          label="Search indexed pages"
          value={search}
          onChange={setSearch}
        />
      </search>
      {state.error ? (
        <Notice variant="error" role="alert">
          {state.error.message}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={state.refresh}
          >
            Try again
          </Button>
        </Notice>
      ) : null}
      <div
        key={collectionKey}
        ref={viewport}
        role="region"
        aria-label="Indexed page list"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {loading ? (
          <LoadingState compact label="Loading indexed pages" />
        ) : null}
        {items.length ? (
          <table className={collectionTable.table} aria-label="Indexed website pages">
            <thead className={collectionTable.head}>
              <tr>
                <th className={collectionTable.heading} scope="col">
                  Page
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((page) => (
                <tr key={page.url} className="bg-surface-row">
                  <td className={collectionTable.cell}>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto w-full justify-start gap-2 py-2 text-left"
                      onClick={(event) => {
                        pageTrigger.current = event.currentTarget
                        setSelected({ page, revision: page.revision })
                      }}
                    >
                      <FileText
                        aria-hidden
                        className="size-4 shrink-0 text-foreground-muted"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate" title={page.url}>
                          {pagePath(page.url)}
                        </span>
                        {page.title ? (
                          <span className="block truncate text-xs font-normal text-foreground-muted">
                            {page.title}
                          </span>
                        ) : null}
                      </span>
                      <ChevronRight
                        aria-hidden
                        className="size-4 shrink-0 text-foreground-muted"
                      />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : data ? (
          <p className="py-6 text-center text-sm text-foreground-muted">
            {query
              ? "No pages match your search."
              : sourceStatus === "error"
                ? "No pages indexed. Fix the source and reindex to try again."
                : sourceStatus === "pending"
                  ? "Waiting to start. Pages will appear after indexing finishes."
                  : sourceStatus === "indexing"
                    ? "Your source is being processed. Pages will appear after indexing finishes."
                    : "No pages indexed yet."}
          </p>
        ) : null}
        {data ? <InfiniteScroll {...state} itemLabel="pages" /> : null}
      </div>
      <div className="max-h-[50%] shrink-0 overflow-x-hidden overflow-y-auto">
        <InspectorSection label="Source settings" defaultOpen={false}>
          {settings}
        </InspectorSection>
      </div>
      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
      >
        <SheetContent
          className="sm:max-w-3xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            pageTrigger.current?.focus()
          }}
        >
          {selected ? (
            <KnowledgePageContent
              key={`${selected.revision}:${selected.page.url}`}
              sourceId={sourceId}
              page={selected.page}
              revision={selected.revision}
              onBack={() => setSelected(null)}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </section>
  )
}

function KnowledgePageContent({
  sourceId,
  page,
  revision,
  onBack,
}: {
  sourceId: string
  page: KnowledgePage
  revision: number
  onBack: () => void
}) {
  const state = useRemote(
    (signal) =>
      buildCall<KnowledgePageDetail>(
        buildOperations.getKnowledgePage,
        { sourceId, url: page.url, revision },
        { signal }
      ),
    [sourceId, page.url, revision]
  )
  const [copied, setCopied] = React.useState(false)
  const [copyError, setCopyError] = React.useState(false)
  return (
    <>
      <SheetHeader className="shrink-0 space-y-3 border-b border-border px-6 py-5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-fit"
          onClick={onBack}
        >
          <ArrowLeft className="size-4" />
          All indexed pages
        </Button>
        <SheetTitle className="pr-6 break-words">
          {page.title || pagePath(page.url)}
        </SheetTitle>
        <SheetDescription className="break-all">{page.url}</SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {state.isLoading ? (
          <LoadingState compact label="Loading page content" />
        ) : null}
        {state.error ? (
          <Notice variant="error" role="alert">
            {state.error.message}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={state.refresh}
            >
              Try again
            </Button>
          </Notice>
        ) : null}
        {state.data ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Markdown content</h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(state.data!.markdown)
                    setCopied(true)
                    setCopyError(false)
                  } catch {
                    setCopyError(true)
                  }
                }}
              >
                <Copy className="size-3.5" />
                {copied ? "Copied" : "Copy Markdown"}
              </Button>
            </div>
            {copyError ? (
              <Notice variant="error" role="alert">
                Could not copy. Select the content below to copy it manually.
              </Notice>
            ) : null}
            <p className="text-xs text-foreground-muted">
              {state.data.contentOrigin === "chunks"
                ? "Content from the active index. Overlapping retrieval chunks are combined below."
                : "Stored page content used by your agent. HTML pages are shown as extracted text."}
            </p>
            <div className="min-w-0 rounded-md border border-border bg-muted p-4 text-xs leading-6 [overflow-wrap:anywhere]">
              <StructuredValueView value={state.data.markdown} view="text" />
            </div>
          </div>
        ) : null}
      </div>
    </>
  )
}
