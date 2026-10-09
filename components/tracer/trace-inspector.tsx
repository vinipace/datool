"use client"
import type { TraceViewDataMode } from "@/src/lib/tracer/trace-view-contract"

import { JsonCode } from "./json-code"
import { StructuredValueViewer } from "@/components/ui/structured-value-viewer"
import { RunningSpinner } from "@/components/ui/execution-status"
import { MessageTranscript } from "@/components/ui/message-transcript"
import { AnnotatableValue } from "./review-annotations"
import { useReviewAnnotations, useReviewAnnotationTab } from "./review-annotation-context"

import * as React from "react"
import { useDefaultLayout } from "react-resizable-panels"
import { ScorerIcon } from "./scorer-icon"
import { ReactTraceViews } from "./react-trace-views"
import { TraceViewPicker } from "./trace-view-picker"
import type { ReactView, ReactViewSummary } from "@/src/lib/tracer/react-views"
import { reactViewLibraryEvent } from "@/src/lib/tracer/react-view-preferences"
import { useProjectScope } from "./project-scope-context"
import { TraceTimeline, RunTraceTimeline } from "./trace-timeline"
import { Combobox } from "@/components/ui/combobox"
import { InspectorGroupMembership } from "./inspector-group-membership"
import Link from "next/link"
import {
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  ChartNoAxesColumn,
  Percent,
  Tags,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Code2,
  ExternalLink,
  Maximize2,
  Minimize2,
  ListTree,
  X,
} from "lucide-react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { cn } from "@/lib/utils"
import {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
} from "@/components/ui/hover-card"
import { getTraceIconKind } from "./trace-icon-kind"
import { SessionKindIcon, SpanKindIcon } from "./span-kind-icon"
import { EvalScoreCell } from "./eval-score-cell"
import { usageDisplay } from "./usage-display"
import { getTraceTags } from "./trace-list-utils"
import type {
  JsonObject,
  JsonValue,
  Session,
  Span,
  SpanOverview,
  TraceDetail,
  TraceOverview,
  TraceSummary,
  TraceScore,
  TraceStatus,
} from "@/src/lib/tracer/contracts"
import { tracerApi } from "./api"
import { createTraceDetailLoader, type TraceDetailLoader } from "./trace-detail-loader"
import { createSessionConversationLoader } from "./session-detail-loader"
import { Notice } from "@/components/ui/notice"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { PayloadSection as PayloadSectionFrame } from "@/components/ui/payload-section"
import { InspectorSection } from "@/components/ui/inspector-section"
import { InspectorTabs } from "@/components/ui/inspector-tabs"
import { formatDate } from "./format"
import { useCollectionPages } from "./use-collection-pages"
import { CollectionScrollBoundary, type CollectionScrollState } from "./collection-scroll-boundary"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { VirtualList } from "@/components/ui/virtual-list"
import { useRemote, useStoredChoice, useTraceSectionDisclosure } from "./hooks"
import { useWorkspaceHref } from "./workspace-path"
import {
  buildInspectorTree,
  flattenInspectorTree,
  flattenInspectorForest,
  flattenSessionTraces,
  inspectorNodeKey,
  compactRelativeTime,
  knownDuration,
  normaliseChatMessages,
  normaliseOutputMessages,
  toReadableJson,
  type InspectorTreeNode,
  type InspectorTreeRow,
} from "./trace-inspector-data"

type InspectorMode = "overlay" | "page" | "panel"
type InspectorTab = "trace" | "evaluators" | "timeline" | "views"
type DetailTab = "messages" | "details" | "metadata" | "raw"
const DETAIL_TAB_STORAGE_KEY = "datool:trace-inspector:detail-tab"

const CustomColumnDetailsContext = React.createContext<React.ReactNode>(null)
const TraceViewLibraryContext = React.createContext<{
  onOpenView: (view: ReactViewSummary) => void
  onCreateView: () => void
} | null>(null)
type OpenTraceView = { key: string; viewId: string | null; name: string }

export interface TraceInspectorProps {
  snapshot?: TraceDetail
  customColumnDetails?: React.ReactNode
  initialSpanId?: string
  initialObjectViewId?: string
  initialTab?: InspectorTab
  compactHeader?: boolean
  hideTraceNavigation?: boolean
  hideOverviewScores?: boolean
  mode?: InspectorMode
  nextTraceId?: string
  onClose?: () => void
  onToggleMaximize?: () => void
  hideExpandControl?: boolean
  maximized?: boolean
  onNavigate?: (traceId: string) => void
  onSpanChange?: (spanId: string | null) => void
  previousTraceId?: string
  traceId: string
}

export function TraceInspector({ traceId, ...props }: TraceInspectorProps) {
  // A keyed session deliberately discards retained polling data when paging to
  // another trace. `useRemote` otherwise keeps the previous response during a
  // refresh, which would make the next trace briefly show stale content.
  return (
    <CustomColumnDetailsContext.Provider value={props.customColumnDetails}>
      <TraceInspectorSession key={traceId} traceId={traceId} {...props} />
    </CustomColumnDetailsContext.Provider>
  )
}

/** A run can emit independent traces. Keep their roots and payloads separate. */
export function RunTraceInspector({ traces, evalRunId }: { traces: TraceOverview[]; evalRunId?: string }) {
  const [selection, setSelection] = React.useState<{ traceId: string; spanId: string | null } | null>(null)
  const [activeTab, selectTab] = useStoredChoice<InspectorTab>(
    "datool:playground:inspector-tab", ["trace", "evaluators", "timeline", "views"], "trace"
  )
  const href = useWorkspaceHref()
  const trace = traces.find(trace => trace.id === selection?.traceId) ?? traces[0]
  const selectedSpanId = trace && selection?.traceId === trace.id ? selection.spanId : trace ? buildInspectorTree(trace).id : null
  const loader = React.useMemo(() => createTraceDetailLoader(trace?.id ?? ""), [trace?.id])
  const spanCount = traces.reduce((count, trace) => count + trace.spans.length, 0)
  const select = (traceId: string, spanId: string | null) => setSelection({ traceId, spanId })
  if (!trace) return <InspectorPlaceholder label="Waiting for captured traces…" />
  return <InspectorFrame mode="panel" title="Run result" hideTraceNavigation
    activeTab={activeTab} onTabChange={selectTab} trace={trace} traceId={trace.id} selectedSpanId={selectedSpanId} viewLoader={loader}
    summary={<>{traces.length} {traces.length === 1 ? "trace" : "traces"} · {spanCount} {spanCount === 1 ? "span" : "spans"}</>}
    action={evalRunId ? <Button asChild variant="ghost-muted" size="sm"><Link href={href(`/evals/${encodeURIComponent(evalRunId)}`)}>Experiment</Link></Button> : undefined}>
    {activeTab === "views" && traces.length > 1 && <div className="border-b border-border px-3 py-2">
      <Combobox label="Trace for custom view" value={trace.id} options={traces.map(item => ({ value: item.id, label: item.name, description: item.id }))}
        onValueChange={id => select(id, null)} />
    </div>}
    {activeTab === "trace" || activeTab === "timeline" ? <TraceWorkspace navigation={activeTab} hideOverviewScores={false} loader={loader} trace={trace}
      selectedSpanId={selectedSpanId} onSelectSpan={spanId => select(trace.id, spanId)}
      timeline={onNavigate => <RunTraceTimeline traces={traces} selectedTraceId={trace.id} selectedSpanId={selectedSpanId}
        onSelect={(...selection) => { select(...selection); onNavigate() }} />}
      navigator={onNavigate => <ForestNavigator traces={traces} selectedTraceId={trace.id} selectedSpanId={selectedSpanId}
        onSelect={(...selection) => { select(...selection); onNavigate() }} />} />
      : activeTab === "evaluators" ? <EvaluatorWorkspace scores={traces.flatMap(item => item.scores)} />
      : <FullTraceViews key={trace.id} trace={trace} loader={loader} />}
  </InspectorFrame>
}

function ForestNavigator({ traces, selectedTraceId, selectedSpanId, onSelect }: {
  traces: TraceOverview[]
  selectedTraceId: string
  selectedSpanId: string | null
  onSelect: (traceId: string, spanId: string | null) => void
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set())
  const rows = React.useMemo(() => flattenInspectorForest(traces, collapsed), [traces, collapsed])
  return <HoverCard<InspectorTreeNode>>{({ payload }) => {
    const hovered = payload ? rows.find(row => row.node === payload) : null
    return <>
      <VirtualList items={rows} itemKey={row => row.key} scrollRef={scrollRef} label="Run trace hierarchy">
        {({ key, ...row }) => <TreeNodeRow key={key} {...row} selectedSpanId={selectedTraceId === row.trace.id ? selectedSpanId : undefined}
          onSelectSpan={spanId => onSelect(row.trace.id, spanId)} toggle={() => {
            const key = inspectorNodeKey(row.trace.id, row.node.id)
            setCollapsed(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })
          }} />}
      </VirtualList>
      {hovered && <HoverCardContent side="left" align="start"><SpanHoverSummary node={hovered.node} trace={hovered.trace} /></HoverCardContent>}
    </>
  }}</HoverCard>
}

