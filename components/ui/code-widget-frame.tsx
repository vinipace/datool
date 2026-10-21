"use client"

import * as React from "react"
import type { WidgetDefinition } from "@/src/lib/build/contracts"

const themeProperties = [
  "--color-background",
  "--color-foreground",
  "--color-muted",
  "--color-foreground-muted",
  "--color-border",
  "--color-primary",
  "--color-primary-foreground",
  "--color-ring",
  "--color-destructive",
  "--color-data-series-primary",
]

/** The same isolated React runtime is used by authoring previews and customer widgets. */
export function CodeWidgetFrame({
  code,
  schemaCode,
  data,
  functions,
  onAction,
  onStatus,
}: {
  code: string
  schemaCode?: string
  data: Record<string, unknown>
  functions: WidgetDefinition["functions"]
  onAction?: (
    actionId: string,
    input: Record<string, unknown>,
    label: string
  ) => void
  onStatus?: (error: string | null) => void
}) {
  const frame = React.useRef<HTMLIFrameElement>(null)
  const host = React.useRef<HTMLDivElement>(null)
  const current = React.useRef({ functions, onAction, onStatus })
  React.useEffect(() => {
    current.current = { functions, onAction, onStatus }
  }, [functions, onAction, onStatus])
  const [origin, setOrigin] = React.useState("")
  const [height, setHeight] = React.useState(96)
  const [ready, setReady] = React.useState(false)
  const [theme, setTheme] = React.useState<Record<string, string>>({})
  const payload = JSON.stringify({
    code,
    schemaCode,
    data,
    enabled: Boolean(onAction),
    functions: functions.map((fn) => fn.name),
    theme,
  })
  const request = React.useRef(0)

  React.useEffect(() => {
    const element = host.current
    if (!element) return
    const update = () => {
      const style = getComputedStyle(element)
      const next = Object.fromEntries(
        themeProperties.map((name) => [
          name,
          style.getPropertyValue(name).trim(),
        ])
      )
      next.colorScheme = style.colorScheme
      setTheme((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next
      )
    }
    const initial = requestAnimationFrame(() => {
      setOrigin(window.location.origin)
      update()
    })
    const observer = new MutationObserver(update)
    let ancestor: Element | null = element
    while (ancestor) {
      observer.observe(ancestor, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme"],
      })
      ancestor = ancestor.parentElement
    }
    return () => {
      cancelAnimationFrame(initial)
      observer.disconnect()
    }
  }, [])

  React.useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow) return
      const value = event.data
      if (value?.type === "widget-ready") {
        setReady(true)
        return
      }
      if (value?.requestId !== request.current) return
      if (value.type === "widget-height" && Number.isFinite(value.height)) {
        setHeight(Math.max(40, Math.min(1600, Math.ceil(value.height))))
      } else if (value.type === "widget-status") {
        current.current.onStatus?.(
          typeof value.error === "string" ? value.error.slice(0, 2000) : null
        )
      } else if (value.type === "widget-action") {
        const fn = current.current.functions.find(
          (item) => item.name === value.functionName
        )
        if (!fn?.actionId || !current.current.onAction) return
        if (
          !value.input ||
          typeof value.input !== "object" ||
          Array.isArray(value.input)
        )
          return
        try {
          if (JSON.stringify(value.input).length > 64_000) return
        } catch {
          return
        }
        current.current.onAction(
          fn.actionId,
          value.input,
          typeof value.label === "string" ? value.label.slice(0, 200) : fn.name
        )
      }
    }
    window.addEventListener("message", receive)
    return () => window.removeEventListener("message", receive)
  }, [])

  React.useEffect(() => {
    if (!ready) return
    const requestId = ++request.current
    const timer = window.setTimeout(
      () =>
        frame.current?.contentWindow?.postMessage(
          { type: "render-widget", requestId, ...JSON.parse(payload) },
          "*"
        ),
      150
    )
    return () => window.clearTimeout(timer)
  }, [ready, payload])

  const source = origin
    ? `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-eval' ${origin}/widget-runtime.js; style-src 'unsafe-inline' ${origin}/widget-runtime.css; img-src https: data: ${origin}/widget-template-assets/; connect-src 'none'; form-action 'none'; base-uri 'none';"><link rel="stylesheet" href="${origin}/widget-runtime.css"></head><body><div id="root"></div><script src="${origin}/widget-runtime.js"></script></body></html>`
    : undefined
  return (
    <div ref={host} className="w-full min-w-0">
      {origin ? (
        <iframe
          ref={frame}
          title="Widget content"
          sandbox="allow-scripts"
          srcDoc={source}
          className="block w-full border-0"
          style={{ height }}
        />
      ) : (
        <p className="text-xs text-foreground-muted">Loading widget…</p>
      )}
    </div>
  )
}
