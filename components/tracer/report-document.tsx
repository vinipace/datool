"use client"

import { useState } from "react"
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react"
import { ContentDisclosure } from "@/components/ui/content-disclosure"
import { cn } from "@/lib/utils"
import type { Report } from "@/src/lib/tracer/reports"
import {
  reportPresentationText,
  type ReportPresentation,
} from "@/src/lib/tracer/report-presentation"
import {
  FrozenDashboardRenderer,
  FrozenReportWidget,
} from "./dashboard-renderer"
import { ReportProgression } from "./report-progression"
import { ReportComparison } from "./report-comparison"
import { composeReport } from "@/src/lib/tracer/report-recipe"

type Widget = ReportPresentation["sections"][number]["widgets"][number]

export function ReportDocument({
  report,
  presentation,
}: {
  report: Report
  presentation: ReportPresentation
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const composition = composeReport(report, presentation)
  const text = (value: string) => reportPresentationText(value, report)
  const renderWidgets = (items: Widget[]) => (
    <div className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-2">
      {items.map((item) => {
        const widget = report.config.widgets.find(
          (w) => w.id === item.widgetId
        )!
        const plot = ["line", "stacked", "scatter"].includes(widget.type)
        return (
          <figure
            key={item.widgetId}
            className={cn(
              "min-w-0 overflow-hidden rounded-xl bg-muted",
              item.width === "full" && "lg:col-span-2"
            )}
          >
            <figcaption className="px-5 pt-5 pb-4 text-sm font-medium">
              {text(item.title ?? widget.title)}
            </figcaption>
            <div className={cn("min-w-0 pb-2", plot && "h-80")}>
              <FrozenReportWidget widget={widget} />
            </div>
            {item.caption && (
              <p className="px-5 pt-1 pb-5 text-xs leading-relaxed text-foreground-muted">
                {text(item.caption)}
              </p>
            )}
          </figure>
        )
      })}
    </div>
  )
  const renderSections = (sections: ReportPresentation["sections"]) =>
    sections.map((section) => (
      <section
        key={section.id}
        id={section.id}
        className="scroll-mt-6 pt-8 sm:pt-10"
      >
        <div className="mb-5 flex items-start gap-3">
          <span className="mt-1 font-mono text-xs text-foreground-subtle">
            {String(
              presentation.sections.findIndex(
                (item) => item.id === section.id
              ) + 1
            ).padStart(2, "0")}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-medium tracking-tight">
              {text(section.title)}
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-foreground-muted">
              {text(section.description)}
            </p>
          </div>
        </div>
        <div className="space-y-4">
          {section.progression && (
            <ReportProgression
              report={report}
              progression={section.progression}
            />
          )}
          {renderWidgets(section.widgets)}
          {section.takeaway && (
            <p className="max-w-3xl border-l-2 border-border py-1 pl-4 text-sm leading-relaxed">
              {text(section.takeaway)}
            </p>
          )}
          {section.details.map((detail) => (
            <div key={detail.id} className="min-w-0 border-y border-border">
              <ContentDisclosure
                variant="report"
                contentPadding="none"
                id={detail.id}
                href={`#${detail.id}-answer`}
                title={text(detail.title)}
                open={!!expanded[detail.id]}
                onToggle={() =>
                  setExpanded((current) => ({
                    ...current,
                    [detail.id]: !current[detail.id],
                  }))
                }
              >
                <p className="mb-5 max-w-3xl text-sm leading-relaxed text-foreground-muted">
                  {text(detail.description)}
                </p>
                {expanded[detail.id] && renderWidgets(detail.widgets)}
              </ContentDisclosure>
            </div>
          ))}
        </div>
      </section>
    ))
  const warnings = [
    ...new Set(
      report.snapshot.results.flatMap((result) => result.meta.quality.warnings)
    ),
  ]
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <FrozenDashboardRenderer
        widgets={report.config.widgets}
        snapshot={report.snapshot}
      >
        <article className="mx-auto w-full max-w-6xl px-4 pt-8 pb-16 sm:px-8">
          <header>
            <p className="mb-4 text-xs font-medium tracking-widest text-foreground-muted uppercase">
              {text(presentation.eyebrow)}
            </p>
            <h1 className="max-w-4xl text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">
              {text(presentation.title)}
            </h1>
            <p className="mt-4 max-w-3xl text-base leading-relaxed text-foreground-muted">
              {text(presentation.summary)}
            </p>
            {presentation.metrics.length > 0 && (
              <div
                className={cn(
                  "mt-6 grid grid-cols-1 gap-6 border-y border-border py-6 sm:gap-8",
                  presentation.metrics.length === 4
                    ? "sm:grid-cols-4"
                    : presentation.metrics.length === 2
                      ? "sm:grid-cols-2"
                      : presentation.metrics.length === 1
                        ? "sm:grid-cols-1"
                        : "sm:grid-cols-3"
                )}
              >
                {presentation.metrics.map((metric) => {
                  const evidence = report.snapshot.evidence!.values.find(
                    (v) => v.binding.id === metric.evidenceId
                  )!
                  const Icon =
                    metric.tone === "warning"
                      ? ArrowRight
                      : evidence.value < 0
                        ? ArrowDownRight
                        : ArrowUpRight
                  return (
                    <div
                      key={metric.evidenceId}
                      className="grid grid-cols-[1fr_auto] items-center gap-x-4 sm:block"
                    >
                      <p className="text-sm text-foreground-muted sm:mb-3">
                        {text(metric.label)}
                      </p>
                      <p className="col-start-2 row-span-2 row-start-1 font-mono text-4xl font-medium tracking-tight tabular-nums sm:text-5xl">
                        {evidence.formatted}
                      </p>
                      <p
                        className={cn(
                          "col-start-1 mt-2 flex items-start gap-1.5 text-xs leading-relaxed sm:mt-3",
                          metric.tone === "positive"
                            ? "text-success"
                            : metric.tone === "warning"
                              ? "text-warning"
                              : "text-foreground-muted"
                        )}
                      >
                        <Icon
                          className="mt-0.5 size-3.5 shrink-0"
                          aria-hidden
                        />
                        {text(metric.detail)}
                      </p>
                    </div>
                  )
                })}
              </div>
            )}
            <p className="mt-4 max-w-3xl text-xs leading-relaxed text-foreground-muted">
              {text(presentation.disclosure)}
            </p>
          </header>
          <div className="mt-8 space-y-10 sm:space-y-14">
            {composition.blocks.map((block, index) => {
              if (block.type === "brief")
                return (
                  <div key={index} className="space-y-6">
                    {block.section?.progression ? (
                      <ReportProgression
                        report={report}
                        progression={block.section.progression}
                      />
                    ) : block.widget ? (
                      renderWidgets([{ ...block.widget, width: "full" }])
                    ) : null}
                    {presentation.sections.some(
                      (section) => section.takeaway
                    ) && (
                      <div>
                        <h2 className="mb-3 text-lg font-medium">
                          Key takeaways
                        </h2>
                        <ul className="max-w-3xl space-y-3 text-sm leading-relaxed">
                          {presentation.sections
                            .filter((section) => section.takeaway)
                            .map((section) => (
                              <li
                                key={section.id}
                                className="border-l-2 border-border pl-4"
                              >
                                {text(section.takeaway!)}
                              </li>
                            ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )
              if (block.type === "comparison" || block.type === "scorecard")
                return (
                  <ReportComparison
                    key={index}
                    report={report}
                    comparison={composition.comparison}
                    scorecard={block.type === "scorecard"}
                    title={block.title && text(block.title)}
                    description={block.description && text(block.description)}
                  />
                )
              if (block.type === "section")
                return <div key={index}>{renderSections([block.section])}</div>
              const id = `report-evidence-${index}`
              return (
                <div key={index} className="border-y border-border">
                  <ContentDisclosure
                    variant="report"
                    contentPadding="none"
                    id={id}
                    href={`#${id}-answer`}
                    title={text(block.title)}
                    open={!!expanded[id]}
                    onToggle={() =>
                      setExpanded((current) => ({
                        ...current,
                        [id]: !current[id],
                      }))
                    }
                  >
                    {expanded[id] && renderSections(block.sections)}
                  </ContentDisclosure>
                </div>
              )
            })}
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
            {warnings.map((warning, index) => (
              <p key={index} className="mt-2">
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
