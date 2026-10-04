/* eslint-disable react-refresh/only-export-components -- Standalone iframe entrypoint. */
import * as React from "react"
import * as jsxRuntime from "react/jsx-runtime"
import { createRoot } from "react-dom/client"
import * as ui from "./trace-view-ui"
import { evaluateTraceView } from "../lib/tracer/trace-view-evaluate"
import {
  traceObjectViewInput,
  type ObjectViewInput,
  type ObjectViewProps,
} from "../lib/tracer/object-views"
import type {
  PageViewInput,
  PageViewProps,
} from "../lib/tracer/react-page-views"
import { MdxPageContent } from "./page-view-mdx"
import type {
  CompiledTraceView,
  TraceViewData,
  ViewSourceFormat,
} from "../lib/tracer/trace-view-contract"

declare global {
  interface Window {
    __datoolTraceReact: typeof React
    __datoolTraceCharts?: Record<string, unknown>
  }
}
window.__datoolTraceReact = React
const root = createRoot(document.getElementById("root")!)
const dynamicStyle = document.createElement("style")
document.head.append(dynamicStyle)
let installed: CompiledTraceView | undefined
let Component:
  React.ComponentType<ObjectViewProps | PageViewProps<unknown>> | undefined
let objectInput: ObjectViewInput | undefined
let trace: TraceViewData | undefined
let pageInput: PageViewInput | undefined
let generation = 0
let token = ""
let actionToken = ""
let expectedSource = ""
let expectedFormat: ViewSourceFormat = "react"
function report(error?: string) {
  parent.postMessage({ type: "trace-view-result", token, error }, "*")
}
window.addEventListener("error", (event) => report(event.message))
window.addEventListener("unhandledrejection", (event) =>
  report(String(event.reason))
)
let charts: Promise<void> | undefined
const scriptUrl = new URL((document.currentScript as HTMLScriptElement).src)
const scriptBase = new URL(".", scriptUrl)

class ViewErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { error: string | null }
> {
  state = { error: null as string | null }
  static getDerivedStateFromError(error: Error) {
    return { error: error.message }
  }
  componentDidCatch(error: Error) {
    report(String(error))
  }
  componentDidUpdate() {
    if (this.state.error) report(this.state.error)
  }
  render() {
    return this.state.error ? (
      <ui.Notice variant="error" role="alert">
        {this.state.error}
      </ui.Notice>
    ) : (
      this.props.children
    )
  }
}
function RenderComplete({ requestToken }: { requestToken: string }) {
  React.useEffect(() => {
    if (requestToken === token) report()
  }, [requestToken])
  return null
}
function render() {
  if (!Component || (!trace && !pageInput) || !installed) return
  const installedFormat = installed.format ?? "react"
  if (installed.source !== expectedSource || installedFormat !== expectedFormat)
    return
  // Polling preserves callbacks; replacing the view invalidates its action token.
  const requestToken = actionToken
  const action = (name: string, payload?: unknown) =>
    parent.postMessage(
      {
        type: "page-view-action",
        token: requestToken,
        action: name,
        payload,
      },
      "*"
    )
  const pageProps: PageViewProps<unknown> | undefined = pageInput
    ? {
        ...pageInput,
        openTrace: (
          traceId: string,
          options?: Parameters<PageViewProps["openTrace"]>[1]
        ) => action("openTrace", { ...options, traceId }),
        refresh: () => action("refresh"),
        loadMore: () => action("loadMore"),
      }
    : undefined
  const props = pageProps ?? {
    ...(objectInput ?? traceObjectViewInput(trace!)),
    trace: trace!,
  }
  root.render(
    <ViewErrorBoundary
      key={`${installedFormat}:${installed.source}:${pageInput?.page.resource ?? trace!.id}`}
    >
      {installed.format === "mdx" && pageProps ? (
        <MdxPageContent Component={Component} input={pageProps} />
      ) : (
        <Component {...props} />
      )}
      <RenderComplete requestToken={token} />
    </ViewErrorBoundary>
  )
}
function loadCharts() {
  charts ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script")
    script.src = new URL(`charts.js${scriptUrl.search}`, scriptBase).href
    script.onload = () => resolve()
    script.onerror = () => {
      charts = undefined
      reject(new Error("Could not load the chart components."))
    }
    document.head.append(script)
  })
  return charts
}
window.addEventListener("message", async (event) => {
  if (event.source !== parent) return
  if (event.data?.type === "trace-view-data") {
    trace = event.data.trace
    objectInput = event.data.objectInput
    pageInput = event.data.pageInput
    token = event.data.token
    actionToken = event.data.actionToken
    expectedSource = event.data.source
    expectedFormat = event.data.format ?? "react"
    document.documentElement.classList.toggle("dark", event.data.dark === true)
    render()
    return
  }
  if (event.data?.type !== "install-trace-view") return
  const sequence = ++generation
  const artifact = event.data.artifact as CompiledTraceView
  if (
    installed?.source === artifact.source &&
    installed.buildId === artifact.buildId &&
    (installed.format ?? "react") === (artifact.format ?? "react")
  )
    return
  try {
    if (artifact.modules.includes("@datool/charts")) await loadCharts()
    if (sequence !== generation) return
    Component = evaluateTraceView<ObjectViewProps | PageViewProps<unknown>>(
      artifact,
      React,
      {
        react: React,
        "react/jsx-runtime": jsxRuntime,
        "@datool/ui": ui,
        "@datool/charts": window.__datoolTraceCharts,
      }
    )
    installed = artifact
    dynamicStyle.textContent = artifact.css
    render()
  } catch (error) {
    if (sequence !== generation) return
    Component = undefined
    installed = undefined
    report(String(error))
    root.render(
      <ui.Notice variant="error" role="alert">
        {String(error)}
      </ui.Notice>
    )
  }
})
parent.postMessage({ type: "trace-view-ready" }, "*")
