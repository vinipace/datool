"use client"

import * as React from "react"
import type { EvalViewSettings } from "@/src/lib/tracer/custom-views"
import type { PageViewResource } from "@/src/lib/tracer/view-resources"
import type { OpenPageTrace, PageViewInput } from "@/src/lib/tracer/react-page-views"
import type { ViewSourceFormat } from "@/src/lib/tracer/trace-view-contract"
import { ReactViewPreview } from "./react-view-preview"
import { TraceInspectorOverlay } from "./trace-list-overlay"
import { PageViewDataContext } from "./page-view-surface-context"

export function ReactPageView({ code, settings, resource, format = "react" }: {
  code: string
  settings: EvalViewSettings
  resource: PageViewResource
  format?: ViewSourceFormat
}) {
  const data = React.useContext(PageViewDataContext)
  const [opened, setOpened] = React.useState<OpenPageTrace | null>(null)
  const trigger = React.useRef<HTMLElement | null>(null)
  const input = React.useMemo<PageViewInput>(() => ({
    rows: data.rows,
    page: {
      resource, queryParams: settings.queryParams ?? {},
      total: data.total, isLoading: data.isLoading, isRefreshing: data.isRefreshing,
      hasMore: data.hasMore, isLoadingMore: data.isLoadingMore, error: data.error,
    },
  }), [data, resource, settings.queryParams])
  const open = React.useCallback((request: OpenPageTrace) => {
    trigger.current = document.activeElement as HTMLElement | null
    setOpened({ ...request, objectViewId: request.objectViewId ?? settings.objectViews?.trace?.id })
  }, [settings.objectViews?.trace?.id])
  return <>
    <ReactViewPreview code={code} format={format} pageInput={input} onOpenTrace={open}
      onRefresh={data.refresh} onLoadMore={data.loadMore} />
    {opened && <TraceInspectorOverlay key={opened.traceId + ":" + (opened.objectViewId ?? "")}
      traceId={opened.traceId} initialSpanId={opened.spanId} initialObjectViewId={opened.objectViewId}
      returnFocusRef={trigger} onClose={() => setOpened(null)} />}
  </>
}