/** A session is a navigation root, never a fabricated persisted trace or span. */
export function SessionTraceInspector({ session, traces, initialTraceId, initialSpanId, onSelect }: {
  session: Session
  traces: TraceOverview[]
  initialTraceId?: string
  initialSpanId?: string
  onSelect: (traceId: string | null, spanId: string | null) => void
}) {
  const queryKey = JSON.stringify([initialTraceId, initialSpanId])
  const [selection, setSelection] = React.useState({ queryKey, traceId: initialTraceId, spanId: initialSpanId ?? null })
  const selected = selection.queryKey === queryKey ? selection : { traceId: initialTraceId, spanId: initialSpanId ?? null }
  const trace = traces.find(item => item.id === selected.traceId)
  const spanId = trace?.spans.some(span => span.id === selected.spanId) ? selected.spanId : null
  const [activeTab, selectTab] = useStoredChoice<InspectorTab>(
    "datool:session:inspector-tab", ["trace", "evaluators", "timeline", "views"], "trace"
  )
  const loader = React.useMemo(() => createTraceDetailLoader(trace?.id ?? ""), [trace?.id])
  const select = (traceId: string | null, spanId: string | null) => {
    setSelection({ queryKey, traceId: traceId ?? undefined, spanId })
    onSelect(traceId, spanId)
  }
  const query = new URLSearchParams()
  if (trace) query.set("trace", trace.id)
  if (spanId) query.set("span", spanId)
  const path = `/sessions/${encodeURIComponent(session.id)}`
  const overview = <SessionOverview key={session.id} session={session} traces={traces} />

  return <InspectorFrame mode="page" title="Session" hideTraceNavigation
    activeTab={activeTab} onTabChange={selectTab} trace={trace ?? null} traceId={trace?.id ?? session.id} selectedSpanId={spanId} viewLoader={loader}
    fullPagePath={query.size ? `${path}?${query}` : path} backLink={{ href: "/sessions", label: "All sessions" }}
    summary={<>{traces.length} traces · {traces.reduce((count, item) => count + item.spans.length, 0)} spans</>}>
    {activeTab === "trace" || activeTab === "timeline" ? <TraceWorkspace navigation={activeTab} hideOverviewScores={false}
      loader={loader} trace={trace} selectedSpanId={spanId} onSelectSpan={id => trace && select(trace.id, id)}
      details={trace ? undefined : overview}
      navigator={onNavigate => <SessionNavigator session={session} traces={traces} selectedTraceId={trace?.id} selectedSpanId={spanId}
        onSelect={(...selection) => { select(...selection); onNavigate() }} />}
      timeline={onNavigate => <RunTraceTimeline traces={traces} selectedTraceId={trace?.id ?? ""} selectedSpanId={spanId}
        onSelect={(...selection) => { select(...selection); onNavigate() }} />} />
      : activeTab === "evaluators" ? <EvaluatorWorkspace scores={(trace ? [trace] : traces).flatMap(item => item.scores)} />
      : <>
        <div className="border-b border-border px-3 py-2">
          <Combobox label="Trace for custom view" value={trace?.id ?? ""}
            options={traces.map(item => ({ value: item.id, label: item.name, description: item.id }))}
            onValueChange={id => select(id, null)} />
        </div>
        {trace ? <FullTraceViews key={trace.id} trace={trace} loader={loader} /> : overview}
      </>}
  </InspectorFrame>
}

function SessionOverview({ session, traces }: { session: Session; traces: TraceOverview[] }) {
  const [detailTab, selectDetailTab] = useStoredChoice<DetailTab>(
    DETAIL_TAB_STORAGE_KEY, ["messages", "details", "metadata", "raw"], "messages"
  )
  const loader = React.useMemo(() => createSessionConversationLoader(), [])
  const load = React.useCallback((signal: AbortSignal) => loader(traces, signal), [loader, traces])
  const { data: messages, error, isLoading, refresh } = useRemote(load, [], {
    enabled: detailTab === "messages", keepPreviousData: true,
  })
  return <div className="min-h-full px-3 pb-6">
    <div className="flex items-start gap-2 py-3"><SessionKindIcon /><h2 className="min-w-0 break-words text-lg font-semibold">{session.name ?? "Untitled session"}</h2></div>
    <DetailTabs value={detailTab} onChange={selectDetailTab} />
    {detailTab === "messages" && <section aria-label="Session conversation" aria-busy={isLoading} className="border-t border-border py-3">
      {error && <Notice variant="error" role="alert">Could not load the complete conversation. {error.message} <Button variant="outline" size="sm" onClick={refresh}>Retry</Button></Notice>}
      {isLoading && !messages && <InspectorPlaceholder label="Loading session conversation…" />}
      {messages?.length ? <MessageTranscript messages={messages} /> : !isLoading && !error && <p className="text-sm text-foreground-muted">{traces.length ? "No conversation messages were captured in this session." : "No traces are linked to this session yet."}</p>}
    </section>}
    {detailTab === "details" && <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 border-t border-border py-3 text-sm">
      <dt className="text-foreground-muted">Session ID</dt><dd className="break-all font-mono text-xs">{session.id}</dd>
      <dt className="text-foreground-muted">Traces</dt><dd>{traces.length}</dd>
      <dt className="text-foreground-muted">Created</dt><dd>{formatDate(session.createdAt)}</dd>
      <dt className="text-foreground-muted">Updated</dt><dd>{formatDate(session.updatedAt)}</dd>
    </dl>}
    {detailTab === "metadata" && <section className="space-y-2 border-t border-border pt-3">
      <h3 className="text-sm font-medium">Session attributes</h3>
      <StructuredValueViewer label="Session attributes" value={session.attributes} />
    </section>}
    {detailTab === "raw" && <div className="border-t border-border pt-3"><JsonPayload value={session} /></div>}
  </div>
}

function SessionNavigator({ session, traces, selectedTraceId, selectedSpanId, onSelect }: {
  session: Session
  traces: TraceOverview[]
  selectedTraceId?: string
  selectedSpanId: string | null
  onSelect: (traceId: string | null, spanId: string | null) => void
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set())
  const [rootCollapsed, setRootCollapsed] = React.useState(false)
  const children = React.useMemo(() => flattenSessionTraces(traces, collapsed), [traces, collapsed])
  const root: InspectorTreeNode = { id: null, span: null, depth: 0, children: children.filter(row => row.node.depth === 1).map(row => row.node) }
  const rows = [
    { key: "session", node: root, isLastChild: true, continuingDepths: [], trace: null },
    ...(rootCollapsed ? [] : children),
  ]
  return <HoverCard<InspectorTreeNode>>{({ payload }) => {
    const hovered = payload ? children.find(row => row.node === payload) : null
    return <>
      <VirtualList items={rows} itemKey={row => row.key} scrollRef={scrollRef} label="Session trace hierarchy">
        {({ key, ...row }) => row.trace ? <TreeNodeRow key={key} {...row} trace={row.trace}
          collapsed={row.collapsed}
          selectedSpanId={selectedTraceId === row.trace.id ? selectedSpanId : undefined}
          onSelectSpan={id => onSelect(row.trace!.id, id)} toggle={() => {
            const key = inspectorNodeKey(row.trace!.id, row.node.id)
            setCollapsed(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })
          }} /> : <TreeNodeRow key={key} {...row} trace={session}
            collapsed={new Set(rootCollapsed ? ["__trace__"] : [])}
            selectedSpanId={selectedTraceId ? undefined : null} onSelectSpan={() => onSelect(null, null)}
            toggle={() => setRootCollapsed(value => !value)} />}
      </VirtualList>
      {hovered && <HoverCardContent side="left" align="start"><SpanHoverSummary node={hovered.node} trace={hovered.trace} /></HoverCardContent>}
    </>
  }}</HoverCard>
}

