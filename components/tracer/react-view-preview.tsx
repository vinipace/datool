"use client"
import * as React from "react"
import { Notice } from "@/components/ui/notice"
import { prepareTraceView } from "@/src/lib/tracer/trace-view-client"
import {
  projectTraceViewData,
  type CompiledTraceView,
  type TraceViewData,
  type TraceViewDataMode,
} from "@/src/lib/tracer/trace-view-contract"

export function ReactViewPreview({
  code,
  trace,
  dataMode = "full",
  dataLoading = false,
}: {
  code: string
  trace: TraceViewData
  dataMode?: TraceViewDataMode
  dataLoading?: boolean
}) {
  const frame = React.useRef<HTMLIFrameElement>(null)
  const [compiled, setCompiled] = React.useState<{
    source: string
    artifact?: CompiledTraceView
    error?: string
  } | null>(null)
  const [result, setResult] = React.useState<{
    token: string
    error?: string
  } | null>(null)
  const { token } = React.useMemo(
    () => ({ token: crypto.randomUUID(), code, trace, dataMode }),
    [code, trace, dataMode]
  )
  const artifact = compiled?.source === code ? compiled.artifact : undefined
  const compileError = compiled?.source === code ? compiled.error : undefined
  React.useEffect(() => {
    let cancelled = false
    prepareTraceView(code)
      .then((artifact) => {
        if (!cancelled) setCompiled({ source: code, artifact })
      })
      .catch((error) => {
        if (!cancelled) setCompiled({ source: code, error: String(error) })
      })
    return () => {
      cancelled = true
    }
  }, [code])
  const install = React.useCallback(() => {
    if (artifact)
      frame.current?.contentWindow?.postMessage(
        { type: "install-trace-view", artifact },
        "*"
      )
  }, [artifact])
  const send = React.useCallback(() => {
    if (!dataLoading)
      frame.current?.contentWindow?.postMessage(
        {
          type: "trace-view-data",
          source: code,
          token,
          trace: projectTraceViewData(trace, dataMode),
          dark: document.documentElement.classList.contains("dark"),
        },
        "*"
      )
  }, [code, trace, dataMode, dataLoading, token])
  React.useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
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
  }, [install, send, token])
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
