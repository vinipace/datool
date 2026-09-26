"use client"

import { useEffect, useRef, useState } from "react"
import Image from "next/image"
import Link from "next/link"
import {
  Check,
  ChevronDown,
  ChevronsUpDown,
  CircleAlert,
  Clock3,
  ListTree,
  PanelLeft,
  X,
} from "lucide-react"
import { productIcons } from "@/components/product-icons"
import { pageTitles } from "@/lib/page-metadata"
import { productFeatures, productFeatureHref } from "@/lib/marketing/product"
import datoolLogo from "@/app/icon.svg"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { PayloadSection } from "@/components/ui/payload-section"
import { StructuredValueViewer } from "@/components/ui/structured-value-viewer"
import { CollectionPanel } from "@/components/tracer/collection-panel"
import { CollectionSearch } from "@/components/tracer/collection-page"
import { HeaderSlot } from "@/components/tracer/collection-header"
import { TableViewControls } from "@/components/tracer/table-view-controls"
import { SpanNavigator } from "@/components/tracer/trace-inspector"
import { TraceListTable } from "@/components/tracer/trace-list-table"
import { TraceTimeline } from "@/components/tracer/trace-timeline"
import { SpanKindIcon } from "@/components/tracer/span-kind-icon"
import { getTraceIconKind } from "@/components/tracer/trace-icon-kind"
import {
  formatCompactDuration,
  formatTraceDuration,
  statusLabel,
} from "@/components/tracer/trace-list-utils"
import { usageDisplay } from "@/components/tracer/usage-display"
import { readModel } from "@/src/lib/tracer/usage"
import { platformPreviewTraces } from "./platform-preview-fixtures"
import {
  defaultTableSettings,
  type LogTableSettings,
} from "@/src/lib/tracer/custom-views"
import styles from "./platform-preview.module.css"

const navigation = (
  [
    ["traces", "traces"],
    ["playground", "playground"],
    ["dashboards", "dashboards"],
    ["agents", "agents"],
    ["workflows", "workflows"],
    ["sessions", "sessions"],
    ["reviews", "reviews"],
    ["humanScores", "human-scores"],
    ["evals", "evaluations"],
    ["prompts", "prompts"],
    ["scorers", "scorers"],
    ["datasets", "datasets"],
    ["alerts", "alerts"],
  ] as const
).map(([key, slug]) => {
  const feature = productFeatures.find((item) => item.slug === slug)!
  return {
    name: pageTitles[key],
    icon: productIcons[feature.icon],
    href: key === "traces" ? "#platform-preview" : productFeatureHref(feature),
  }
})

const traces = platformPreviewTraces

/** A static, device-pixel-aware dot field that fades into the page above the cut. */
function PreviewBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext("2d")
    if (!canvas || !context) return

    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect()
      if (!width || !height) return
      const scale = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * scale)
      canvas.height = Math.round(height * scale)
      context.setTransform(scale, 0, 0, scale, 0, 0)
      context.clearRect(0, 0, width, height)
      context.fillStyle = getComputedStyle(canvas).color

      const noise = (column: number, row: number) => {
        const value = Math.sin(column * 127.1 + row * 311.7) * 43758.5453
        return value - Math.floor(value)
      }

      for (let x = 7, column = 0; x < width; x += 14, column++) {
        const edge = Math.sin((x / width) * Math.PI) ** 0.65
        const columnHeight = 0.5 + noise(column, 0) * 0.5
        for (let y = 7, row = 0; y < height; y += 14, row++) {
          const depth = y / height
          const strength = depth ** 1.8 * edge * columnHeight
          const variation = noise(column, row + 1)
          if (variation > 0.18 + strength * 0.8) continue
          const brightness = noise(column + 17, row + 41)
          context.globalAlpha = Math.min(
            1,
            strength * (0.55 + brightness * 0.7)
          )
          context.beginPath()
          context.arc(x, y, 0.6 + depth * brightness * 1.4, 0, Math.PI * 2)
          context.fill()
        }
      }
      context.globalAlpha = 1
    }

    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    draw()
    return () => observer.disconnect()
  }, [])

  return (
    <canvas ref={canvasRef} className={styles.backdrop} aria-hidden="true" />
  )
}