function TraceInspectorSession(props: TraceInspectorProps) {
  const loader = React.useMemo(() => createTraceDetailLoader(props.traceId, props.snapshot), [props.traceId, props.snapshot])
  const listScores = React.useCallback(
    (options: import("./api").CollectionListOptions) =>
      props.snapshot
        ? Promise.resolve({
            items: props.snapshot.scores.map((score, index) => ({
              ...score,
              id: score.evalResultId ?? String(index),
            })),
            total: props.snapshot.scores.length,
            nextCursor: null,
          })
        : tracerApi.traces.scores(props.traceId, options),
    [props.snapshot, props.traceId]
  )
  const scorePage = useCollectionPages(
    listScores,
    "",
    props.snapshot ? 0 : 3000
  )
  const load = React.useCallback(
    (signal: AbortSignal) => loader.overview(signal),
    [loader]
  )
  const {
    data: trace,
    error,
    isLoading,
    refresh,
  } = useRemote(load, [props.traceId], { intervalMs: props.snapshot ? 0 : 3_000 })
  const [storedTab, selectStoredTab] = useStoredChoice<InspectorTab>(
    "datool:trace-inspector:tab",
    ["trace", "evaluators", "timeline", "views"],
    "trace"
  )
  const [annotationTab, selectAnnotationTab] = useReviewAnnotationTab(storedTab, selectStoredTab, "trace")
  const [requestedTab, setRequestedTab] = React.useState<InspectorTab | null>(props.initialObjectViewId ? "views" : props.initialTab ?? null)
  const activeTab = requestedTab ?? annotationTab
  const selectTab = (tab: InspectorTab) => { setRequestedTab(null); selectAnnotationTab(tab) }

  if (isLoading && !trace) {
    return (
      <InspectorFrame
        activeTab={activeTab}
        onTabChange={selectTab}
        selectedSpanId={null}
        trace={null}
        {...props}
      >
        <TraceInspectorSkeleton />
      </InspectorFrame>
    )
  }

  if (!trace) {
    return (
      <InspectorFrame
        activeTab={activeTab}
        onTabChange={selectTab}
        selectedSpanId={null}
        trace={null}
        {...props}
      >
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="max-w-md rounded-lg border border-destructive-border bg-destructive-background p-4 text-sm text-foreground">
            <div className="flex items-start gap-2">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">This trace could not be loaded.</p>
                <p className="mt-1 text-destructive/80">
                  {error?.message ??
                    "No trace data was returned."}
                </p>
                <button
                  className="mt-3 rounded-md border border-destructive-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-destructive/10"
                  onClick={() => {
                    refresh()
                  }}
                  type="button"
                >
                  Retry
                </button>
              </div>
            </div>
          </div>
        </div>
      </InspectorFrame>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error ? <Notice role="alert" variant="error">Could not refresh this trace. {error.message} <Button variant="outline" size="sm" onClick={refresh}>Retry</Button></Notice> : null}
      <LoadedInspector
        loader={loader}
        scorePage={scorePage}
        activeTab={activeTab}
        onTabChange={selectTab}
        trace={{
          ...trace,
          scores: scorePage.items,
        }}
        {...props}
      />
    </div>
  )
}

function LoadedInspector({
  loader,
  scorePage,
  activeTab,
  hideOverviewScores = false,
  initialSpanId,
  onSpanChange,
  onTabChange,
  trace,
  ...props
}: TraceInspectorProps & {
  loader: TraceDetailLoader
  scorePage: CollectionScrollState
  activeTab: InspectorTab
  onTabChange: (tab: InspectorTab) => void
  trace: TraceOverview
}) {
  const validInitialSpanId = trace.spans.some(
    (span) => span.id === initialSpanId
  )
  const annotationFocus = useReviewAnnotations()?.focus ?? null
  const [selection, setSelection] = React.useState({
    focus: annotationFocus,
    initialSpanId,
    spanId: annotationFocus ? annotationFocus.reference.spanId : validInitialSpanId && initialSpanId ? initialSpanId : null,
  })
  const rootSpanId = React.useMemo(() => buildInspectorTree(trace).id, [trace])
  const selectedSpanId = (annotationFocus && annotationFocus !== selection.focus
    ? annotationFocus.reference.spanId
    : selection.initialSpanId === initialSpanId ? selection.spanId
    : validInitialSpanId ? initialSpanId : null) ?? rootSpanId
  const selectSpan = React.useCallback(
    (spanId: string | null) => {
      setSelection({ initialSpanId, spanId, focus: annotationFocus })
      onSpanChange?.(spanId)
    },
    [initialSpanId, onSpanChange, annotationFocus]
  )

  return (
    <InspectorFrame
      activeTab={activeTab}
      onTabChange={onTabChange}
      selectedSpanId={selectedSpanId}
      trace={trace}
      {...props}
      viewLoader={loader}
    >
      {activeTab === "trace" || activeTab === "timeline" ? (
        <TraceWorkspace
          navigation={activeTab}
          hideOverviewScores={hideOverviewScores}
          loader={loader}
          onSelectSpan={selectSpan}
          selectedSpanId={selectedSpanId}
          trace={trace}
        />
      ) : activeTab === "evaluators" ? (
        <EvaluatorWorkspace scores={trace.scores} pagination={scorePage} />
      ) : (
        <FullTraceViews trace={trace} loader={loader} />
      )}
    </InspectorFrame>
  )
}

