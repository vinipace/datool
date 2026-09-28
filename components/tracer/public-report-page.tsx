"use client"

import { ReportMdxDocument } from "./report-mdx-document"
import type { Report } from "@/src/lib/tracer/reports"
import { ReportDocument } from "./report-document"
import { FrozenDashboardRenderer } from "./dashboard-renderer"
export function PublicReportPage({ report }: { report: Report }) {
  return (
    <main className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-4 py-3 text-sm">
        <span className="truncate font-medium">{report.name}</span>
        <span className="shrink-0 text-xs text-foreground-muted">
          Published report · Datool
        </span>
      </header>
      {report.mdx ? (
        <ReportMdxDocument report={report} />
      ) : report.presentation ? (
        <ReportDocument report={report} presentation={report.presentation} />
      ) : (
        <FrozenDashboardRenderer
          widgets={report.config.widgets}
          snapshot={report.snapshot}
          contentClassName="mx-auto w-full max-w-6xl p-3"
        />
      )}
    </main>
  )
}
