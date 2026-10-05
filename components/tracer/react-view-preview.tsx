"use client"
import * as React from "react"
import { Notice } from "@/components/ui/notice"
import {
  traceObjectViewInput,
  type ObjectViewInput,
} from "@/src/lib/tracer/object-views"
import { prepareTraceView } from "@/src/lib/tracer/trace-view-client"
import {
  openPageTraceSchema,
  type OpenPageTrace,
  type PageViewInput,
} from "@/src/lib/tracer/react-page-views"
import {
  projectTraceViewData,
  type CompiledTraceView,
  type TraceViewData,
  type TraceViewDataMode,
  type ViewSourceFormat,
} from "@/src/lib/tracer/trace-view-contract"

function projectObjectInput(
  trace: TraceViewData,
  dataMode: TraceViewDataMode,
  objectInput?: ObjectViewInput
) {
  if (objectInput?.kind === "dataset-item") return objectInput
  return {
    ...(objectInput ?? traceObjectViewInput(trace)),
    object: projectTraceViewData(trace, dataMode),
  }
}

export function ReactViewPreview({
  code,
  trace,
  objectInput,
  dataMode = "full",
  dataLoading = false,
  format = "react",
  pageInput,
  onOpenTrace,
  onRefresh,
  onLoadMore,
}: {
  code: string
  trace?: TraceViewData
  objectInput?: ObjectViewInput
  dataMode?: TraceViewDataMode
  dataLoading?: boolean
  format?: ViewSourceFormat
  pageInput?: PageViewInput
  onOpenTrace?: (request: OpenPageTrace) => void
  onRefresh?: () => void
  onLoadMore?: () => void
}) {
  const frame = React.useRef<HTMLIFrameElement>(null)
  const [compiled, setCompiled] = React.useState<{
    source: string
    format: ViewSourceFormat
    artifact?: CompiledTraceView
    error?: string
  } | null>(null)
  const [result, setResult] = React.useState<{
    token: string
    error?: string
  } | null>(null)
  const { token } = React.useMemo(
    () => ({
      token: crypto.randomUUID(),
      code,
      trace,
      dataMode,
      objectInput,
      pageInput,
      format,
    }),
    [code, trace, dataMode, objectInput, pageInput, format]
  )
  const actionToken = React.useMemo(
    () => ({
      token: crypto.randomUUID(),
      code,
      format,
      resource: pageInput?.page.resource,
    }),
    [code, format, pageInput?.page.resource]
  ).token
  const currentCompilation =
    compiled?.source === code && compiled.format === format ? compiled : null
  const artifact = currentCompilation?.artifact
  const compileError = currentCompilation?.error
  React.useEffect(() => {
    let cancelled = false
    prepareTraceView(code, format)
      .then((artifact) => {
        if (!cancelled) setCompiled({ source: code, format, artifact })
      })
      .catch((error) => {
        if (!cancelled)
          setCompiled({ source: code, format, error: String(error) })
      })
    return () => {
      cancelled = true
    }
  }, [code, format])
  const install = React.useCallback(() => {
    if (artifact)
      frame.current?.contentWindow?.postMessage(
        { type: "install-trace-view", artifact },
        "*"
      )
  }, [artifact])
  const send = React.useCallback(() => {
    if (dataLoading || (!trace && !pageInput)) return
    if (!frame.current?.contentWindow) return

    const projectedTrace = trace
      ? projectTraceViewData(trace, dataMode)
      : undefined
    const projectedObjectInput = trace
      ? projectObjectInput(trace, dataMode, objectInput)
      : undefined
    frame.current.contentWindow.postMessage(
      {
        type: "trace-view-data",
        source: code,
        format,
        token,
        trace: projectedTrace,
        objectInput: projectedObjectInput,
        pageInput,
        actionToken,
        dark: document.documentElement.classList.contains("dark"),
      },
      "*"
    )
  }, [
    code,
    format,
    trace,
    dataMode,
    dataLoading,
    token,
    objectInput,
    pageInput,
    actionToken,
  ])
  React.useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      if (
        event.data?.type === "page-view-action" &&
        event.data.token === actionToken &&
        pageInput
      ) {
        if (event.data.action === "openTrace") {
          const request = openPageTraceSchema.safeParse(event.data.payload)
          if (request.success) onOpenTrace?.(request.data)
        } else if (event.data.action === "refresh") onRefresh?.()
        else if (
          event.data.action === "loadMore" &&
          pageInput.page.hasMore &&
          !pageInput.page.isLoadingMore
        )
          onLoadMore?.()
        return
      }
      if (event.data?.type === "trace-view-ready") {
        install()
        send()
      }
      if (
        event.data?.type === "trace-view-result" &&
        event.data.token === token
      )
        setResult(event.data)
    }
    window.addEventListener("message", receive)
    const observer = new MutationObserver(send)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    install()
    send()
    return () => {
      observer.disconnect()
      window.removeEventListener("message", receive)
    }
  }, [
    install,
    send,
    token,
    pageInput,
    onOpenTrace,
    onRefresh,
    onLoadMore,
    actionToken,
  ])
  const origin = typeof window === "undefined" ? "" : window.location.origin
  const frameDocument = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-eval' ${origin}/trace-views/; style-src 'unsafe-inline' ${origin}/trace-views/; connect-src 'none';"><link rel="stylesheet" href="${origin}/trace-views/theme.css?v=${artifact?.buildId ?? ""}"><div id="root"></div><script src="${origin}/trace-views/runtime.js?v=${artifact?.buildId ?? ""}"></script>`
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {compileError ? (
        <Notice variant="error" role="alert" className="m-3">
          {compileError}
        </Notice>
      ) : (
        <>
          {(dataLoading || !artifact || result?.token !== token) && (
            <p
              role="status"
              className="px-3 py-2 text-xs text-foreground-muted"
            >
              {dataLoading ? "Loading view data…" : "Preparing view…"}
            </p>
          )}
          {result?.token === token && result.error && (
            <Notice variant="error" role="alert" className="mx-3 mb-2">
              {result.error}
            </Notice>
          )}
          {artifact && (
            <iframe
              ref={frame}
              title="React view preview"
              sandbox="allow-scripts"
              className="min-h-64 w-full flex-1 border-0"
              srcDoc={frameDocument}
            />
          )}
        </>
      )}
    </div>
  )
}
