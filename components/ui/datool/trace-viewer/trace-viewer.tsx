"use client"

import { clsx } from "clsx"
import type { CSSProperties, MouseEventHandler, ReactNode } from "react"
import { useCallback, useEffect, useLayoutEffect, useRef } from "react"
import { MiniMap } from "./components/map"
import { CursorMarker, EventMarkers, Markers } from "./components/markers"
import { SpanNodes } from "./components/node"
import { SearchBar } from "./components/search"
import { SpanDetailPanel } from "./components/span-detail-panel"
import { ZoomButton } from "./components/zoom-button"
import { useTraceViewer } from "./context"
import { TraceViewerContextProvider } from "./context-provider"
import styles from "./trace-viewer.module.css"
import type { GetQuickLinks, RenderSpanIcon, Trace } from "./types"
import {
  MAP_HEIGHT,
  MARKER_HEIGHT,
  MARKER_NOTCH_HEIGHT,
  ROW_HEIGHT,
  ROW_PADDING,
  SEARCH_GAP,
  SEARCH_HEIGHT,
  TIMELINE_PADDING,
} from "./util/constants"
import { parseTrace } from "./util/tree"
import { useStreamingSpans } from "./util/use-streaming-spans"

export interface TraceViewerProps {
  trace?: Trace
  className?: string
  scrollLock?: boolean
  height?: string | number
  withPanel?: boolean
  hideMiniMap?: boolean
  /** Hide the built-in span search header. */
  hideSearchBar?: boolean
  /** Controlled selection when span details are rendered by the parent. */
  selectedSpanId?: string | null
  onSpanSelect?: (spanId: string) => void
  filter?: string
  getQuickLinks?: GetQuickLinks
  renderSpanIcon?: RenderSpanIcon
  highlightedSpans?: string[]
  /** Render all spans immediately (no progressive streaming). */
  eagerRender?: boolean
  /** Whether the trace is live (for continuous tick updates). */
  isLive?: boolean
}

export function TraceViewerProvider({
  getQuickLinks,
  children,
}: Pick<TraceViewerProps, "getQuickLinks"> & {
  children: ReactNode
}): ReactNode {
  return (
    <TraceViewerContextProvider getQuickLinks={getQuickLinks}>
      {children}
    </TraceViewerContextProvider>
  )
}

interface LastClickRef {
  x: number
  y: number
  t: number
  spanId: string
}

const skeletonTrace: Trace = {
  traceId: "skeleton",
  spans: [
    {
      parentSpanId: "",
      spanId: "root",
      name: "root span",
      kind: 1,
      resource: "vercel.runtime",
      startTime: [5000, 0],
      endTime: [6000, 0],
      duration: [1000, 0],
      library: {
        name: "vercel-site",
      },
      status: {
        code: 1,
      },
      attributes: {
        "vercel.ownerId": "team_abc",
      },
      traceFlags: 1,
      events: [],
      links: [],
    },
  ],
  resources: [
    {
      name: "vercel.runtime",
      attributes: {},
    },
  ],
  rootSpanId: "root",
}

