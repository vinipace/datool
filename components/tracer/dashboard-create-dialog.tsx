"use client"

import { PanelActionLabel } from "@/components/ui/panel-action-label"
import * as React from "react"
import {
  Activity,
  ClipboardCheck,
  Coins,
  Gauge,
  LayoutDashboard,
  Plus,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import { RadioCard } from "@/components/ui/radio-card"
import {
  blankDashboard,
  dashboardTemplates,
} from "@/src/lib/tracer/dashboard-templates"
import type { Dashboard } from "@/src/lib/tracer/dashboards"
import { dashboardRequest } from "./dashboard-utils"
import { useWorkspaceHref } from "./workspace-path"

const templateIcons: Record<string, typeof Activity> = {
  "weekly-health": Activity,
  "llm-overview": LayoutDashboard,
  "cost-and-usage": Coins,
  latency: Gauge,
  evals: ClipboardCheck,
}

export function DashboardCreateDialog() {
  const router = useRouter()
  const workspaceHref = useWorkspaceHref()
  const id = React.useId()
  const [open, setOpen] = React.useState(false)
  const [selected, setSelected] = React.useState("blank")
  const [name, setName] = React.useState("Untitled dashboard")
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState("")
  const pending = React.useRef(false)
  const choices = React.useMemo(
    () =>
      dashboardTemplates.map((template) => ({
        ...template,
        widgetCount: template.create().widgets.length,
        Icon: templateIcons[template.id] ?? LayoutDashboard,
      })),
    []
  )

  function changeOpen(next: boolean) {
    if (pending.current) return
    if (next) {
      setSelected("blank")
      setName("Untitled dashboard")
      setError("")
    }
    setOpen(next)
  }

  function select(value: string) {
    const previousName =
      choices.find((choice) => choice.id === selected)?.name ??
      "Untitled dashboard"
    const nextName =
      choices.find((choice) => choice.id === value)?.name ??
      "Untitled dashboard"
    if (!name.trim() || name === previousName) setName(nextName)
    setSelected(value)
    setError("")
  }

  async function create(event: React.FormEvent) {
    event.preventDefault()
    if (pending.current || !name.trim()) return
    pending.current = true
    setCreating(true)
    setError("")
    try {
      const template = choices.find((choice) => choice.id === selected)
      const config = template ? template.create() : blankDashboard()
      const dashboard = await dashboardRequest<Dashboard>(
        "/api/dashboards",
        "POST",
        {
          ...config,
          name: name.trim(),
        }
      )
      router.push(
        workspaceHref(`/dashboards/${encodeURIComponent(dashboard.id)}`)
      )
      setOpen(false)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to create dashboard."
      )
      pending.current = false
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={creating}>
          <Plus />
          <PanelActionLabel>New dashboard</PanelActionLabel>
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-w-3xl overflow-hidden p-0"
        showCloseButton={!creating}
      >
        <form
          onSubmit={(event) => void create(event)}
          className="flex max-h-[calc(100svh-2rem)] min-h-0 flex-col"
        >
          <DialogHeader className="shrink-0 px-5 pt-5 pb-4">
            <DialogTitle>New dashboard</DialogTitle>
            <DialogDescription>
              Start blank or choose a template. Customize any widget after
              creating.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-5 overflow-y-auto px-5 pb-5">
            <fieldset disabled={creating} className="space-y-3">
              <legend className="sr-only">Dashboard starting point</legend>
              <RadioCard
                name={`${id}-template`}
                value="blank"
                checked={selected === "blank"}
                onChange={() => select("blank")}
                aria-label="Blank dashboard"
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <Plus aria-hidden="true" className="size-4" />
                  Blank dashboard
                </span>
                <span className="mt-1 block text-sm text-foreground-muted">
                  Start from scratch and add your own widgets.
                </span>
              </RadioCard>
              <p className="pt-2 text-xs font-medium text-foreground-muted">
                Template library
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {choices.map(
                  ({
                    id: value,
                    name: title,
                    description,
                    widgetCount,
                    Icon,
                  }) => (
                    <RadioCard
                      key={value}
                      name={`${id}-template`}
                      value={value}
                      checked={selected === value}
                      onChange={() => select(value)}
                      aria-label={title}
                    >
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <Icon aria-hidden="true" className="size-4 shrink-0" />
                        {title}
                      </span>
                      <span className="mt-2 block text-sm text-foreground-muted">
                        {description}
                      </span>
                      <span className="mt-3 block text-xs text-foreground-muted">
                        {widgetCount} widgets · Last 7 days
                      </span>
                    </RadioCard>
                  )
                )}
              </div>
            </fieldset>
            <label
              className="grid gap-2 text-sm font-medium"
              htmlFor={`${id}-name`}
            >
              Dashboard name
              <Input
                id={`${id}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={160}
                required
                disabled={creating}
                autoComplete="off"
              />
            </label>
          </div>
          <div className="shrink-0 space-y-3 border-t border-border px-5 py-4">
            {error ? (
              <Notice role="alert" variant="error">
                {error}
              </Notice>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => changeOpen(false)}
                disabled={creating}
              >
                Cancel
              </Button>
              <Button type="submit" loading={creating} disabled={!name.trim()}>
                {creating ? "Creating dashboard…" : "Create dashboard"}
              </Button>
            </DialogFooter>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