function InspectorFrame({
  activeTab,
  children,
  mode = "overlay",
  hideTraceNavigation = false,
  compactHeader = false,
  nextTraceId,
  onClose,
  onToggleMaximize,
  hideExpandControl = false,
  maximized = false,
  onNavigate,
  onTabChange,
  previousTraceId,
  selectedSpanId,
  trace,
  traceId,
  title = "Trace",
  summary,
  action,
  initialObjectViewId,
  viewLoader,
  fullPagePath,
  backLink = { href: "/traces", label: "All traces" },
}: React.PropsWithChildren<
  Omit<TraceInspectorProps, "initialSpanId" | "onSpanChange"> & {
    title?: string
    summary?: React.ReactNode
    action?: React.ReactNode
    fullPagePath?: string
    backLink?: { href: string; label: string }
    activeTab: InspectorTab
    onTabChange: (tab: InspectorTab) => void
    selectedSpanId: string | null
    trace: TraceOverview | null
    viewLoader?: TraceDetailLoader
  }
>) {
  const [viewTabs, setViewTabs] = React.useState<{ tabs: OpenTraceView[]; active: string | null }>(() => ({
    tabs: initialObjectViewId ? [{ key: `view:${initialObjectViewId}`, viewId: initialObjectViewId, name: "View" }] : [],
    active: initialObjectViewId ? `view:${initialObjectViewId}` : null,
  }))
  const [tabActionsContainers, setTabActionsContainers] = React.useState<Record<string, HTMLDivElement>>({})
  const registerTabActionsContainer = React.useCallback((key: string, container: HTMLDivElement | null) => {
    setTabActionsContainers(current => {
      if ((current[key] ?? null) === container) return current
      const next = { ...current }
      if (container) next[key] = container
      else delete next[key]
      return next
    })
  }, [])
  const activateView = React.useCallback((key: string) => setViewTabs(current => ({ ...current, active: key })), [])
  const newViewCount = React.useRef(0)
  const annotationFocus = useReviewAnnotations()?.focus ?? null
  const [viewFocus, setViewFocus] = React.useState(annotationFocus)
  if (viewFocus !== annotationFocus) {
    setViewFocus(annotationFocus)
    setViewTabs(current => ({ ...current, active: null }))
  }
  const openView = React.useCallback((view: ReactViewSummary) => {
    setViewTabs(current => {
      const existing = current.tabs.find(tab => tab.viewId === view.id)
      const key = existing?.key ?? `view:${view.id}`
      return { tabs: existing ? current.tabs : [...current.tabs, { key, viewId: view.id, name: view.name }], active: key }
    })
  }, [])
  const projectId = useProjectScope()?.projectId
  React.useEffect(() => {
    if (!projectId || !viewLoader) return
    const selected = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.detail?.projectId !== projectId) return
      const view = event.detail?.view as ReactViewSummary | undefined
      if (view && (view.objectTypes ?? ["trace", "dataset-item"]).includes("trace")) openView(view)
    }
    window.addEventListener(reactViewLibraryEvent, selected)
    return () => window.removeEventListener(reactViewLibraryEvent, selected)
  }, [projectId, viewLoader, openView])
  const createView = React.useCallback(() => {
    const key = `new:${++newViewCount.current}`
    setViewTabs(current => ({ tabs: [...current.tabs, { key, viewId: null, name: "New view" }], active: key }))
  }, [])
  const closeView = React.useCallback((key: string) => {
    setViewTabs(current => {
      const index = current.tabs.findIndex(tab => tab.key === key)
      const tabs = current.tabs.filter(tab => tab.key !== key)
      return { tabs, active: current.active === key ? (tabs[index] ?? tabs[index - 1])?.key ?? null : current.active }
    })
  }, [])
  const updateView = React.useCallback((key: string, view: ReactView | null) => {
    if (!view) { closeView(key); return }
    setViewTabs(current => {
      const existing = current.tabs.find(tab => tab.key === key)
      if (!existing || (existing.viewId === view.id && existing.name === view.name)) return current
      return { ...current, tabs: current.tabs.map(tab => tab.key === key ? { ...tab, viewId: view.id, name: view.name } : tab) }
    })
  }, [closeView])
  const libraryControls = React.useMemo(() => ({ onOpenView: openView, onCreateView: createView }), [openView, createView])
  const [copyState, setCopyState] = React.useState<
    "copied" | "idle" | "failed"
  >("idle")
  const resetCopyTimer = React.useRef<number | null>(null)
  const workspaceHref = useWorkspaceHref()
  const fullPageHref = workspaceHref(fullPagePath ?? traceHref(traceId, selectedSpanId))
  const resourceName = title === "Session" ? "session" : "trace"

  React.useEffect(
    () => () => {
      if (resetCopyTimer.current !== null)
        window.clearTimeout(resetCopyTimer.current)
    },
    []
  )

  const copyLink = React.useCallback(async () => {
    const url = new URL(fullPageHref, window.location.origin).toString()
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable")
      await navigator.clipboard.writeText(url)
      setCopyState("copied")
    } catch {
      setCopyState("failed")
    }

    if (resetCopyTimer.current !== null)
      window.clearTimeout(resetCopyTimer.current)
    resetCopyTimer.current = window.setTimeout(
      () => setCopyState("idle"),
      1_800
    )
  }, [fullPageHref])

  return (
    <section
      aria-label={title}
      className={cn(
        "flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden border border-white/[0.12] bg-black text-foreground shadow-2xl shadow-black/40",
        mode === "panel"
          ? "h-full rounded-none border-0 shadow-none"
          : mode === "page"
            ? "h-[calc(100dvh-3rem)] rounded-none sm:h-[calc(100dvh-5rem)] sm:rounded-md"
            : "h-[calc(100dvh-24px)] max-h-full rounded-md"
      )}
    >
      <header className="shrink-0 border-b border-foreground bg-background">
        <div className={cn("flex items-center justify-between gap-3 px-3", compactHeader ? "min-h-8" : "min-h-11")}>
          <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
            {!hideTraceNavigation && <>
            <TraceNavigationButton
              direction="previous"
              onNavigate={onNavigate}
              traceId={previousTraceId}
            />
            <TraceNavigationButton
              direction="next"
              onNavigate={onNavigate}
              traceId={nextTraceId}
            />
            </>}
            <span className="ml-1 text-sm font-medium text-foreground">
              {title}
            </span>
            {title === "Trace" && <code className="max-w-28 truncate font-mono text-sm text-foreground-muted sm:max-w-none">
              {shortTraceId(traceId)}
            </code>}
            {trace && title === "Trace" ? (
              <span className="hidden shrink-0 text-sm whitespace-nowrap text-foreground-muted sm:inline">
                {compactRelativeTime(trace.startedAt).replace(/ ago$/, "")}
              </span>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {action}
            {hideExpandControl ? null : onToggleMaximize ? (
              <Button
                variant="ghost-muted"
                size="icon-sm"
                className="size-7"
                aria-label={maximized ? "Restore trace panel" : "Maximize trace"}
                title={maximized ? "Restore panel (Esc)" : "Maximize"}
                onClick={onToggleMaximize}
              >
                {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
              </Button>
            ) : mode === "page" ? (
              <Link
                aria-label={backLink.label}
                className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-foreground-muted transition-colors hover:bg-white/[0.07] hover:text-foreground"
                href={workspaceHref(backLink.href)}
              >
                <ArrowLeft className="size-3.5" />
                <span className="hidden sm:inline">{backLink.label}</span>
              </Link>
            ) : (
              <Link
                aria-label="Open trace full page"
                className="grid size-7 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-white/[0.07] hover:text-foreground"
                href={fullPageHref}
                title="Open full page"
              >
                <ExternalLink className="size-3.5" />
              </Link>
            )}
            <button
              aria-label={
                copyState === "failed"
                  ? `Unable to copy ${resourceName} link`
                  : `Copy ${resourceName} link`
              }
              className="grid size-7 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-white/[0.07] hover:text-foreground"
              onClick={() => void copyLink()}
              title={
                copyState === "copied"
                  ? `Copied ${resourceName} link`
                  : copyState === "failed"
                    ? "Clipboard unavailable"
                    : `Copy ${resourceName} link`
              }
              type="button"
            >
              {copyState === "copied" ? (
                <Check className="size-3.5 text-success" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </button>
            {onClose ? (
              <button
                aria-label="Close trace inspector"
                className="grid size-7 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-white/[0.07] hover:text-foreground"
                onClick={onClose}
                title="Close"
                type="button"
              >
                <X className="size-4" />
              </button>
            ) : null}
          </div>
        </div>

        <InspectorTabs<string>
          label="Trace inspector sections"
          value={viewTabs.active ?? activeTab}
          onValueChange={tab => {
            if (viewTabs.tabs.some(view => view.key === tab)) setViewTabs(current => ({ ...current, active: tab }))
            else { setViewTabs(current => ({ ...current, active: null })); onTabChange(tab as InspectorTab) }
          }}
          onActionsContainerChange={registerTabActionsContainer}
          tabs={[
            { value: "trace", label: "Trace", icon: ListTree },
            { value: "evaluators", label: "Evaluators", icon: ScorerIcon },
            { value: "timeline", label: "Timeline", icon: Clock3 },
            { value: "views", label: "Views", icon: Code2 },
            ...viewTabs.tabs.map(tab => ({ value: tab.key, label: tab.name, icon: Code2, hasActions: true, onClose: () => closeView(tab.key) })),
          ]}
          afterTabs={<TraceViewPicker disabled={!trace || !viewLoader} onOpenView={openView} onCreateView={createView} />}
        >
          <div className="ml-auto hidden shrink-0 items-center gap-2 whitespace-nowrap text-[11px] text-foreground-muted sm:flex">
            {summary ?? (trace ? <span>{trace.spans.length} spans</span> : null)}
          </div>
        </InspectorTabs>
      </header>
      <TraceViewLibraryContext.Provider value={libraryControls}>
        <div className={viewTabs.active ? "hidden" : "flex min-h-0 flex-1 flex-col"}>{children}</div>
        {trace && viewLoader && viewTabs.tabs.map(tab => <div key={tab.key} className={viewTabs.active === tab.key ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <TraceObjectViewPanel key={trace.id} trace={trace} loader={viewLoader} tab={tab} actionsContainer={tabActionsContainers[tab.key] ?? null} onActivate={activateView} onUpdate={updateView} onClose={closeView} />
        </div>)}
      </TraceViewLibraryContext.Provider>
    </section>
  )
}

function TraceNavigationButton({
  direction,
  onNavigate,
  traceId,
}: {
  direction: "next" | "previous"
  onNavigate?: (traceId: string) => void
  traceId?: string
}) {
  const Icon = direction === "previous" ? ArrowUp : ArrowDown
  const label = direction === "previous" ? "Previous trace" : "Next trace"
  const className = cn(
    "grid size-7 place-items-center rounded-md text-foreground-muted transition-colors hover:bg-white/[0.07] hover:text-foreground",
    !traceId &&
      "cursor-not-allowed opacity-30 hover:bg-transparent hover:text-foreground-muted"
  )

  if (traceId && !onNavigate) {
    return (
      <Link
        aria-label={label}
        className={className}
        href={traceHref(traceId, null)}
        title={label}
      >
        <Icon className="size-3.5" />
      </Link>
    )
  }

  return (
    <button
      aria-label={label}
      className={className}
      disabled={!traceId}
      onClick={() => traceId && onNavigate?.(traceId)}
      title={label}
      type="button"
    >
      <Icon className="size-3.5" />
    </button>
  )
}

function InspectorPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-foreground-muted">
      <span className="mr-2 size-2 animate-pulse rounded-full bg-foreground-subtle" />
      {label}
    </div>
  )
}

function TraceInspectorSkeleton() {
  return (
    <div role="status" aria-label="Loading trace" className="min-h-0 flex-1 overflow-hidden p-3 sm:p-4">
      <span className="sr-only">Loading trace…</span>
      <div aria-hidden="true" className="space-y-6">
        <div className="space-y-3">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
          <div className="flex gap-2">
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-6 w-16" />
          </div>
        </div>
        {["input", "output"].map(field => (
          <div key={field} className="space-y-4 border-t border-border pt-4">
            <Skeleton className="h-3 w-16" />
            <FieldSkeleton />
          </div>
        ))}
      </div>
    </div>
  )
}

type TraceWorkspaceProps = {
  navigation: "trace" | "timeline"
  hideOverviewScores: boolean
  loader: TraceDetailLoader
  onSelectSpan: (spanId: string | null) => void
  selectedSpanId: string | null
  trace?: TraceOverview
  navigator?: (onNavigate: () => void) => React.ReactNode
  timeline?: (onNavigate: () => void) => React.ReactNode
  details?: React.ReactNode
}

function TraceWorkspace(props: TraceWorkspaceProps) {
  const container = React.useRef<HTMLDivElement>(null)
  const [horizontal, setHorizontal] = React.useState<boolean | null>(null)
  React.useEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setHorizontal(entry.contentRect.width >= 640))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={container} className="min-h-0 flex-1">
      {horizontal !== null && (
        <TraceWorkspacePanels key={String(horizontal)} horizontal={horizontal} {...props} />
      )}
    </div>
  )
}

function TraceWorkspacePanels({
  navigation,
  hideOverviewScores,
  loader,
  onSelectSpan,
  selectedSpanId,
  trace,
  navigator,
  timeline,
  details,
  horizontal,
}: TraceWorkspaceProps & { horizontal: boolean }) {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const [navigatorOpen, setNavigatorOpen] = React.useState(false)
  const layout = useDefaultLayout({
    id: "trace-inspector-horizontal",
    panelIds: ["span-navigator", "span-details"],
    onlySaveAfterUserInteractions: true,
  })
  const [storedDetailTab, selectStoredDetailTab] = useStoredChoice<DetailTab>(
    DETAIL_TAB_STORAGE_KEY,
    ["messages", "details", "metadata", "raw"],
    "messages"
  )
  const [detailTab, selectDetailTab] = useReviewAnnotationTab(storedDetailTab, selectStoredDetailTab, "messages")
  const closeNavigator = () => setNavigatorOpen(false)
  const selectSpan = (spanId: string | null) => {
    onSelectSpan(spanId)
    closeNavigator()
  }
  const navigationContent = (
    <aside className="flex h-full min-h-0 flex-col bg-background">
      {navigation === "timeline" ? (
        timeline?.(closeNavigator) ?? (trace ? <TraceTimeline
          trace={trace}
          selectedSpanId={selectedSpanId}
          onSelectSpan={selectSpan}
        /> : null)
      ) : (
        <div className="min-h-0 flex-1 px-1 pt-2">
          {navigator?.(closeNavigator) ?? (trace ? <SpanNavigator
            scrollRef={scrollRef}
            onSelectSpan={selectSpan}
            selectedSpanId={selectedSpanId}
            trace={trace}
          /> : null)}
        </div>
      )}
    </aside>
  )
  const detailContent = (
    <section
      aria-label="Trace details"
      tabIndex={0}
      className="scrollbar-hidden h-full min-h-0 min-w-0 overflow-y-auto overscroll-contain bg-background"
    >
      {details ?? (trace ? <SelectedSpanDetail
        key={inspectorNodeKey(trace.id, selectedSpanId)}
        hideOverviewScores={hideOverviewScores}
        loader={loader}
        detailTab={detailTab}
        onDetailTabChange={selectDetailTab}
        selectedSpanId={selectedSpanId}
        trace={trace}
      /> : null)}
    </section>
  )

  if (!horizontal) return (
    <div className="flex h-full min-h-0 flex-col">
      <Dialog open={navigatorOpen} onOpenChange={setNavigatorOpen}>
        <div className="shrink-0 border-b border-border px-0.5 py-1.5">
          <DialogTrigger asChild>
            <Button variant="ghost-muted" size="sm">
              <ListTree aria-hidden className="size-4" />
              {navigation === "timeline" ? "Browse timeline" : "Browse traces"}
            </Button>
          </DialogTrigger>
        </div>
        <DialogContent variant="sidebar" className="gap-0 p-0">
          <div className="shrink-0 border-b border-border p-3">
            <DialogTitle>{navigation === "timeline" ? "Timeline" : "Trace navigator"}</DialogTitle>
            <DialogDescription className="sr-only">Select a trace or span to view its details.</DialogDescription>
          </div>
          <div className="min-h-0 flex-1">{navigationContent}</div>
        </DialogContent>
      </Dialog>
      <div className="min-h-0 flex-1">{detailContent}</div>
    </div>
  )

  return (
      <ResizablePanelGroup
        orientation="horizontal"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
      >
        <ResizablePanel id="span-navigator" defaultSize="40%" minSize="20%" overflow="hidden">
          {navigationContent}
        </ResizablePanel>
        <ResizableHandle
          withHandle
          aria-label={navigation === "timeline" ? "Resize timeline and span details" : "Resize span navigator and details"}
        />
        <ResizablePanel id="span-details" defaultSize="60%" minSize="25%" overflow="hidden">
          {detailContent}
        </ResizablePanel>
      </ResizablePanelGroup>
  )
}

export function SpanNavigator({
  scrollRef,
  onSelectSpan,
  selectedSpanId,
  trace,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  onSelectSpan: (spanId: string | null) => void
  selectedSpanId: string | null
  trace: TraceOverview
}) {
  const tree = React.useMemo(() => buildInspectorTree(trace), [trace])
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set())

  const rows = React.useMemo(() => flattenInspectorTree(tree, collapsed), [tree, collapsed])
  const toggle = React.useCallback((nodeId: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }, [])

  return (
    <HoverCard<InspectorTreeNode>>
      {({ payload: hoveredNode }) => (
        <>
          <VirtualList items={rows} itemKey={row => row.node.id ?? "__trace__"}
            scrollRef={scrollRef} label="Trace span hierarchy">
            {row => <TreeNodeRow {...row} collapsed={collapsed} onSelectSpan={onSelectSpan}
              selectedSpanId={selectedSpanId} toggle={toggle} trace={trace} />}
          </VirtualList>
          {hoveredNode && (
            <HoverCardContent side="left" align="start">
              <SpanHoverSummary node={hoveredNode} trace={trace} />
            </HoverCardContent>
          )}
        </>
      )}
    </HoverCard>
  )
}

