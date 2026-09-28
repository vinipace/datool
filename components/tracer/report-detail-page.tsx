"use client"

import * as React from "react"
import {
  Download,
  Pencil,
  Share2,
  Copy,
  Check,
  Send,
  Save,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { DashboardSkeleton } from "@/components/ui/dashboard-skeleton"
import { PanelActionLabel } from "@/components/ui/panel-action-label"
import type { Report } from "@/src/lib/tracer/reports"
import { FrozenDashboardRenderer } from "./dashboard-renderer"
import { dashboardRequest } from "./dashboard-utils"
import { HeaderSlot } from "./collection-header"
import { useRemote } from "./hooks"
import { ReportCreateDialog } from "./report-create-dialog"
import { ErrorState } from "./primitives"
import { ReportDocument } from "./report-document"
import { ReportMdxDocument } from "./report-mdx-document"
import { serializeReportFile } from "@/src/lib/tracer/report-mdx"
import { ReportDraftEditor } from "./report-draft-editor"
import { Notice } from "@/components/ui/notice"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { useRouter } from "next/navigation"
import { useWorkspaceHref } from "./workspace-path"

export function ReportDetailPage({ reportNumber }: { reportNumber: string }) {
  const load = React.useCallback(
    (signal: AbortSignal) =>
      dashboardRequest<Report>(
        `/api/reports/${encodeURIComponent(reportNumber)}`,
        "GET",
        undefined,
        { signal }
      ),
    [reportNumber]
  )
  const state = useRemote(load, [reportNumber])
  if (state.data)
    return <LoadedReport key={state.data.id} initialReport={state.data} />
  if (state.error)
    return (
      <div role="alert" className="mx-auto w-full max-w-6xl p-3">
        <ErrorState error={state.error} onRetry={state.refresh} />
      </div>
    )
  if (!state.data)
    return (
      <div className="mx-auto h-full w-full max-w-6xl">
        <DashboardSkeleton />
      </div>
    )
  return null
}

function LoadedReport({ initialReport }: { initialReport: Report }) {
  const [report, setReport] = React.useState(initialReport)
  const [editing, setEditing] = React.useState(false)
  const [dialog, setDialog] = React.useState<"publish" | "share" | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [copied, setCopied] = React.useState(false)
  const router = useRouter()
  const href = useWorkspaceHref()
  const draft = report.status === "draft"
  const cloneKey = React.useRef(crypto.randomUUID())
  async function mutate(
    action: "publish" | "share" | "clone",
    extra: object = {}
  ) {
    setBusy(true)
    setError("")
    try {
      const saved = await dashboardRequest<Report>(
        `/api/reports/${report.number}/${action}`,
        "POST",
        action === "clone"
          ? { creationKey: cloneKey.current }
          : { revision: report.revision, ...extra }
      )
      if (action === "clone") router.push(href(`/reports/${saved.number}`))
      else {
        setReport(saved)
        if (action === "publish") setDialog(null)
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to update report."
      )
    } finally {
      setBusy(false)
    }
  }
  const publicUrl =
    report.publicPath && typeof window !== "undefined"
      ? new URL(report.publicPath, window.location.origin).href
      : ""
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <HeaderSlot name="title">
        <h1 className="truncate text-sm font-medium">
          #{report.number} · {report.name}
        </h1>
      </HeaderSlot>
      <HeaderSlot name="actions">
        {draft && report.document && (
          <Button
            size="icon-sm"
            variant="outline"
            type={editing ? "submit" : "button"}
            form={editing ? "report-mdx-editor" : undefined}
            aria-label={editing ? "Save draft" : "Edit draft"}
            title={editing ? "Save draft" : "Edit draft"}
            loading={busy}
            onClick={
              editing
                ? undefined
                : (event) => {
                    event.preventDefault()
                    setEditing(true)
                  }
            }
          >
            {editing ? (
              <Save className="size-4" />
            ) : (
              <Pencil className="size-4" />
            )}
          </Button>
        )}
        {editing && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Cancel editing"
            title="Cancel editing"
            disabled={busy}
            onClick={() => setEditing(false)}
          >
            <X className="size-4" />
          </Button>
        )}
        {!editing &&
          (draft ? (
            <Button size="sm" onClick={() => setDialog("publish")}>
              <Send className="size-4" />
              <PanelActionLabel className="@max-[640px]/page:sr-only">
                Publish
              </PanelActionLabel>
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                loading={busy}
                onClick={() => void mutate("clone")}
              >
                <Copy className="size-4" />
                <PanelActionLabel className="@max-[640px]/page:sr-only">
                  Create draft copy
                </PanelActionLabel>
              </Button>
              <Button size="sm" onClick={() => setDialog("share")}>
                <Share2 className="size-4" />
                <PanelActionLabel className="@max-[640px]/page:sr-only">
                  Share
                </PanelActionLabel>
              </Button>
            </>
          ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob(
                [
                  report.document
                    ? serializeReportFile(report.document)
                    : JSON.stringify(report, null, 2),
                ],
                {
                  type: report.document ? "text/mdx" : "application/json",
                }
              )
            )
            const anchor = document.createElement("a")
            anchor.href = url
            anchor.download = `report-${report.number}.${report.document ? "mdx" : "json"}`
            anchor.click()
            setTimeout(() => URL.revokeObjectURL(url), 1000)
          }}
        >
          <Download className="size-4" />
          <PanelActionLabel className="@max-[640px]/page:sr-only">
            Export report
          </PanelActionLabel>
        </Button>
        <ReportCreateDialog />
      </HeaderSlot>
      {error && !dialog && (
        <Notice variant="error" role="alert">
          {error}
        </Notice>
      )}
      <div className="shrink-0 border-b border-border px-4 py-2 text-xs text-foreground-muted">
        {draft
          ? "Draft · Private · Review and edit before publishing"
          : "Published · Read-only"}
        {!draft &&
          (report.publicPath ? " · Public link enabled" : " · Private")}
      </div>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setDialog(null)
            setError("")
            setCopied(false)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog === "publish" ? "Publish this report?" : "Share report"}
            </DialogTitle>
            <DialogDescription>
              {dialog === "publish"
                ? "Publish the version you reviewed. Its content and captured data will be locked. It stays private until you enable a public link."
                : "Anyone with the public link can read this report, including captured rows and expandable evidence. You can revoke the link at any time."}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Notice variant="error" role="alert">
              {error}
            </Notice>
          )}
          {dialog === "share" && publicUrl && (
            <label className="grid gap-2 text-sm">
              Public link
              <Input
                readOnly
                value={publicUrl}
                onFocus={(e) => e.target.select()}
              />
            </label>
          )}
          <DialogFooter>
            {dialog === "publish" ? (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setDialog(null)}
                >
                  Keep reviewing
                </Button>
                <Button loading={busy} onClick={() => void mutate("publish")}>
                  Publish report
                </Button>
              </>
            ) : publicUrl ? (
              <>
                <Button
                  variant="outline"
                  loading={busy}
                  onClick={() => void mutate("share", { enabled: false })}
                >
                  Revoke public link
                </Button>
                <Button
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(publicUrl)
                      .then(() => setCopied(true))
                      .catch(() =>
                        setError(
                          "Could not copy. Select and copy the link above."
                        )
                      )
                  }}
                >
                  {copied ? (
                    <Check className="size-4" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                  {copied ? "Copied" : "Copy link"}
                </Button>
              </>
            ) : (
              <Button
                loading={busy}
                onClick={() => void mutate("share", { enabled: true })}
              >
                Enable public link
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="flex min-h-0 flex-1 flex-col">
        {editing ? (
          <ReportDraftEditor
            report={report}
            onSaved={(saved) => {
              setReport(saved)
              setEditing(false)
            }}
            onBusyChange={setBusy}
          />
        ) : report.mdx ? (
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
      </div>
    </div>
  )
}
