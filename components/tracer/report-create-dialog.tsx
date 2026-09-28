"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Combobox } from "@/components/ui/combobox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Notice } from "@/components/ui/notice"
import { PanelActionLabel } from "@/components/ui/panel-action-label"
import { RadioCard } from "@/components/ui/radio-card"
import type { Dashboard } from "@/src/lib/tracer/dashboards"
import { reportTemplates } from "@/src/lib/tracer/report-templates"
import { dashboardRequest } from "./dashboard-utils"
import { useRemote } from "./hooks"
import { useWorkspaceHref } from "./workspace-path"

export function ReportCreateDialog({ entry = false }: { entry?: boolean }) {
  const router = useRouter()
  const href = useWorkspaceHref()
  const searchParams = useSearchParams()
  const id = React.useId()
  const [open, setOpen] = React.useState(entry)
  const [selected, setSelected] = React.useState(reportTemplates[0].id)
  const load = React.useCallback(
    (signal: AbortSignal) =>
      dashboardRequest<Dashboard[]>("/api/dashboards", "GET", undefined, {
        signal,
      }),
    []
  )
  const dashboards = useRemote(load, [], { enabled: open })

  function changeOpen(next: boolean) {
    if (!next && entry) {
      router.replace(href("/reports"))
      return
    }
    if (next) setSelected(reportTemplates[0].id)
    setOpen(next)
  }

  function create(event: React.FormEvent) {
    event.preventDefault()
    const params = new URLSearchParams()
    if (selected.startsWith("dashboard:"))
      params.set("dashboard", selected.slice(10))
    else params.set("template", selected)
    const filter = entry ? searchParams.get("filter") : null
    if (filter !== null) params.set("filter", filter)
    const destination = href(`/reports/new?${params}`)
    if (entry) router.replace(destination)
    else {
      router.push(destination)
      setOpen(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      {!entry && (
        <DialogTrigger asChild>
          <Button size="sm">
            <Plus className="size-4" />
            <PanelActionLabel className="@max-[640px]/page:sr-only">
              New report
            </PanelActionLabel>
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="max-w-3xl overflow-hidden p-0">
        <form
          onSubmit={create}
          className="flex max-h-[calc(100svh-2rem)] min-h-0 flex-col"
        >
          <DialogHeader className="shrink-0 px-5 pt-5 pb-4">
            <DialogTitle>Create report</DialogTitle>
            <DialogDescription>
              Choose a template or an existing dashboard, then customize your
              report before capturing its data.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-5 overflow-y-auto px-5 pb-5">
            <div
              role="radiogroup"
              aria-label="Report template"
              className="grid gap-3 sm:grid-cols-2"
            >
              {reportTemplates.map((template) => (
                <RadioCard
                  key={template.id}
                  name={`${id}-template`}
                  value={template.id}
                  checked={selected === template.id}
                  onChange={() => setSelected(template.id)}
                  aria-label={template.name}
                >
                  <span className="text-sm font-medium">{template.name}</span>
                  <span className="mt-1 block text-sm text-foreground-muted">
                    {template.description}
                  </span>
                </RadioCard>
              ))}
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">Or use a dashboard</p>
              <Combobox
                label="Use dashboard"
                className="w-full"
                value={
                  selected.startsWith("dashboard:") ? selected.slice(10) : ""
                }
                options={(dashboards.data ?? []).map((dashboard) => ({
                  value: dashboard.id,
                  label: dashboard.name,
                }))}
                placeholder={
                  dashboards.isLoading
                    ? "Loading dashboards…"
                    : "Choose an existing dashboard"
                }
                disabled={dashboards.isLoading || !!dashboards.error}
                onValueChange={(value) => setSelected(`dashboard:${value}`)}
              />
              {dashboards.error && (
                <Notice variant="error" role="alert">
                  {dashboards.error.message}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={dashboards.refresh}
                  >
                    Retry dashboards
                  </Button>
                </Notice>
              )}
            </div>
          </div>
          <DialogFooter className="shrink-0 border-t border-border px-5 py-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => changeOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit">Create report</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