/** The app's real table, span tree, timeline and payload controls, using public example data. */
export function PlatformPreview() {
  const [selectedTraceId, setSelectedTraceId] = useState(traces[0].id)
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(
    "generate"
  )
  const [query, setQuery] = useState("")
  const [tableSettings, setTableSettings] = useState<LogTableSettings>(() => ({
    ...defaultTableSettings,
    columnSizing: {
      name: 168,
      input: 108,
      output: 108,
      duration: 88,
      inputTokens: 120,
      outputTokens: 128,
      cost: 136,
    },
  }))
  const [tab, setTab] = useState<"trace" | "timeline">("trace")
  const [mobileOpen, setMobileOpen] = useState(false)
  const [navigatorOpen, setNavigatorOpen] = useState(false)
  const [previewContainer, setPreviewContainer] =
    useState<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const mobileScrollRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (mobileOpen) {
      if (closeButtonRef.current?.getClientRects().length) {
        closeButtonRef.current.focus({ preventScroll: true })
      }
    } else {
      returnFocusRef.current?.focus({ preventScroll: true })
    }
  }, [mobileOpen])

  const closeTrace = () => {
    setNavigatorOpen(false)
    setMobileOpen(false)
  }
  const selectMobileSpan = (id: string | null) => {
    setSelectedSpanId(id)
    setNavigatorOpen(false)
  }
  const trace = traces.find(({ id }) => id === selectedTraceId) ?? traces[0]
  const selected =
    trace.spans.find(({ id }) => id === selectedSpanId) ?? trace.spans[0]
  const selectedUsage = usageDisplay(selected.attributes).filter(([label]) =>
    [
      "Input tokens",
      "Output tokens",
      "Estimated cost",
      "Reported cost",
    ].includes(label)
  )
  const filtered = traces.filter((item) =>
    JSON.stringify([
      item.name,
      getTraceIconKind(item),
      item.input,
      item.output,
      item.attributes.models,
    ])
      .toLowerCase()
      .includes(query.toLowerCase())
  )

  return (
    <figure
      id="platform-preview"
      aria-label="Interactive Datool platform preview"
      className={styles.preview}
    >
      <div className={styles.stage}>
        <PreviewBackdrop />
        <div ref={setPreviewContainer} className={styles.window}>
          <aside
            className={styles.sidebar}
            aria-label="Explore Datool features"
          >
            <div className={styles.workspace}>
              <Image
                src={datoolLogo}
                alt=""
                width={20}
                height={20}
                unoptimized
              />
              <span>Acme</span>
              <ChevronsUpDown size={13} aria-hidden="true" />
            </div>
            <div className={styles.project}>
              <span className={styles.projectIcon}>A</span>
              <span>AI workflows</span>
              <ChevronDown size={13} aria-hidden="true" />
            </div>
            <SidebarMenu className="gap-0.5 px-2">
              {navigation.map(({ name, icon: Icon, href }, index) => (
                <SidebarMenuItem key={name}>
                  <SidebarMenuButton
                    className="h-7 text-xs"
                    isActive={index === 0}
                    render={<Link href={href} prefetch={false} />}
                  >
                    <Icon />
                    <span>{name}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
            <div className={styles.sidebarFooter}>
              <SidebarMenuButton
                className="h-7 text-xs"
                render={<Link href="/docs" prefetch={false} />}
              >
                <productIcons.documentation />
                <span>Documentation</span>
              </SidebarMenuButton>
              <div className={styles.account}>
                <span>A</span>
                <span>Acme</span>
                <ChevronsUpDown size={13} />
              </div>
            </div>
          </aside>

          <div className={styles.application}>
            <header className={styles.pageHeader}>
              <PanelLeft size={16} aria-hidden="true" />
              <span className={styles.headerDivider} />
              <span>Traces</span>
              <span className={styles.exampleLabel}>Example workspace</span>
            </header>
            <div className={styles.panels} data-mobile-open={mobileOpen}>
              <div className={styles.traceList}>
                <CollectionPanel label="Example traces" displayIconOnly>
                  <TableViewControls>
                    <HeaderSlot name="filter">
                      <CollectionSearch
                        label="Search example traces"
                        value={query}
                        onChange={setQuery}
                      />
                    </HeaderSlot>
                    <TraceListTable
                      settings={tableSettings}
                      onSettingsChange={setTableSettings}
                      columns={[
                        "name",
                        "input",
                        "output",
                        "duration",
                        "inputTokens",
                        "outputTokens",
                        "cost",
                      ]}
                      enableCardView={false}
                      emptyMessage="No matching example traces."
                      rowLabel={(item) => `Inspect example: ${item.name}`}
                      onOpenTrace={(id, trigger) => {
                        returnFocusRef.current = trigger
                        setSelectedTraceId(id)
                        const opened = traces.find((item) => item.id === id)!
                        setSelectedSpanId(
                          opened.spans.find((span) => span.kind === "llm")
                            ?.id ?? opened.spans[0].id
                        )
                        setNavigatorOpen(false)
                        setMobileOpen(true)
                      }}
                      selectedTraceId={trace.id}
                      traces={filtered}
                    />
                  </TableViewControls>
                </CollectionPanel>
              </div>

              <section
                className={styles.inspector}
                aria-label="Example trace inspector"
                onKeyDown={(event) => {
                  if (
                    event.key === "Escape" &&
                    !event.defaultPrevented &&
                    !navigatorOpen &&
                    !document.querySelector(
                      '[role="dialog"], [role="menu"], [role="listbox"]'
                    )
                  ) {
                    event.preventDefault()
                    closeTrace()
                  }
                }}
              >
                <div className={styles.inspectorHeader}>
                  <SpanKindIcon kind={getTraceIconKind(trace)} />
                  <strong>{trace.name}</strong>
                  <span className={styles.inspectorMetadata}>
                    <Clock3 size={12} /> {formatTraceDuration(trace)}
                  </span>
                  <span
                    className={`${styles.inspectorMetadata} ${trace.status === "errored" ? styles.errored : styles.completed}`}
                  >
                    {trace.status === "errored" ? (
                      <CircleAlert size={12} />
                    ) : (
                      <Check size={12} />
                    )}
                    {statusLabel(trace.status)}
                  </span>
                  <Button
                    ref={closeButtonRef}
                    className={styles.mobileClose}
                    variant="ghost-muted"
                    size="icon-sm"
                    aria-label="Close trace inspector"
                    onClick={closeTrace}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
                <div
                  className={styles.tabs}
                  role="group"
                  aria-label="Example trace view"
                >
                  <Button
                    variant={tab === "trace" ? "secondary" : "ghost-muted"}
                    size="sm"
                    aria-pressed={tab === "trace"}
                    onClick={() => setTab("trace")}
                  >
                    <ListTree />
                    Trace
                  </Button>
                  <Button
                    variant={tab === "timeline" ? "secondary" : "ghost-muted"}
                    size="sm"
                    aria-pressed={tab === "timeline"}
                    onClick={() => setTab("timeline")}
                  >
                    <productIcons.traces />
                    Timeline
                  </Button>
                  <span>
                    {trace.spans.length}{" "}
                    {trace.spans.length === 1 ? "span" : "spans"}
                  </span>
                </div>
                <Dialog
                  modal={false}
                  open={navigatorOpen}
                  onOpenChange={setNavigatorOpen}
                >
                  <div className={styles.mobileNavigation}>
                    <DialogTrigger asChild>
                      <Button variant="ghost-muted" size="sm">
                        <ListTree aria-hidden="true" />
                        {tab === "timeline"
                          ? "Browse timeline"
                          : "Browse traces"}
                      </Button>
                    </DialogTrigger>
                  </div>
                  <DialogContent
                    variant="sidebar"
                    container={previewContainer}
                    className={`${styles.navigatorDrawer} gap-0 p-0`}
                  >
                    <div className="shrink-0 border-b border-border p-3">
                      <DialogTitle>
                        {tab === "timeline" ? "Timeline" : "Trace navigator"}
                      </DialogTitle>
                      <DialogDescription className="sr-only">
                        Select a trace or span to view its details.
                      </DialogDescription>
                    </div>
                    <div className="scrollbar-hidden min-h-0 flex-1 overflow-hidden px-1 pt-2">
                      {tab === "trace" ? (
                        <SpanNavigator
                          key={trace.id}
                          scrollRef={mobileScrollRef}
                          trace={trace}
                          selectedSpanId={selected.id}
                          onSelectSpan={selectMobileSpan}
                        />
                      ) : (
                        <TraceTimeline
                          trace={trace}
                          selectedSpanId={selected.id}
                          onSelectSpan={selectMobileSpan}
                        />
                      )}
                    </div>
                  </DialogContent>
                </Dialog>
                <div className={styles.traceWorkspace}>
                  <div className={styles.spanNavigation}>
                    {tab === "trace" ? (
                      <SpanNavigator
                        key={trace.id}
                        scrollRef={scrollRef}
                        trace={trace}
                        selectedSpanId={selected.id}
                        onSelectSpan={setSelectedSpanId}
                      />
                    ) : (
                      <TraceTimeline
                        trace={trace}
                        selectedSpanId={selected.id}
                        onSelectSpan={setSelectedSpanId}
                      />
                    )}
                  </div>
                  <div
                    className={styles.details}
                    aria-label="Example span details"
                    aria-live="polite"
                    tabIndex={0}
                  >
                    <div className={styles.spanHeading}>
                      <SpanKindIcon kind={selected.kind} />
                      <h2>{selected.name}</h2>
                    </div>
                    <div className={styles.spanMetadata}>
                      <span>
                        <Clock3 size={12} />
                        {formatCompactDuration(selected.durationMs)}
                      </span>
                      <span>
                        {readModel(selected.attributes) ?? selected.kind}
                      </span>
                    </div>
                    {selectedUsage.length > 0 && (
                      <dl className={styles.usage}>
                        {selectedUsage.map(([label, value]) => (
                          <div key={label}>
                            <dt>{label}</dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    <PayloadSection
                      label="Input"
                      key={`${trace.id}-${selected.id}-input`}
                    >
                      <StructuredValueViewer
                        label="Example span input"
                        value={selected.input}
                      />
                    </PayloadSection>
                    <PayloadSection
                      label="Output"
                      key={`${trace.id}-${selected.id}-output`}
                    >
                      <StructuredValueViewer
                        label="Example span output"
                        value={selected.output}
                      />
                    </PayloadSection>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
      <figcaption className="sr-only">
        Follow a sample request through Datool’s trace log and span inspector.
      </figcaption>
    </figure>
  )
}
