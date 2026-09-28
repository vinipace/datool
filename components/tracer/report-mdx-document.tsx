"use client"

import { createElement, useState, type ReactNode } from "react"
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react"
import { ContentDisclosure } from "@/components/ui/content-disclosure"
import { cn } from "@/lib/utils"
import type { Report } from "@/src/lib/tracer/reports"
import type { MdxNode } from "@/src/lib/tracer/report-mdx"
import {
  reportPresentationText,
  type ReportPresentation,
} from "@/src/lib/tracer/report-presentation"
import type { ReportComparison as Comparison } from "@/src/lib/tracer/report-layout-contract"
import {
  FrozenDashboardRenderer,
  FrozenReportWidget,
} from "./dashboard-renderer"
import { ReportComparison } from "./report-comparison"
import { ReportProgression } from "./report-progression"

const prose: Record<string, string> = {
  h1: "max-w-4xl text-3xl font-semibold tracking-tight sm:text-4xl",
  h2: "mt-10 text-xl font-medium tracking-tight",
  h3: "mt-6 text-lg font-medium",
  h4: "text-base font-medium",
  p: "max-w-3xl text-sm leading-relaxed",
  ul: "max-w-3xl list-disc space-y-2 pl-5 text-sm leading-relaxed",
  ol: "max-w-3xl list-decimal space-y-2 pl-5 text-sm leading-relaxed",
  a: "underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  strong: "font-semibold",
  blockquote:
    "max-w-3xl border-l-2 border-border pl-4 text-sm leading-relaxed text-foreground-muted",
  pre: "overflow-x-auto rounded-lg bg-muted p-4 text-xs",
  code: "font-mono text-sm",
  hr: "border-border",
  table: "w-full text-sm",
  td: "border-b border-border p-2 text-left",
  th: "border-b border-border p-2 text-left font-medium text-foreground-muted",
}
function Disclosure({
  id,
  title,
  children,
  className,
}: {
  id: string
  title: string
  children: ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={cn("min-w-0 border-y border-border", className)}>
      <ContentDisclosure
        variant="report"
        contentPadding="none"
        id={id}
        href={`#${id}-answer`}
        title={title}
        open={open}
        onToggle={() => setOpen(!open)}
      >
        {open && <div className="space-y-8 py-6">{children}</div>}
      </ContentDisclosure>
    </div>
  )
}
export function ReportMdxDocument({ report }: { report: Report }) {
  const text = (v: unknown) =>
    typeof v === "string" ? reportPresentationText(v, report) : ""
  const render = (node: MdxNode, index: number): ReactNode => {
    const p = node.props
    const key = `${node.line}-${node.column}-${index}`
    const children = node.children.map(render)
    const cls = typeof p.className === "string" ? p.className : undefined
    if (node.tag === "#text") return text(node.text)
    if (node.tag === "Value")
      return (
        <span key={key} className="font-mono tabular-nums">
          {report.snapshot.evidence?.values.find(
            (v) => v.binding.id === p.binding
          )?.formatted ?? "—"}
        </span>
      )
    if (node.tag === "ReportHeader")
      return (
        <header key={key} className={cls}>
          {Boolean(p.eyebrow) && (
            <p className="mb-4 text-xs font-medium tracking-widest text-foreground-muted uppercase">
              {text(p.eyebrow)}
            </p>
          )}
          <h1 className="max-w-4xl text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">
            {text(p.title)}
          </h1>
          {Boolean(p.summary) && (
            <p className="mt-4 max-w-3xl text-base leading-relaxed text-foreground-muted">
              {text(p.summary)}
            </p>
          )}
          {children}
          {Boolean(p.disclosure) && (
            <p className="mt-4 max-w-3xl text-xs leading-relaxed text-foreground-muted">
              {text(p.disclosure)}
            </p>
          )}
        </header>
      )
    if (node.tag === "Metrics")
      return (
        <div
          key={key}
          className={cn(
            "mt-6 grid grid-cols-1 gap-6 border-y border-border py-6 sm:gap-8",
            p.columns === 4
              ? "sm:grid-cols-4"
              : p.columns === 2
                ? "sm:grid-cols-2"
                : p.columns === 1
                  ? "sm:grid-cols-1"
                  : "sm:grid-cols-3",
            cls
          )}
        >
          {children}
        </div>
      )
    if (node.tag === "Metric") {
      const value = report.snapshot.evidence?.values.find(
        (v) => v.binding.id === p.binding
      )
      const Icon =
        p.tone === "warning"
          ? ArrowRight
          : (value?.value ?? 0) < 0
            ? ArrowDownRight
            : ArrowUpRight
      return (
        <div key={key} className={cn("min-w-0", cls)}>
          <p className="mb-3 text-sm text-foreground-muted">{text(p.label)}</p>
          <p className="font-mono text-4xl font-medium tracking-tight tabular-nums sm:text-5xl">
            {value?.formatted ?? "—"}
          </p>
          {Boolean(p.detail) && (
            <p
              className={cn(
                "mt-3 flex items-start gap-1.5 text-xs leading-relaxed",
                p.tone === "positive"
                  ? "text-success"
                  : p.tone === "warning"
                    ? "text-warning"
                    : "text-foreground-muted"
              )}
            >
              <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {text(p.detail)}
            </p>
          )}
        </div>
      )
    }
    if (node.tag === "Section")
      return (
        <section
          key={key}
          id={String(p.id)}
          className={cn("min-w-0 scroll-mt-6 space-y-5", cls)}
        >
          <div className="flex items-start gap-3">
            {Boolean(p.number) && (
              <span className="mt-1 font-mono text-xs text-foreground-subtle">
                {text(p.number)}
              </span>
            )}
            <div className="min-w-0">
              <h2 className="text-xl font-medium tracking-tight">
                {text(p.title)}
              </h2>
              {Boolean(p.description) && (
                <p className="mt-2 max-w-3xl text-sm leading-relaxed text-foreground-muted">
                  {text(p.description)}
                </p>
              )}
            </div>
          </div>
          {children}
        </section>
      )
    if (node.tag === "Details")
      return (
        <Disclosure
          key={key}
          id={String(p.id)}
          title={text(p.title)}
          className={cls}
        >
          {children}
        </Disclosure>
      )
    if (node.tag === "Callout")
      return (
        <aside
          key={key}
          className={cn(
            "max-w-3xl space-y-3 border-l-2 border-border py-1 pl-4 text-sm leading-relaxed",
            p.tone === "positive" && "border-success",
            p.tone === "warning" && "border-warning",
            cls
          )}
        >
          {children}
        </aside>
      )
    if (node.tag === "Comparison" || node.tag === "Scorecard") {
      const { source, title, description, className: _, ...settings } = p
      void _
      return (
        <div key={key} className={cls}>
          <ReportComparison
            report={report}
            comparison={
              { ...settings, widgetId: `source-${source}` } as Comparison
            }
            scorecard={node.tag === "Scorecard"}
            title={title ? text(title) : undefined}
            description={description ? text(description) : undefined}
          />
        </div>
      )
    }
    if (node.tag === "Progression") {
      const { source, className: _, ...settings } = p
      void _
      return (
        <div key={key} className={cn("min-w-0", cls)}>
          <ReportProgression
            report={report}
            progression={
              { ...settings, widgetId: `source-${source}` } as NonNullable<
                ReportPresentation["sections"][number]["progression"]
              >
            }
          />
        </div>
      )
    }
    if (node.widgetId) {
      const widget = report.config.widgets.find((w) => w.id === node.widgetId)!
      const plot = ["line", "stacked", "scatter"].includes(widget.type)
      return (
        <figure
          key={key}
          className={cn("min-w-0 overflow-hidden rounded-xl bg-muted", cls)}
        >
          {Boolean(p.title) && (
            <figcaption className="px-5 pt-5 pb-4 text-sm font-medium">
              {text(p.title)}
            </figcaption>
          )}
          <div
            className={cn(
              "min-w-0 py-2",
              plot &&
                (p.height === "large"
                  ? "h-96"
                  : p.height === "small"
                    ? "h-64"
                    : "h-80")
            )}
          >
            <FrozenReportWidget widget={widget} />
          </div>
          {Boolean(p.caption) && (
            <p className="px-5 pt-1 pb-5 text-xs leading-relaxed text-foreground-muted">
              {text(p.caption)}
            </p>
          )}
        </figure>
      )
    }
    if (node.tag === "table")
      return (
        <div key={key} className="min-w-0 overflow-x-auto">
          <table className={cn(prose.table, cls)}>{children}</table>
        </div>
      )
    return createElement(
      node.tag,
      { ...p, key, className: cn(prose[node.tag], cls) },
      node.tag === "br" || node.tag === "hr" ? undefined : (node.text ?? children)
    )
  }
  const warnings = [
    ...new Set(report.snapshot.results.flatMap((r) => r.meta.quality.warnings)),
  ]
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <FrozenDashboardRenderer
        widgets={report.config.widgets}
        snapshot={report.snapshot}
      >
        <article className="mx-auto w-full max-w-6xl px-4 pt-8 pb-16 sm:px-8">
          <div className="space-y-8 sm:space-y-10">
            {report.mdx?.nodes.map(render)}
          </div>
          <footer className="mt-12 border-t border-border pt-5 text-xs leading-relaxed text-foreground-muted">
            <p>
              Captured{" "}
              {new Date(report.frozenAt).toLocaleDateString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
                timeZone: "UTC",
              })}{" "}
              · Frozen evidence · Report #{report.number}
            </p>
            {warnings.map((warning, i) => (
              <p key={i} className="mt-2">
                {typeof warning === "string"
                  ? warning
                  : JSON.stringify(warning)}
              </p>
            ))}
          </footer>
        </article>
      </FrozenDashboardRenderer>
    </div>
  )
}
