"use client"

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { ArrowLeft, MessageSquare, Paperclip } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Notice } from "@/components/ui/notice"
import {
  NavigationProvider,
  createMemoryNavigation,
  useNavigation,
} from "@/components/navigation/navigation"
import { ProjectScope } from "@/components/tracer/project-scope-context"
import { TraceReadApiContext } from "@/components/tracer/trace-data-context"
import { TraceInspector } from "@/components/tracer/trace-inspector"
import { createTraceDetailLoader } from "@/components/tracer/trace-detail-loader"
import { buildInspectorTree } from "@/components/tracer/trace-inspector-data"
import { TraceListTable } from "@/components/tracer/trace-list-table"
import { TraceListHistogram } from "@/components/tracer/trace-list-histogram"
import { DEFAULT_TRACE_LIST_COLUMNS } from "@/components/tracer/trace-list-utils"
import { CollectionPanel } from "@/components/tracer/collection-panel"
import { CollectionPage } from "@/components/tracer/collection-page"
import { CollectionFilterBar } from "@/components/tracer/collection-filter"
import { useCollectionFilter } from "@/components/tracer/use-collection-filter"
import type {
  ApiList,
  TraceOverview,
  TraceSummary,
} from "@/src/lib/tracer/contracts"
import { createMcpTraceReadApi } from "@/packages/chatgpt-trace-explorer/src/trace-api"
import {
  evidenceContent,
  type Evidence,
  type ExplorerHost,
  type ExplorerResult,
} from "@/packages/chatgpt-trace-explorer/src/host"

const inspectorSections = ["trace", "timeline", "evaluators"] as const
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

export function TraceExplorer({ host }: { host: ExplorerHost }) {
  const state = useSyncExternalStore(
    host.subscribe,
    host.getSnapshot,
    host.getSnapshot
  )
  return state.result ? (
    <ExplorerSession key={state.revision} host={host} initial={state.result} />
  ) : (
    <p
      role={state.error ? "alert" : "status"}
      className="p-4 text-sm text-foreground-muted"
    >
      {state.error ?? "Connecting to Datool…"}
    </p>
  )
}

function ExplorerSession({
  host,
  initial,
}: {
  host: ExplorerHost
  initial: ExplorerResult
}) {
  const prefix = `/p/${encodeURIComponent(initial.project.slug)}/traces`
  const navigation = useMemo(() => {
    const query = new URLSearchParams({ filter: initial.filter ?? "" })
    if (initial.trace) query.set("trace", initial.trace.id)
    return createMemoryNavigation(`${prefix}?${query}`, {
      origin: initial.origin ?? "https://www.trydatool.com",
      openExternal: host.openLink,
      accepts: (pathname) =>
        pathname === prefix || pathname.startsWith(`${prefix}/`),
    })
  }, [prefix, initial, host])
  const api = useMemo(() => createMcpTraceReadApi(host), [host])
  const scope = useMemo(
    () => ({ projectId: initial.project.id, organizationId: "oauth" }),
    [initial.project.id]
  )
  return (
    <NavigationProvider adapter={navigation}>
      <ProjectScope.Provider value={scope}>
        <TraceReadApiContext.Provider value={api}>
          <ExplorerContent host={host} initial={initial} api={api} />
        </TraceReadApiContext.Provider>
      </ProjectScope.Provider>
    </NavigationProvider>
  )
}

