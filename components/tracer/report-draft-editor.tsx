"use client"

import { useState, useEffect } from "react"
import { CodeEditor } from "@/components/ui/code-editor"
import { Notice } from "@/components/ui/notice"
import { Checkbox } from "@/components/ui/checkbox"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { Report } from "@/src/lib/tracer/reports"
import { compileReportDocument } from "@/src/lib/tracer/report-mdx"
import {
  parseReportBundle,
  reportBundleError,
  ReportBundleError,
  serializeReportBundle,
} from "@/src/lib/tracer/report-bundle"
import { dashboardRequest } from "./dashboard-utils"

export function ReportDraftEditor({
  report,
  onSaved,
  onBusyChange,
}: {
  report: Report
  onSaved: (report: Report) => void
  onBusyChange: (busy: boolean) => void
}) {
  const initial = serializeReportBundle(report.document!)
  const [mdx, setMdx] = useState(initial.mdx)
  const [data, setData] = useState(initial.data)
  const [source, setSource] = useState<"mdx" | "data">("mdx")
  const [error, setError] = useState("")
  const [refresh, setRefresh] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])
  return (
    <form
      id="report-mdx-editor"
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={async (event) => {
        event.preventDefault()
        if (busy) return
        setError("")
        try {
          const document = parseReportBundle(mdx, data)
          compileReportDocument(document)
          setBusy(true)
          onBusyChange(true)
          const saved = await dashboardRequest<Report>(
            `/api/reports/${report.number}/update`,
            "POST",
            { revision: report.revision, document, refresh }
          )
          setDirty(false)
          onSaved(saved)
        } catch (cause) {
          const errorSource =
            cause instanceof ReportBundleError
              ? cause.source
              : cause instanceof Error && cause.name === "ReportMdxError"
                ? "mdx"
                : source
          setSource(errorSource)
          setError(
            reportBundleError(
              cause,
              errorSource,
              errorSource === "mdx" ? mdx : data
            )
          )
        } finally {
          setBusy(false)
          onBusyChange(false)
        }
      }}
    >
      <Tabs
        value={source}
        onValueChange={(value) => {
          if (value !== "mdx" && value !== "data") return
          setSource(value)
          setError("")
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2 text-xs text-foreground-muted">
          <div className="flex min-w-0 items-center gap-2">
            <TabsList aria-label="Report source files" className="flex-wrap">
              <TabsTrigger value="mdx">report.mdx</TabsTrigger>
              <TabsTrigger value="data">report.data.json</TabsTrigger>
            </TabsList>
            <span aria-live="polite" className="ml-1">
              {dirty ? "Unsaved changes" : "Validated source bundle"}
            </span>
          </div>
          <label className="flex cursor-pointer items-center gap-2">
            <Checkbox
              checked={refresh}
              onChange={(event) => setRefresh(event.target.checked)}
              disabled={busy}
            />
            Refresh data on save
          </label>
        </div>
        {error && (
          <Notice variant="error" role="alert">
            <pre className="text-xs whitespace-pre-wrap">{error}</pre>
          </Notice>
        )}
        <TabsContent
          value="mdx"
          className="min-h-0 flex-1 flex-col data-[state=active]:flex data-[state=inactive]:hidden"
        >
          <CodeEditor
            value={mdx}
            onChange={(value) => {
              setMdx(value)
              setDirty(true)
            }}
            language="markdown"
            label="Report MDX source"
            readOnly={busy}
            variant="embedded"
            className="min-h-0 flex-1"
          />
        </TabsContent>
        <TabsContent
          value="data"
          className="min-h-0 flex-1 flex-col data-[state=active]:flex data-[state=inactive]:hidden"
        >
          <CodeEditor
            value={data}
            onChange={(value) => {
              setData(value)
              setDirty(true)
            }}
            language="json"
            label="Report data and evidence source"
            readOnly={busy}
            showPrettify
            variant="embedded"
            className="min-h-0 flex-1"
          />
        </TabsContent>
      </Tabs>
    </form>
  )
}