function TreeNodeRow({
  collapsed,
  isLastChild,
  continuingDepths,
  node,
  onSelectSpan,
  selectedSpanId,
  toggle,
  trace,
}: {
  collapsed: Set<string>
  onSelectSpan: (spanId: string | null) => void
  selectedSpanId: string | null | undefined
  toggle: (nodeId: string) => void
  trace: TraceOverview | Session
} & InspectorTreeRow) {
  const nodeKey = node.id ?? "__trace__"
  const isExpanded = !collapsed.has(nodeKey)
  const hasChildren = node.children.length > 0
  const span = node.span
  const session = "traceCount" in trace ? trace : null
  const invocation = "spans" in trace ? trace : null
  const selected = selectedSpanId === node.id
  const label = span ? span.name : trace.name || invocation?.operation || "Untitled session"
  const secondary = session ? `${session.traceCount} traces` : span
    ? `${span.kind} · ${knownDuration(span.durationMs, span.status)}`
    : `${invocation!.spans.length} span${invocation!.spans.length === 1 ? "" : "s"} · ${knownDuration(invocation!.durationMs, invocation!.status)}`

  return (
    <div className="relative">
      {continuingDepths.map(depth => <span key={depth} aria-hidden
        className="pointer-events-none absolute inset-y-0 z-10 w-px bg-border-strong"
        style={{ left: `${22 + (depth - 1) * 24}px` }} />)}
      {node.depth > 0 ? <>
        {!isLastChild ? <span aria-hidden className="pointer-events-none absolute inset-y-0 z-10 w-px bg-border-strong"
          style={{ left: `${22 + (node.depth - 1) * 24}px` }} /> : null}
        <span aria-hidden className="pointer-events-none absolute top-0 z-10 h-5 w-6 rounded-bl-md border-b border-l border-border-strong"
          style={{ left: `${22 + (node.depth - 1) * 24}px` }} />
      </> : null}
      <div
        className={cn(
          "relative mb-0.5 flex min-w-0 items-center rounded bg-surface-row",
          selected && "bg-surface-emphasis"
        )}
      >
        <HoverCardTrigger
          payload={node}
          delay={350}
          closeDelay={150}
          render={<button type="button" />}
          aria-pressed={selected}
          className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded py-1 pr-2 text-left hover:bg-surface-row-hover"
          style={{ paddingLeft: `${12 + node.depth * 24}px` }}
          onClick={() => onSelectSpan(node.id)}
        >
          <span className="relative z-20 shrink-0">
            {session ? <SessionKindIcon /> : <SpanKindIcon kind={span?.kind ?? getTraceIconKind(invocation!)} />}
          </span>
          {(span ?? invocation)?.status === "running" && <RunningSpinner />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] leading-4 text-foreground-secondary">
              {label}
            </span>
            <span className="block truncate text-xs leading-4 text-foreground-muted">
              {secondary}
            </span>
          </span>
          {(span ?? invocation)?.status === "errored" ? (
            <CircleAlert className="size-3.5 text-destructive" />
          ) : null}
        </HoverCardTrigger>
        {hasChildren ? (
          <button
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${label}`}
            className="mr-2 grid size-6 shrink-0 place-items-center rounded text-foreground-muted hover:text-foreground"
            onClick={() => toggle(nodeKey)}
            type="button"
          >
            <ChevronRight
              className={cn("size-3.5", isExpanded && "rotate-90")}
            />
          </button>
        ) : null}
      </div>
    </div>
  )
}

function DetailRequestState({ error, refresh, label }: {
  error: Error | null
  refresh: () => void
  label: string
}) {
  return error
    ? <Notice role="alert" variant="error">{error.message} <Button variant="outline" size="sm" onClick={refresh}>Retry</Button></Notice>
    : <div role="status" className="p-4 text-sm text-foreground-muted">{label}</div>
}

function SelectedSpanDetail({ loader, trace, selectedSpanId, detailTab, onDetailTabChange, hideOverviewScores }: {
  hideOverviewScores: boolean
  loader: TraceDetailLoader
  trace: TraceOverview
  selectedSpanId: string | null
  detailTab: DetailTab
  onDetailTabChange: (tab: DetailTab) => void
}) {
  const span = trace.spans.find(span => span.id === selectedSpanId)
  const full = selectedSpanId === null && detailTab === "raw"
  // Switching between trace payload and complete raw evidence resets retained
  // data too, so a partial trace can never be labelled complete captured JSON.
  return <SelectedPayload key={`${selectedSpanId ?? "__trace__"}:${full}`} loader={loader}
    hideOverviewScores={hideOverviewScores}
    trace={trace} span={span} full={full} detailTab={detailTab} onDetailTabChange={onDetailTabChange} />
}

function SelectedPayload({ loader, trace, span, full, detailTab, onDetailTabChange, hideOverviewScores }: {
  hideOverviewScores: boolean
  loader: TraceDetailLoader
  trace: TraceOverview
  span: TraceOverview["spans"][number] | undefined
  full: boolean
  detailTab: DetailTab
  onDetailTabChange: (tab: DetailTab) => void
}) {
  const load = React.useCallback((signal: AbortSignal) => full
    ? loader.full(trace, signal)
    : span ? loader.span(span, trace, signal) : loader.payload(trace, signal),
    // Summary polling must not restart an in-flight payload request. A terminal
    // transition does refresh the selected record, including its final output.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loader, full, trace.status, trace.endedAt, full ? trace.spans.length : 0, span?.id, span?.status, span?.endedAt])
  const state = useRemote<Span | TraceSummary | TraceDetail>(load, [], {
    intervalMs: 3_000,
    shouldPoll: data => trace.status === "running" || data?.status === "running",
  })
  const payload = state.data ?? (full ? undefined : loader.peek(trace, span))
  return <SpanDetail trace={trace} span={span ?? null} payload={payload} error={state.error} refresh={state.refresh}
    hideOverviewScores={hideOverviewScores}
    detailTab={detailTab} onDetailTabChange={onDetailTabChange} />
}

function TraceObjectViewPanel({ trace, loader, tab, actionsContainer, onActivate, onUpdate, onClose }: {
  trace: TraceOverview; loader: TraceDetailLoader; tab: OpenTraceView
  actionsContainer: HTMLDivElement | null
  onActivate: (key: string) => void
  onUpdate: (key: string, view: ReactView | null) => void
  onClose: (key: string) => void
}) {
  const onViewChange = React.useCallback((view: ReactView | null) => onUpdate(tab.key, view), [tab.key, onUpdate])
  const onCancelCreate = React.useCallback(() => onClose(tab.key), [tab.key, onClose])
  return <FullTraceViews trace={trace} loader={loader} tabActions={{ container: actionsContainer, label: tab.name, onActivate: () => onActivate(tab.key) }} displayMode="view" selectedViewId={tab.viewId ?? undefined} createNew={!tab.viewId} onViewChange={onViewChange} onCancelCreate={onCancelCreate} />
}

function FullTraceViews({ trace, loader, ...viewProps }: { trace: TraceOverview; loader: TraceDetailLoader } & Pick<React.ComponentProps<typeof ReactTraceViews>, "selectedViewId" | "onSelectedViewChange" | "displayMode" | "createNew" | "onViewChange" | "onCancelCreate" | "tabActions">) {
  const libraryControls = React.useContext(TraceViewLibraryContext)
  const [mode, setMode] = React.useState<TraceViewDataMode>("summary")
  const load = React.useCallback((signal: AbortSignal) => mode === "summary" ? loader.payload(trace, signal) : loader.full(trace, signal),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loader, mode, trace.status, trace.endedAt, trace.spans.length])
  const state = useRemote(load, [], { intervalMs: 3_000, keepPreviousData: true, shouldPoll: () => trace.status === "running" })
  if (!state.data) return <DetailRequestState {...state} label="Loading view data…" />
  return <>
    {state.error ? <DetailRequestState {...state} label="Loading view data…" /> : null}
    <ReactTraceViews trace={state.data} {...(libraryControls && !viewProps.displayMode ? { displayMode: "library" as const, ...libraryControls } : {})} {...viewProps} onDataModeChange={setMode} dataLoading={mode === "full" && !("spans" in state.data)} />
  </>
}

function SpanDetail({
  detailTab,
  hideOverviewScores,
  onDetailTabChange,
  payload,
  span: summary,
  error,
  refresh,
  trace,
}: {
  detailTab: DetailTab
  hideOverviewScores: boolean
  onDetailTabChange: (tab: DetailTab) => void
  payload: Span | TraceSummary | TraceDetail | undefined
  span: SpanOverview | null
  error: Error | null
  refresh: () => void
  trace: TraceOverview
}) {
  const customColumnDetails = React.useContext(CustomColumnDetailsContext)
  const scoresDisclosure = useTraceSectionDisclosure("scores")
  const annotationFocus = useReviewAnnotations()?.focus
  const span = payload && "kind" in payload ? payload : summary
  const title = span?.name || trace.name || trace.operation || "Trace"
  const kind = span?.kind ?? getTraceIconKind(trace)
  const status = span?.status ?? trace.status
  const duration = knownDuration(
    span ? span.durationMs : trace.durationMs,
    status
  )
  const attributes = payload?.attributes ?? {}
  const raw = payload

  return (
    <div className="min-h-full px-3 pb-[30vh]">
      <div className="flex min-w-0 items-center gap-3 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <SpanKindIcon kind={kind} />
          {status === "running" && <RunningSpinner />}
          <h2 className="truncate text-lg font-semibold text-foreground">
            {title}
          </h2>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-3 text-sm text-foreground-muted">
          <span className="inline-flex items-center gap-1">
            <Clock3 className="size-3.5" />
            {duration}
          </span>
          <StatusText status={status} />
        </div>
      </div>
      <DetailTabs value={detailTab} onChange={onDetailTabChange} />
      {error ? <DetailRequestState error={error} refresh={refresh} label="Loading span details…" /> : null}
      <div aria-busy={!payload && !error && detailTab !== "metadata"}>
        {!payload && !error && detailTab !== "metadata" ? <SpanDetailSkeleton detailTab={detailTab} hasCustomFields={Boolean(customColumnDetails)} /> : null}
        {payload && detailTab === "messages" ? (
          <div>
            <PayloadSection key={annotationFocus?.reference.field === "input" ? annotationFocus.nonce : "input"} label="Input" value={payload.input} annotationTarget={{ traceId: trace.id, spanId: span?.id ?? null, spanName: title }} />
            <PayloadSection key={annotationFocus?.reference.field === "output" ? annotationFocus.nonce : "output"} label="Output" value={payload.output} inputValue={payload.input} annotationTarget={{ traceId: trace.id, spanId: span?.id ?? null, spanName: title }} />
            <CapturedErrors attributes={attributes} status={status} />
            {!hideOverviewScores && trace.scores.length > 0 && (
              <details {...scoresDisclosure} className="group border-t border-white/[0.18]">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-2 text-sm text-foreground-secondary [&::-webkit-details-marker]:hidden">
                  <span className="flex items-center gap-2">
                    <Percent className="size-4 text-foreground-muted" />
                    {span ? "Trace scores" : "Scores"}
                  </span>
                  <ChevronDown className="size-3.5 text-foreground-muted transition-transform group-open:rotate-180" />
                </summary>
                <div className="pb-3">
                  <ScoreValues scores={trace.scores} />
                </div>
              </details>
            )}
            {customColumnDetails}
          </div>
        ) : null}
        {payload && detailTab === "details" ? (
          <SelectedDetails
            attributes={attributes}
            span={span}
            status={status}
            trace={trace}
          />
        ) : null}
        {detailTab === "metadata" ? (
          <SelectedMetadata span={span} status={status} trace={trace} />
        ) : null}
        {payload && detailTab === "raw" ? (
          <div className="pt-4">
            <p className="mb-2 text-xs text-foreground-muted">
              Complete captured {span ? "span" : "trace"} JSON
            </p>
            <JsonPayload value={raw} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

function SpanDetailSkeleton({ detailTab, hasCustomFields }: { detailTab: DetailTab; hasCustomFields: boolean }) {
  return <div role="status" aria-label="Loading span fields">
    <span className="sr-only">Loading span fields…</span>
    {detailTab === "messages" ? <>
      <PayloadSection label="Input" value={null} loading />
      <PayloadSection label="Output" value={null} loading />
      {hasCustomFields ? <InspectorSection label="Custom fields" icon={<Code2 className="size-4" />}><FieldSkeleton /></InspectorSection> : null}
    </> : detailTab === "details" ? <>
      <InspectorSection label="Tags"><Skeleton className="h-6 w-32" /></InspectorSection>
      <InspectorSection label="Metrics"><div className="grid grid-cols-2 gap-4">
        {Array.from({ length: 6 }, (_, index) => <div key={index} className="space-y-2"><Skeleton className="h-3 w-16" /><Skeleton className="h-4 w-24 max-w-full" /></div>)}
      </div></InspectorSection>
    </> : <div className="space-y-4 border-t border-border pt-4"><Skeleton className="h-3 w-44" /><FieldSkeleton /></div>}
  </div>
}

function FieldSkeleton() {
  return <div className="space-y-3 py-3">
    <Skeleton className="h-4 w-3/4" />
    <Skeleton className="h-4 w-full" />
    <Skeleton className="h-4 w-5/6" />
  </div>
}

function DetailTabs({ value, onChange }: { value: DetailTab; onChange: (tab: DetailTab) => void }) {
  return <div className="scrollbar-hidden flex min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain pb-2">
    {([ ["messages", "Overview"], ["details", "Details"], ["metadata", "Metadata"], ["raw", "Raw"] ] as const).map(([tab, label]) =>
      <DetailTabButton key={tab} active={value === tab} label={label} onClick={() => onChange(tab)} />)}
  </div>
}

function DetailTabButton({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "h-7 shrink-0 rounded-md px-2.5 text-sm font-medium whitespace-nowrap text-foreground-muted transition-colors hover:text-foreground-secondary",
        active && "bg-white/[0.1] text-foreground"
      )}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  )
}

function StatusText({ status }: { status: TraceStatus }) {
  const tone =
    status === "errored"
      ? "text-destructive"
      : status === "running"
        ? "text-info"
        : status === "completed"
          ? "text-success"
          : "text-foreground-muted"
  return <span className={cn("capitalize", tone)}>{status}</span>
}

function PayloadSection({
  label,
  value,
  loading = false,
  annotationTarget,
  inputValue,
}: {
  label: string
  value: JsonValue | null
  loading?: boolean
  annotationTarget?: { traceId: string; spanId: string | null; spanName: string }
  inputValue?: JsonValue
}) {
  const review = useReviewAnnotations()
  const focus = review?.focus?.reference
  // Review annotations keep the full transcript and its existing text offsets.
  const messageInput = review ? undefined : inputValue
  const disclosure = useTraceSectionDisclosure(label.toLowerCase(), Boolean(
    annotationTarget && focus &&
    focus.traceId === annotationTarget.traceId &&
    focus.spanId === annotationTarget.spanId &&
    focus.field === label.toLowerCase()
  ))
  const messages =
    label === "Output"
      ? normaliseOutputMessages(value, messageInput)
      : normaliseChatMessages(value)

  return (
    <PayloadSectionFrame
      {...disclosure}
      label={label}
      headerDetail={loading ? <Skeleton className="h-3 w-10" /> : messages
        ? `${messages.length} message${messages.length === 1 ? "" : "s"}`
        : null}
    >
        {loading ? <FieldSkeleton /> : value === null ? (
          <p className="py-3 text-sm text-foreground-muted">
            No captured {label.toLowerCase()}.
          </p>
        ) : (
          annotationTarget && review ? <AnnotatableValue value={value} target={{ ...annotationTarget, field: label === "Input" ? "input" : "output" }} /> : <StructuredValueViewer value={value} label={label} inputValue={messageInput} />
        )}
    </PayloadSectionFrame>
  )
}

function JsonPayload({
  className,
  value,
}: {
  className?: string
  value: unknown
}) {
  if (typeof value === "string") {
    return (
      <div
        className={cn(
          "py-2 font-mono text-xs leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap text-foreground-secondary",
          className
        )}
      >
        {value}
      </div>
    )
  }

  return (
    <pre
      className={cn(
        "py-2 font-mono text-xs leading-5 [overflow-wrap:anywhere] break-words whitespace-pre-wrap text-foreground-secondary",
        className
      )}
    >
      {<JsonCode text={toReadableJson(value)} />}
    </pre>
  )
}

function SelectedMetadata({
  span,
  status,
  trace,
}: {
  span: SpanOverview | null
  status: TraceStatus
  trace: TraceOverview
}) {
  const workspaceHref = useWorkspaceHref()
  const details: Array<[string, React.ReactNode]> = span
    ? [
        ["Span ID", span.id],
        ["Parent span", span.parentId ?? "No parent span"],
        ["Type", span.kind],
        ["Status", status],
        ["Ended", formatDate(span.endedAt)],
      ]
    : [
        ["Trace ID", trace.id],
        ["Type", getTraceIconKind(trace)],
        ["Operation", trace.operation],
        [
          "Session",
          trace.sessionId ? (
            <Link
              className="text-foreground-secondary underline-offset-4 hover:text-foreground hover:underline"
              href={workspaceHref(
                `/sessions/${encodeURIComponent(trace.sessionId)}`
              )}
            >
              {trace.sessionId}
            </Link>
          ) : (
            "No session"
          ),
        ],
        ["Status", status],
        ["Ended", formatDate(trace.endedAt)],
        ["Captured spans", String(trace.spans.length)],
      ]

  return (
    <section>
      <h3 className="text-xs font-medium tracking-[0.12em] text-foreground-muted uppercase">
        Captured metadata
      </h3>
      <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        {details.map(([label, value]) => (
          <div key={label}>
            <dt className="text-[11px] text-foreground-muted">{label}</dt>
            <dd className="mt-0.5 font-mono text-xs break-words text-foreground-secondary">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function SelectedDetails({
  attributes,
  span,
  status,
  trace,
}: {
  attributes: JsonObject
  span: SpanOverview | null
  status: TraceStatus
  trace: TraceOverview
}) {
  const workspaceHref = useWorkspaceHref()
  const rootSpanId = React.useMemo(() => buildInspectorTree(trace).id, [trace])
  return (
    <div className="@container space-y-6">
      <InspectorGroupMembership
        traceGroup={trace.group}
        spanGroup={span?.group}
        isRootSelected={span === null || span.id === rootSpanId}
        workspaceHref={workspaceHref}
      />
      <InspectorTags attributes={attributes} />
      <div className="grid grid-cols-1 gap-6 @min-[36rem]:grid-cols-2">
        <section aria-label="Metrics" className="border-t border-border pt-3">
          <h3 className="mb-4 flex items-center gap-2 text-sm font-medium text-foreground">
            <ChartNoAxesColumn className="size-4 text-muted-foreground" />
            Metrics
          </h3>
          <dl className="space-y-3 text-sm">
            {(
              [
                [
                  "Start",
                  <span
                    key="start"
                    title={formatDate(span?.startedAt ?? trace.startedAt)}
                  >
                    {compactRelativeTime(span?.startedAt ?? trace.startedAt)}
                  </span>,
                ],
                [
                  "Duration",
                  knownDuration(
                    span ? span.durationMs : trace.durationMs,
                    status
                  ),
                ],
                ...usageDisplay(attributes),
              ] as Array<[string, React.ReactNode]>
            ).map(([label, value]) => (
              <div
                key={label}
                className="space-y-1"
                title={
                  label === "Reasoning tokens"
                    ? "Included in output tokens"
                    : label === "Cached input tokens"
                      ? "Included in input tokens"
                      : undefined
                }
              >
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 break-words text-foreground tabular-nums">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <section
          aria-label={span ? "Trace scores" : "Scores"}
          className="border-t border-border pt-3"
        >
          <h3 className="mb-4 flex items-center gap-2 text-sm font-medium text-foreground">
            <Percent className="size-4 text-muted-foreground" />
            {span ? "Trace scores" : "Scores"}
          </h3>
          {trace.scores.length ? (
            <ScoreValues scores={trace.scores} />
          ) : (
            <p className="text-sm text-muted-foreground">No captured scores.</p>
          )}
        </section>
      </div>
      <CapturedErrors attributes={attributes} status={status} />
    </div>
  )
}

function InspectorTags({ attributes }: { attributes: JsonObject }) {
  const tags = getTraceTags(attributes)

  return (
    <section aria-label="Tags" className="border-t border-border pt-3">
      <h3 className="mb-4 flex items-center gap-2 text-sm font-medium text-foreground">
        <Tags className="size-4 text-foreground-muted" />
        Tags
      </h3>
      {tags.length ? (
        <ul aria-label="Tags" className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <li
              key={`${tag.key}:${tag.value}`}
              className="max-w-full rounded bg-surface-emphasis px-2 py-1 text-xs text-foreground-secondary break-words [overflow-wrap:anywhere]"
            >
              {tag.key === "tag" ? tag.value : `${tag.key}: ${tag.value}`}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-foreground-muted">No tags captured.</p>
      )}
    </section>
  )
}

function CapturedErrors({
  attributes,
  status,
}: {
  attributes: JsonObject
  status: TraceStatus
}) {
  const fields = Object.entries(attributes).filter(
    ([key, value]) =>
      /(^|[._])(error|exception)([._]|$)/i.test(key) &&
      value != null &&
      value !== false &&
      value !== ""
  )
  if (!fields.length && status !== "errored") return null
  return (
    <PayloadSection
      label="Error"
      value={
        fields.length
          ? (Object.fromEntries(fields) as JsonObject)
          : "This execution failed, but no error details were captured."
      }
    />
  )
}

function EvaluatorWorkspace({ scores, pagination }: { scores: TraceScore[]; pagination?: CollectionScrollState }) {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  return <div className="flex min-h-0 flex-1 flex-col p-4">
    <div className="shrink-0 pb-5">
      <p className="text-[11px] font-medium tracking-[0.12em] text-foreground-muted uppercase">Evaluators</p>
      <h2 className="mt-1 text-lg font-semibold text-foreground">Captured trace scores</h2>
      <p className="mt-1 text-sm text-foreground-muted">Scores come from evaluator runs and attributed reviews; null scores remain unscored.</p>
    </div>
    <VirtualList items={scores} itemKey={(score, index) => score.evalResultId ?? `${score.evaluatorId}-${index}`}
      scrollRef={scrollRef} label="Trace evaluator scores" estimatedRowHeight={96}
      empty={!pagination?.isLoading && !pagination?.error ? <EmptyWorkspace detail="No evaluation or review is attached to this trace yet." title="No captured scores" /> : null}
      footer={pagination && <CollectionScrollBoundary scrollRef={scrollRef} state={pagination} label="scores" />}>
      {score => <div className="max-w-3xl border-b border-border"><EvaluatorScore score={score} /></div>}
    </VirtualList>
  </div>
}

function ScoreValues({ scores }: { scores: TraceScore[] }) {
  const workspaceHref = useWorkspaceHref()
  return (
    <div className="@container/scores">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm @min-[24rem]/scores:grid-cols-2">
        {scores.map((score, index) => (
          <div
            key={score.evalResultId ?? `${score.evaluatorId}-${index}`}
            className="min-w-0 space-y-1"
          >
            <dt className="min-w-0 break-words text-muted-foreground">
              {score.evalRunId ? (
                <Link
                  className="hover:text-foreground hover:underline"
                  href={workspaceHref(
                    `/evals/${encodeURIComponent(score.evalRunId)}`
                  )}
                >
                  {score.evaluatorName ?? score.name}
                </Link>
              ) : (
                (score.evaluatorName ?? score.name)
              )}
            </dt>
            <dd
              className={cn(
                "tabular-nums",
                score.status === "error"
                  ? "text-destructive"
                  : "text-foreground"
              )}
            >
              {score.valueLabel !== undefined ? <span className="whitespace-pre-wrap break-words">{score.valueLabel}</span> : <EvalScoreCell result={score} />}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function EvaluatorScore({ score }: { score: TraceScore }) {
  const workspaceHref = useWorkspaceHref()
  const label = score.evaluatorName ?? score.name
  const target = score.evalRunId
    ? workspaceHref(
        `/evals/${encodeURIComponent(score.evalRunId)}${
          score.evalResultId
            ? `#result-${encodeURIComponent(score.evalResultId)}`
            : ""
        }`
      )
    : null

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 bg-muted px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground-secondary">{label}</p>
        <p className="mt-0.5 font-mono text-[11px] text-foreground-muted">
          {score.metadata?.reviewSessionId
            ? `${score.metadata.source === "human" ? "Human review" : "AI-labelled"} · ${score.metadata.reviewerName ?? "Former member"}`
            : score.evaluatorId ?? "Trace metric"}
        </p>
        {score.metadata?.reviewSessionId && score.reasoning && <p className="mt-2 whitespace-pre-wrap text-sm text-foreground-muted">{score.reasoning}</p>}
      </div>
      <div className="flex items-center gap-3">
        {typeof score.metadata?.reviewSessionId === "string" && <Link className="text-xs text-foreground-muted hover:underline" href={workspaceHref(`/reviews/${encodeURIComponent(typeof score.metadata.reviewSessionNumber === "number" ? score.metadata.reviewSessionNumber : score.metadata.reviewSessionId)}`)}>Open review</Link>}
        <span
          className={cn(
            "rounded-md border px-2 py-1 text-xs font-semibold tabular-nums",
            score.status === "error"
              ? "border-destructive-border bg-destructive-background text-destructive"
              : "border-white/[0.12] bg-muted text-foreground-secondary"
          )}
        >
          {score.valueLabel !== undefined ? <span className="whitespace-pre-wrap break-words">{score.valueLabel}</span> : <EvalScoreCell result={score} />}
        </span>
        {target ? (
          <Link
            className="inline-flex items-center gap-1 text-xs font-medium text-foreground-muted underline-offset-4 hover:text-foreground hover:underline"
            href={target}
          >
            Open eval run
            <ExternalLink className="size-3" />
          </Link>
        ) : null}
      </div>
    </div>
  )
}

function EmptyWorkspace({ detail, title }: { detail: string; title: string }) {
  return (
    <div className="mt-5 rounded-lg border border-dashed border-border-strong bg-muted p-5">
      <p className="text-sm font-medium text-foreground-secondary">{title}</p>
      <p className="mt-1 text-sm leading-6 text-foreground-muted">{detail}</p>
    </div>
  )
}

function traceHref(traceId: string, spanId: string | null) {
  const base = `/traces/${encodeURIComponent(traceId)}`
  return spanId ? `${base}?span=${encodeURIComponent(spanId)}` : base
}

function shortTraceId(traceId: string) {
  return traceId.length > 10 ? traceId.slice(-8) : traceId
}

/** Full-page trace route using the same inspector and URL-addressable span. */
export function TraceDetailPage({ traceId }: { traceId: string }) {
  return (
    <React.Suspense
      fallback={
        <div className="flex min-h-[calc(100dvh-3rem)] items-center justify-center bg-black text-sm text-foreground-muted">
          Loading trace inspector…
        </div>
      }
    >
      <TraceDetailPageContent traceId={traceId} />
    </React.Suspense>
  )
}

function TraceDetailPageContent({ traceId }: { traceId: string }) {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialSpanId = searchParams.get("span") ?? undefined

  const onSpanChange = React.useCallback(
    (spanId: string | null) => {
      const next = new URLSearchParams(searchParams.toString())
      if (spanId) next.set("span", spanId)
      else next.delete("span")
      const query = next.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      })
    },
    [pathname, router, searchParams]
  )

  return (
    <div className="w-full p-0 sm:p-4">
      <TraceInspector
        initialSpanId={initialSpanId}
        mode="page"
        onSpanChange={onSpanChange}
        traceId={traceId}
      />
    </div>
  )
}

function SpanHoverSummary({
  node,
  trace,
}: {
  node: InspectorTreeNode
  trace: TraceOverview
}) {
  const item = node.span ?? trace
  const kind = node.span?.kind ?? getTraceIconKind(trace)
  const offset = Date.parse(item.startedAt) - Date.parse(trace.startedAt)
  const attributes = item.attributes
  const metrics: [string, string][] = [
    ["Duration", knownDuration(item.durationMs, item.status)],
    ["Status", item.status],
  ]
  if (Number.isFinite(offset) && offset >= 0)
    metrics.push(["Offset", knownDuration(offset, "completed")])
  metrics.push(...usageDisplay(attributes))
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <SpanKindIcon kind={kind} />
        {item.status === "running" && <RunningSpinner />}
        <span className="min-w-0 flex-1 font-medium break-words">
          {item.name}
        </span>
        <span className="text-xs text-muted-foreground uppercase">{kind}</span>
      </div>
      <dl className="space-y-2 border-t border-border pt-3">
        {metrics.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
