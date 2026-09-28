"use client"
import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CodeEditor } from "@/components/ui/code-editor"
import { DashboardSkeleton } from "@/components/ui/dashboard-skeleton"
import { Notice } from "@/components/ui/notice"
import type { Dashboard, DashboardInput } from "@/src/lib/tracer/dashboards"
import type { Report } from "@/src/lib/tracer/reports"
import { reportTemplates } from "@/src/lib/tracer/report-templates"
import {
  dashboardReportDocument,
  parseReportFile,
  reportFileError,
  serializeReportFile,
  compileReportDocument,
  type ReportDocumentInput,
} from "@/src/lib/tracer/report-mdx"
import { HeaderSlot } from "./collection-header"
import { dashboardRequest } from "./dashboard-utils"
import { useRemote } from "./hooks"
import { useWorkspaceHref } from "./workspace-path"
import { ReportCreateDialog } from "./report-create-dialog"
import { ErrorState } from "./primitives"

export function NewReportPage() {
  const params = useSearchParams()
  const dashboardId = params.get("dashboard")
  if (dashboardId)
    return <DashboardReportEditor key={dashboardId} dashboardId={dashboardId} />
  const template = reportTemplates.find(
    (item) => item.id === params.get("template")
  )
  if (!template) return <ReportCreateDialog entry />
  return (
    <ReportEditor
      key={template.id}
      initialConfig={template.create()}
      templateId={template.id}
    />
  )
}

function DashboardReportEditor({ dashboardId }: { dashboardId: string }) {
  const load = React.useCallback(
    (signal: AbortSignal) =>
      dashboardRequest<Dashboard>(
        `/api/dashboards/${encodeURIComponent(dashboardId)}`,
        "GET",
        undefined,
        { signal }
      ),
    [dashboardId]
  )
  const state = useRemote(load, [dashboardId])
  if (state.error)
    return (
      <div role="alert" className="space-y-3 p-3">
        <ErrorState error={state.error} onRetry={state.refresh} />
        <ReportCreateDialog />
      </div>
    )
  if (!state.data) return <DashboardSkeleton />
  const dashboard = state.data
  return (
    <ReportEditor
      templateId={`dashboard:${dashboardId}`}
      initialConfig={{
        schemaVersion: 1,
        name: dashboard.name,
        description: dashboard.description,
        widgets: dashboard.widgets,
        defaultWindowDays: dashboard.defaultWindowDays,
      }}
    />
  )
}

function ReportEditor({
  initialConfig,
}: {
  initialConfig: DashboardInput
  templateId: string
}) {
  let document: ReportDocumentInput
  try {
    document = dashboardReportDocument(initialConfig)
  } catch (error) {
    return (
      <div className="space-y-4 p-4">
        <Notice variant="error" role="alert">
          {error instanceof Error
            ? error.message
            : "Unable to prepare this report."}
        </Notice>
        <ReportCreateDialog />
      </div>
    )
  }
  return <ReportSourceEditor initialDocument={document} />
}

function ReportSourceEditor({
  initialDocument,
}: {
  initialDocument: ReportDocumentInput
}) {
  const router = useRouter(),
    href = useWorkspaceHref()
  const [file, setFile] = React.useState(() =>
    serializeReportFile(initialDocument)
  )
  const [busy, setBusy] = React.useState(false),
    [error, setError] = React.useState("")
  const attempt = React.useRef<{ file: string; key: string } | null>(null)
  async function save() {
    if (busy) return
    try {
      setError("")
      const document = parseReportFile(file)
      compileReportDocument(document)
      if (attempt.current?.file !== file)
        attempt.current = { file, key: crypto.randomUUID() }
      setBusy(true)
      const report = await dashboardRequest<Report>("/api/reports", "POST", {
        ...document,
        creationKey: attempt.current.key,
      })
      router.push(href(`/reports/${report.number}`))
    } catch (e) {
      setError(reportFileError(e, file))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <HeaderSlot name="title">
        <h1 className="truncate text-sm font-medium">New report</h1>
      </HeaderSlot>
      <HeaderSlot name="actions">
        <Button
          size="icon-sm"
          aria-label="Save draft"
          title="Save draft"
          loading={busy}
          onClick={() => void save()}
        >
          <Save className="size-4" />
        </Button>
      </HeaderSlot>
      <div className="shrink-0 border-b border-border px-4 py-2 text-xs text-foreground-muted">
        report.mdx · YAML sources + MDX document
      </div>
      {error && (
        <Notice variant="error" role="alert">
          {error}
        </Notice>
      )}
      <CodeEditor
        value={file}
        onChange={setFile}
        readOnly={busy}
        language="markdown"
        label="Report MDX source"
        variant="embedded"
        className="min-h-0 flex-1"
      />
    </div>
  )
}