function ExplorerContent({
  host,
  initial,
  api,
}: {
  host: ExplorerHost
  initial: ExplorerResult
  api: ReturnType<typeof createMcpTraceReadApi>
}) {
  const navigation = useNavigation()
  const state = useSyncExternalStore(
    host.subscribe,
    host.getSnapshot,
    host.getSnapshot
  )
  const search = useCollectionFilter("traces", initial.filter ?? "")
  const listPath = `/p/${encodeURIComponent(initial.project.slug)}/traces`
  const selectedTraceId = navigation.pathname.startsWith(`${listPath}/`)
    ? decodeURIComponent(navigation.pathname.slice(listPath.length + 1))
    : navigation.searchParams.get("trace")
  const [page, setPage] = useState<ApiList<TraceSummary> | null>(
    initial.page ?? null
  )
  const [trace, setTrace] = useState<TraceOverview | null>(
    initial.trace ?? null
  )
  const displayedTrace = trace?.id === selectedTraceId ? trace : null
  const activeId =
    navigation.searchParams.get("span") ??
    (displayedTrace ? buildInspectorTree(displayedTrace).id : null)
  const activeSpan = displayedTrace?.spans.find((span) => span.id === activeId)
  const [selection, setSelection] = useState<{
    traceId: string | null
    ids: string[]
  }>({ traceId: selectedTraceId, ids: [] })
  const selected = selection.traceId === selectedTraceId ? selection.ids : []
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [openingTraceId, setOpeningTraceId] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [now] = useState(() => Date.now())
  const [error, setError] = useState<Error | null>(null)
  const [moreError, setMoreError] = useState<Error | null>(null)
  const [action, setAction] = useState<string | null>(null)
  const [status, setStatus] = useState("")
  const [narrow, setNarrow] = useState(true)
  const container = useRef<HTMLElement>(null)
  const listGeneration = useRef(0)
  const traceGeneration = useRef(0)
  const appliedFilter = useRef(initial.filter ?? "")
  const loader = useMemo(
    () =>
      displayedTrace
        ? createTraceDetailLoader(
            displayedTrace.id,
            undefined,
            api,
            displayedTrace
          )
        : null,
    [displayedTrace, api]
  )
  const opening = Boolean(selectedTraceId && selectedTraceId === openingTraceId)
  const busy = Boolean(action) || opening
  const traceIndex =
    page?.items.findIndex((item) => item.id === selectedTraceId) ?? -1

  useEffect(() => {
    if (!container.current) return
    const observer = new ResizeObserver(([entry]) =>
      setNarrow(entry.contentRect.width < 640)
    )
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])

  async function load(cursor?: string) {
    const generation = ++listGeneration.current
    if (cursor) setLoadingMore(true)
    else setLoading(true)
    setError(null)
    setMoreError(null)
    try {
      const next = await host.call<ApiList<TraceSummary>>("list_traces", {
        filter: search.filter,
        limit: 25,
        ...(cursor ? { cursor } : {}),
      })
      if (generation !== listGeneration.current) return
      setPage((current) =>
        cursor && current
          ? {
              ...next,
              items: [
                ...current.items,
                ...next.items.filter(
                  (item) => !current.items.some((row) => row.id === item.id)
                ),
              ],
            }
          : next
      )
      appliedFilter.current = search.filter
    } catch (error) {
      if (generation === listGeneration.current)
        (cursor ? setMoreError : setError)(new Error(errorMessage(error)))
    } finally {
      if (generation === listGeneration.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }
  useEffect(() => {
    if (
      selectedTraceId ||
      search.error ||
      (appliedFilter.current === search.filter && page)
    )
      return
    void load()
    // Collection filter owns the debounce and navigation state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.filter, search.error, selectedTraceId])

  useEffect(() => {
    if (!selectedTraceId || displayedTrace) return
    const generation = ++traceGeneration.current
    let active = true
    queueMicrotask(async () => {
      if (!active) return
      setOpeningTraceId(selectedTraceId)
      setError(null)
      try {
        const next = await api.overview(selectedTraceId, undefined, true)
        if (active && generation === traceGeneration.current) setTrace(next)
      } catch (error) {
        if (active && generation === traceGeneration.current)
          setError(new Error(errorMessage(error)))
      } finally {
        if (active && generation === traceGeneration.current)
          setOpeningTraceId(null)
      }
    })
    return () => {
      active = false
    }
  }, [selectedTraceId, displayedTrace, api, retry])

  function selectTrace(id: string | null, spanId: string | null = null) {
    const query = new URLSearchParams(navigation.searchParams.toString())
    if (id) query.set("trace", id)
    else {
      query.delete("trace")
      query.delete("span")
    }
    if (spanId) query.set("span", spanId)
    else query.delete("span")
    const href = `${listPath}?${query}`
    if (id && !selectedTraceId) navigation.router.push(href, { scroll: false })
    else navigation.router.replace(href, { scroll: false })
  }
  function closeTrace() {
    selectTrace(null)
  }
  function toggleActive() {
    if (!activeId) return
    setStatus("")
    setSelection({
      traceId: selectedTraceId,
      ids: selected.includes(activeId)
        ? selected.filter((id) => id !== activeId)
        : selected.length < 10
          ? [...selected, activeId]
          : selected,
    })
  }
  async function evidence(): Promise<Evidence> {
    if (!displayedTrace || !loader || !selected.length)
      throw new Error("Select spans first.")
    const signal = new AbortController().signal
    const spans = await Promise.all(
      selected.map((id) => {
        const summary = displayedTrace.spans.find((span) => span.id === id)
        if (!summary)
          throw new Error("The selected span is no longer in this trace.")
        return loader.span(summary, displayedTrace, signal)
      })
    )
    return { project: initial.project, trace: displayedTrace, spans }
  }
  async function perform(kind: "attach" | "ask" | "copy" | "clear") {
    setAction(kind)
    setError(null)
    setStatus("")
    try {
      if (kind === "clear") {
        if (state.canAttach) await host.attach(null)
        setSelection({ traceId: selectedTraceId, ids: [] })
        setStatus("Chat context cleared.")
      } else {
        const captured = await evidence()
        if (kind === "attach") {
          await host.attach(captured)
          setStatus("Selected span evidence added to chat.")
        }
        if (kind === "ask") {
          await host.investigate(captured)
          setStatus("Investigation sent to chat.")
        }
        if (kind === "copy") {
          await navigator.clipboard.writeText(
            evidenceContent(captured)
              .content.map((block) => block.text)
              .join("\n\n")
          )
          setStatus("Captured span evidence copied.")
        }
      }
    } catch (error) {
      setError(new Error(errorMessage(error)))
    } finally {
      setAction(null)
    }
  }

  return (
    <main
      ref={container}
      className="@container/page flex min-h-[520px] min-w-0 flex-col bg-background text-foreground"
    >
      <header className="flex min-w-0 items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-medium">
            Datool{" "}
            <span className="text-foreground-muted">/ Trace Explorer</span>
          </h1>
          <p className="mt-1 truncate text-xs text-foreground-muted">
            {initial.project.name} · Read-only connection
          </p>
        </div>
        {selectedTraceId && (
          <Button
            variant="ghost"
            size="sm"
            disabled={Boolean(action)}
            onClick={closeTrace}
          >
            <ArrowLeft />
            Traces
          </Button>
        )}
      </header>
      {(state.error || (selectedTraceId && error)) && (
        <Notice role="alert" variant="error">
          {state.error ?? error?.message}
        </Notice>
      )}
      {!selectedTraceId ? (
        <CollectionPanel label="Traces">
          <CollectionPage
            state={{
              data: page,
              error,
              isLoading: !page || loading,
              isRefreshing: loading,
              refresh: () => {
                void load()
              },
            }}
            loadingLabel="Loading traces"
            isEmpty={page?.items.length === 0}
            empty={
              <p className="p-4 text-sm text-foreground-muted">
                No traces match this filter.
              </p>
            }
            header={{
              showExport: false,
              children: (
                <CollectionFilterBar
                  resource="traces"
                  value={search.value}
                  onChange={search.onChange}
                  error={search.error}
                  isLoading={loading}
                />
              ),
            }}
            pagination={{
              canLoadMore: Boolean(page?.nextCursor),
              isLoadingMore: loadingMore,
              loadMore: () => {
                if (page?.nextCursor) void load(page.nextCursor)
              },
              loadMoreError: moreError,
            }}
          >
            {page && (
              <>
                <TraceListHistogram
                  now={now}
                  timeRange="all"
                  traces={page.items}
                />
                <TraceListTable
                  key={String(narrow)}
                  defaultView={narrow ? "cards" : "table"}
                  columns={DEFAULT_TRACE_LIST_COLUMNS}
                  traces={page.items}
                  selectedTraceId={selectedTraceId}
                  onOpenTrace={(id) => selectTrace(id)}
                />
              </>
            )}
          </CollectionPage>
        </CollectionPanel>
      ) : displayedTrace && loader ? (
        <>
          <div className="h-[min(720px,calc(100dvh-12rem))] min-h-[420px] min-w-0">
            <TraceInspector
              traceId={displayedTrace.id}
              mode="panel"
              loader={loader}
              refreshIntervalMs={0}
              sections={[...inspectorSections]}
              eagerTimeline
              initialSpanId={activeId ?? undefined}
              onSpanChange={(id) => selectTrace(displayedTrace.id, id)}
              onClose={closeTrace}
              onNavigate={(id) => selectTrace(id)}
              previousTraceId={
                traceIndex > 0 ? page?.items[traceIndex - 1]?.id : undefined
              }
              nextTraceId={
                traceIndex >= 0 ? page?.items[traceIndex + 1]?.id : undefined
              }
              action={
                activeSpan && (
                  <label className="flex items-center gap-2 text-xs text-foreground-muted">
                    <Checkbox
                      aria-label={`Include ${activeSpan.name}`}
                      checked={selected.includes(activeSpan.id)}
                      disabled={
                        busy ||
                        (!selected.includes(activeSpan.id) &&
                          selected.length >= 10)
                      }
                      onChange={toggleActive}
                    />
                    <span>Include span</span>
                  </label>
                )
              }
            />
          </div>
          <footer className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-3">
            <span className="mr-auto text-xs text-foreground-muted">
              {selected.length} of 10 spans selected
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || (!selected.length && !state.canAttach)}
              onClick={() => {
                void perform("clear")
              }}
            >
              Clear
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!selected.length || busy || !state.canAttach}
              loading={action === "attach"}
              onClick={() => {
                void perform("attach")
              }}
            >
              <Paperclip />
              Add to chat
            </Button>
            <Button
              size="sm"
              disabled={!selected.length || busy || !state.canMessage}
              loading={action === "ask"}
              onClick={() => {
                void perform("ask")
              }}
            >
              <MessageSquare />
              Investigate
            </Button>
            {(!state.canAttach || !state.canMessage) && (
              <Button
                variant="outline"
                size="sm"
                disabled={!selected.length || busy}
                onClick={() => {
                  void perform("copy")
                }}
              >
                Copy evidence
              </Button>
            )}
            {status && (
              <p role="status" className="w-full text-xs text-foreground-muted">
                {status}
              </p>
            )}
          </footer>
        </>
      ) : (
        <div className="p-4">
          <p role="status" className="text-sm text-foreground-muted">
            {opening ? "Opening trace…" : "Trace unavailable."}
          </p>
          {error && (
            <Button
              variant="outline"
              onClick={() => setRetry((current) => current + 1)}
            >
              Retry
            </Button>
          )}
        </div>
      )}
    </main>
  )
}