function useTimelineLiveTick(isLive: boolean): void {
  const { state, dispatch } = useTraceViewer()
  const stateRef = useRef(state)
  useLayoutEffect(() => { stateRef.current = state }, [state])

  useEffect(() => {
    if (!isLive) return

    let rafId = 0
    const tick = (): void => {
      const { root } = stateRef.current
      if (root.startTime) {
        const nowMs = Date.now()
        if (nowMs > root.endTime) {
          root.endTime = nowMs
          root.duration = root.endTime - root.startTime
        }
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    let scaleRafId = 0
    let lastBaseScale = 0
    const scaleTick = (): void => {
      const s = stateRef.current
      if (s.root.duration > 0) {
        const newBaseScale =
          (s.timelineWidth - s.scrollbarWidth) / s.root.duration
        const delta = Math.abs(newBaseScale - lastBaseScale)
        if (delta > lastBaseScale * 0.001 || lastBaseScale === 0) {
          lastBaseScale = newBaseScale
          dispatch({ type: "detectBaseScale" })
        }
      }
      scaleRafId = requestAnimationFrame(scaleTick)
    }
    scaleRafId = requestAnimationFrame(scaleTick)

    return () => {
      cancelAnimationFrame(rafId)
      cancelAnimationFrame(scaleRafId)
    }
  }, [isLive, dispatch])
}

export function TraceViewerTimeline({
  trace = skeletonTrace,
  className = "",
  scrollLock = false,
  height,
  withPanel = false,
  hideMiniMap = false,
  selectedSpanId,
  onSpanSelect,
  highlightedSpans,
  renderSpanIcon,
  eagerRender = false,
  isLive = false,
  footer,
  knownDurationMs,
  hasMoreData = false,
  hideSearchBar: hideSearchBarProp = false,
}: Omit<TraceViewerProps, "getQuickLinks"> & {
  footer?: ReactNode
  /** Duration in ms from trace start to the latest known event. Used to render the unknown-time overlay. */
  knownDurationMs?: number
  /** Whether more data pages are expected. Controls the unknown-data overlay visibility. */
  hasMoreData?: boolean
}): ReactNode {
  const isSkeleton = trace === skeletonTrace
  const { state, dispatch } = useTraceViewer()
  const { timelineRef, scrollSnapshotRef } = state
  const memoCache = state.memoCacheRef.current
  const hideSearchBar = (highlightedSpans?.length ?? 0) > 0 || hideSearchBarProp
  const mapHeight = hideMiniMap ? 0 : MAP_HEIGHT
  const searchHeight = hideSearchBar ? 0 : SEARCH_HEIGHT
  const searchGap = hideSearchBar ? 2 : SEARCH_GAP
  const headerHeight = mapHeight + searchHeight + 3 * searchGap
  const hasRunningSpans = trace.spans.some((span) => span.isRunning)
  const traceHasLiveUpdates = isLive || hasRunningSpans

  useTimelineLiveTick(traceHasLiveUpdates)

  const hasInitializedRef = useRef(false)
  const prevSpanKeyRef = useRef("")
  const prevRootRef = useRef<ReturnType<typeof parseTrace>["root"] | null>(null)
  const prevSpanMapRef = useRef<ReturnType<typeof parseTrace>["map"]>({})
  const prevSizeRef = useRef<{ width: number; height: number; headerHeight: number } | null>(null)

  useEffect(() => {
    const { root: newRoot, map: newSpanMap } = parseTrace(trace)
    const isInitial = !hasInitializedRef.current
    hasInitializedRef.current = true

    // Build a structural key from span IDs + lightweight event signatures.
    // When only timing changes (same spans and boundary events), we can skip the
    // worker restart. When events change (step completed, etc.) we need a
    // full update because the VisibleSpan objects rendered by React hold
    // copies of the events from the worker — in-place mutation won't reach them.
    const spanKey = Object.keys(newSpanMap)
      .sort()
      .map((id) => {
        const events = newSpanMap[id].events
        const count = events?.length ?? 0
        const first = count ? events?.[0] : undefined
        const last = count ? events?.[count - 1] : undefined
        const eventSignature = `${first?.event.name ?? "none"}@${first?.timestamp ?? 0}|${last?.event.name ?? "none"}@${last?.timestamp ?? 0}`
        return `${id}:${count}:${eventSignature}`
      })
      .join(",")

    if (
      !isInitial &&
      spanKey === prevSpanKeyRef.current &&
      prevRootRef.current
    ) {
      // Same span set, same event counts — only timing changed.
      // Mutate in-place so the worker effect (which depends on root/spanMap
      // references) does NOT restart.
      const oldRoot = prevRootRef.current
      const oldSpanMap = prevSpanMapRef.current
      let didChange = false

      if (
        oldRoot.endTime !== newRoot.endTime ||
        oldRoot.duration !== newRoot.duration
      ) {
        oldRoot.endTime = newRoot.endTime
        oldRoot.duration = newRoot.duration
        didChange = true
      }

      for (const [id, newNode] of Object.entries(newSpanMap)) {
        const oldNode = oldSpanMap[id]
        if (oldNode) {
          if (oldNode.span.isRunning !== newNode.span.isRunning) {
            didChange = true
          }
          if (
            oldNode.endTime !== newNode.endTime ||
            oldNode.duration !== newNode.duration
          ) {
            oldNode.endTime = newNode.endTime
            oldNode.duration = newNode.duration
            didChange = true
          }
          Object.assign(oldNode.span, newNode.span)
        }
      }

      if (!didChange) {
        return
      }

      // Trigger re-render (scale/markers) without restarting the worker.
      // useLiveTick handles continuous scale recalculation for live runs.
      dispatch({ type: "forceRender" })
      return
    }

    // Structure changed or initial load — full dispatch (worker computes new rows)
    prevSpanKeyRef.current = spanKey
    prevRootRef.current = newRoot
    prevSpanMapRef.current = newSpanMap
    dispatch({
      type: isInitial ? "setRoot" : "updateRoot",
      root: newRoot,
      spanMap: newSpanMap,
      resources: trace.resources || [],
    })
  }, [dispatch, trace])

  useEffect(() => {
    if (selectedSpanId === undefined) return
    dispatch(selectedSpanId
      ? { type: "select", id: selectedSpanId }
      : { type: "deselect" })
  }, [dispatch, selectedSpanId, state.spanMap])

  const { rows, spans, events, scale } = useStreamingSpans(
    highlightedSpans,
    eagerRender
  )

  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const $el = ref.current
    if (!$el) return

    const onResize = (): void => {
      const padding = 2 * TIMELINE_PADDING
      const rect = $el.getBoundingClientRect()
      const nextWidth = rect.width - padding
      const nextHeight = rect.height
      const prevSize = prevSizeRef.current

      if (
        prevSize &&
        prevSize.width === nextWidth &&
        prevSize.height === nextHeight &&
        prevSize.headerHeight === headerHeight
      ) {
        return
      }
      prevSizeRef.current = { width: nextWidth, height: nextHeight, headerHeight }

      dispatch({
        type: "setSize",
        width: nextWidth,
        height: nextHeight,
        headerHeight,
      })
    }

    onResize()

    const observer = new ResizeObserver(onResize)
    observer.observe($el)
    window.addEventListener("resize", onResize)

    return () => {
      observer.disconnect()
      window.removeEventListener("resize", onResize)
    }
  }, [dispatch, headerHeight])

  const lastClickRef = useRef<LastClickRef>({
    t: 0,
    x: -1,
    y: -1,
    spanId: "",
  })
  const onClick: MouseEventHandler = useCallback(
    (event) => {
      // NOTE(wits): We manually implement double-click logic here so that we can support double
      // clicking a span even if the first click moves the span that the user is clicking on due
      // to the panel opening. If we used a regular double click listener we would need to delay
      // the opening of the panel artificially. This implementation allows us to always be
      // FAST while also avoiding a FRUSTRATING situation.
      const prev = lastClickRef.current
      const t = Date.now()
      const { clientX: x, clientY: y } = event
      const d = Math.sqrt((x - prev.x) ** 2 + (y - prev.y) ** 2)
      // double click
      if (t - prev.t <= 500 && d <= 8) {
        event.stopPropagation()
        event.preventDefault()
        if (!prev.spanId) {
          dispatch({
            type: "resetScale",
          })
          return
        }
        dispatch({
          type: "select",
          id: prev.spanId,
        })
        onSpanSelect?.(prev.spanId)
        dispatch({
          type: "scaleToNode",
          id: prev.spanId,
        })
        return
      }
      const target = event.target as HTMLElement
      if (!target.closest(`.${String(styles.timeline)}`)) return
      const $button = target.closest<HTMLButtonElement>("[data-span-id]")
      const spanId = $button?.dataset.spanId || ""
      lastClickRef.current = {
        x,
        y,
        t,
        spanId,
      }
      if (!spanId) return
      dispatch({
        type: selectedSpanId === undefined ? "toggleSelection" : "select",
        id: spanId,
      })
      onSpanSelect?.(spanId)
      event.stopPropagation()
    },
    [dispatch, onSpanSelect, selectedSpanId]
  )

  // Zoom helper — apply the scroll snapshot once after a zoom operation so
  // the anchor point stays at the same screen position, then clear it.
  // Without clearing, live runs (where scale changes every frame via
  // detectBaseScale) would continuously reset scrollLeft and prevent the
  // user from scrolling horizontally.
  useLayoutEffect(() => {
    const $timeline = timelineRef.current
    if (!$timeline) return

    const snapshot = scrollSnapshotRef.current
    if (snapshot) {
      $timeline.scrollLeft = snapshot.anchorT * scale - snapshot.anchorX
      scrollSnapshotRef.current = undefined
    }
  }, [scrollSnapshotRef, timelineRef, scale])

  // Selection helper
  useEffect(() => {
    const spanId = state.selected?.span.spanId
    if (!spanId) return

    const timeout = setTimeout(() => {
      const $timeline = state.timelineRef.current
      const $span = $timeline?.querySelector(`[data-span-id="${spanId}"]`)
      if (!$timeline || !$span) return

      const viewRect = $timeline.getBoundingClientRect()
      const spanRect = $span.getBoundingClientRect()

      // If the selected span is narrower than the timeline, scroll it into view
      if (
        spanRect.width < viewRect.width &&
        (spanRect.left < viewRect.left ||
          spanRect.right > viewRect.right ||
          spanRect.top < viewRect.top ||
          spanRect.bottom > viewRect.bottom)
      ) {
        $span.scrollIntoView({
          block: "nearest",
          inline: "center",
          behavior: "smooth",
        })
      }
    }, 500)

    return () => {
      clearTimeout(timeout)
    }
  }, [state.selected, state.timelineRef])

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        dispatch({
          type: selectedSpanId === undefined ? "escape" : "resetScale",
        })
      }
    }
    window.addEventListener("keydown", onKeyDown)

    return () => {
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [dispatch, selectedSpanId])

  // Scroll locking
  useEffect(() => {
    if (!scrollLock) return

    const $html = document.documentElement
    const $body = document.body

    $html.style.overflow = "clip"
    $body.style.overflow = "clip"

    const onScroll = (event?: Event): void => {
      if (event?.cancelable) {
        event.preventDefault()
      } else {
        window.scrollTo({
          left: 0,
          top: 0,
          behavior: "instant",
        })
      }
    }
    onScroll()
    window.addEventListener("scroll", onScroll, {
      passive: false,
    })

    return () => {
      $html.style.overflow = ""
      $body.style.overflow = ""
      window.removeEventListener("scroll", onScroll)
    }
  }, [scrollLock])

  const timelineHeight = Math.max(
    state.timelineHeight - state.scrollbarWidth,
    MARKER_HEIGHT +
      ROW_PADDING +
      rows.length * (ROW_HEIGHT + ROW_PADDING) -
      ROW_PADDING +
      // When there are enough spans to be near the bottom edge, add some extra padding
      // to avoid overlapping with the zoom buttons, etc.
      84
  )

  const inert = Boolean(state.isMobile && state.selected)

  return (
    <div
      className={clsx(
        styles.traceViewer,
        isSkeleton && styles.skeleton,
        className
      )}
      onClickCapture={onClick}
      ref={ref}
      style={
        {
          height,
          "--timeline-padding": `${TIMELINE_PADDING}px`,
          "--row-height": `${ROW_HEIGHT}px`,
          "--row-padding": `${ROW_PADDING}px`,
          "--search-height": `${searchHeight}px`,
          "--search-gap": `${searchGap}px`,
          "--map-height": `${mapHeight}px`,
          "--timeline-width": `${state.timelineWidth}px`,
          "--timeline-height": `${state.timelineHeight}px`,
          "--timeline-scroll-width": `${Math.round(state.root.duration * state.scale)}px`,
          "--panel-width": `${state.panelWidth}px`,
          "--panel-height": `${state.panelHeight}px`,
          "--height": `${state.height}px`,
          "--scrollbar-width": `${state.scrollbarWidth}px`,
          "--marker-height": `${MARKER_HEIGHT}px`,
          "--marker-notch-height": `${MARKER_NOTCH_HEIGHT}px`,
        } as CSSProperties
      }
    >
      {!hideSearchBar ? <SearchBar /> : null}
      {!hideMiniMap ? <MiniMap rows={rows} scale={scale} timelineRef={timelineRef} /> : null}
      <div className={clsx(styles.traceViewerContent, inert && styles.inert)}>
        <div
          aria-label="Scrollable trace spans"
          className={clsx(styles.timeline, "scrollbar-hidden")}
          ref={timelineRef}
          role="region"
          tabIndex={0}
        >
          <div
            style={{
              position: "relative",
              width: state.timelineWidth,
              minHeight: state.timelineHeight - TIMELINE_PADDING * 2,
              padding: TIMELINE_PADDING,
              paddingBottom: 0,
            }}
          >
            <div
              className={styles.traceNode}
              style={{
                width: state.root.duration * scale || undefined,
                height: timelineHeight - TIMELINE_PADDING * 2,
              }}
            >
              <Markers scale={scale} isLive={traceHasLiveUpdates} />
              <EventMarkers events={events} root={state.root} scale={scale} />
              <CursorMarker
                dispatch={dispatch}
                events={events}
                memoCacheRef={state.memoCacheRef}
                root={state.root}
                scale={scale}
                scrollSnapshotRef={scrollSnapshotRef}
                spans={spans}
                timelineRef={timelineRef}
              />
              <SpanNodes
                renderSpanIcon={renderSpanIcon}
                cacheKey={memoCache.get("")}
                cache={memoCache}
                customSpanClassNameFunc={state.customSpanClassNameFunc}
                customSpanEventClassNameFunc={
                  state.customSpanEventClassNameFunc
                }
                isLive={isLive}
                root={state.root}
                scale={scale}
                scrollSnapshotRef={scrollSnapshotRef}
                spans={spans}
              />
              {/* Horizontal "unknown time" overlay — covers the region to the
                  right of the latest known event, indicating data beyond this
                  point hasn't been loaded yet. */}
              {knownDurationMs != null &&
                knownDurationMs > 0 &&
                (hasMoreData || traceHasLiveUpdates) &&
                state.root.duration > 0 &&
                (() => {
                  const knownPx = knownDurationMs * scale
                  const totalPx = state.root.duration * scale
                  const unknownWidth = totalPx - knownPx
                  // Only show if the unknown region is meaningfully wide
                  if (unknownWidth < 4) return null
                  // Offset ~5% into the unknown region so it doesn't touch spans
                  const insetPx = Math.min(unknownWidth * 0.05, 20)
                  return (
                    <div
                      style={{
                        position: "absolute",
                        top: 0,
                        left: knownPx + insetPx,
                        width: unknownWidth - insetPx,
                        height: "100%",
                        pointerEvents: "none",
                        zIndex: 1,
                        maskImage:
                          "linear-gradient(to right, transparent 1%, black 3%)",
                        WebkitMaskImage:
                          "linear-gradient(to right, transparent 1%, black 3%)",
                        background:
                          "repeating-linear-gradient(-45deg, var(--muted) 0, var(--muted) 11px, var(--surface-emphasis) 11px, var(--surface-emphasis) 12px)",
                      }}
                    />
                  )
                })()}
            </div>
          </div>
          {footer}
        </div>
        <div className={styles.zoomButtonTraceViewer}>
          <ZoomButton />
        </div>
      </div>
      {withPanel ? (
        <div
          className={clsx(
            styles.spanDetailPanelTraceViewer,
            !state.selected && styles.hidden,
            state.isMobile && styles.mobile
          )}
        >
          <SpanDetailPanel attached />
        </div>
      ) : null}
    </div>
  )
}

export function TraceViewerPanel({
  className = "",
  children = null,
}: {
  className?: string
  children?: ReactNode
}): ReactNode {
  const { state } = useTraceViewer()

  if (!state.selected) {
    return children
  }

  return (
    <div
      className={clsx(styles.spanDetailPanelTraceViewer, className)}
      style={
        {
          position: "relative",
          "--search-height": "0",
          "--search-gap": "0",
          "--map-height": "0",
          "--panel-width": `100%`,
          "--panel-height": `100%`,
          "--height": `100%`,
          "--scrollbar-width": `${state.scrollbarWidth}px`,
        } as CSSProperties
      }
    >
      <SpanDetailPanel />
    </div>
  )
}

export function TraceViewer({ withPanel = true, ...props }: TraceViewerProps): ReactNode {
  return (
    <TraceViewerContextProvider getQuickLinks={props.getQuickLinks} withPanel={withPanel}>
      <TraceViewerTimeline withPanel={withPanel} {...props} />
    </TraceViewerContextProvider>
  )
}
