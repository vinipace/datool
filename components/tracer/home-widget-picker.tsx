"use client"

import { useState } from "react"
import Link from "next/link"
import { Check, Pin } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  HOME_WIDGET_LIMIT,
  type ProjectHome,
} from "@/src/lib/tracer/project-home"
import type { DashboardListEntry } from "@/src/lib/tracer/dashboards"
import { dashboardRequest } from "./dashboard-utils"
import { useRemote } from "./hooks"
import { useWorkspaceHref } from "./workspace-path"
import { useProjectScope } from "./project-scope-context"

export function HomeWidgetPicker({
  open,
  onOpenChange,
  home,
  pending,
  error,
  onPin,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  home: ProjectHome
  pending: boolean
  error: string
  onPin: (dashboardId: string, widgetId: string) => Promise<unknown>
}) {
  const [search, setSearch] = useState("")
  const projectId = useProjectScope()?.projectId
  const href = useWorkspaceHref()
  const sources = useRemote(
    (signal) =>
      dashboardRequest<DashboardListEntry[]>(
        "/api/dashboards",
        "GET",
        undefined,
        { signal, projectId }
      ),
    [projectId, open],
    { enabled: open }
  )
  const dashboards =
    sources.data?.filter((dashboard) => !("unavailable" in dashboard)) ?? []
  const query = search.trim().toLowerCase()
  const matches = dashboards.flatMap((dashboard) =>
    "widgets" in dashboard
      ? dashboard.widgets
          .filter((widget) =>
            `${dashboard.name} ${widget.title}`.toLowerCase().includes(query)
          )
          .map((widget) => ({ dashboard, widget }))
      : []
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Pin widgets to Home</DialogTitle>
          <DialogDescription>
            Choose from your dashboards. Pinned widgets stay in sync with their
            source.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Search dashboard widgets"
          placeholder="Search widgets or dashboards…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <p className="text-xs text-foreground-muted">
          {home.pins.length} of {HOME_WIDGET_LIMIT} widgets pinned · Shared with
          this project
        </p>
        {error && (
          <Notice variant="error" role="alert">
            {error}
          </Notice>
        )}
        {sources.error && (
          <Notice variant="error" role="alert">
            {sources.error.message}
            <Button variant="outline" size="sm" onClick={sources.refresh}>
              Retry
            </Button>
          </Notice>
        )}
        <div className="max-h-[50dvh] overflow-auto">
          {sources.isLoading ? (
            <p
              role="status"
              className="py-8 text-center text-sm text-foreground-muted"
            >
              Loading widgets…
            </p>
          ) : matches.length ? (
            <ul className="divide-y divide-border">
              {matches.map(({ dashboard, widget }) => {
                const pinned = home.pins.some(
                  (pin) =>
                    pin.dashboardId === dashboard.id &&
                    pin.widgetId === widget.id
                )
                return (
                  <li
                    key={`${dashboard.id}:${widget.id}`}
                    className="flex items-center gap-3 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {widget.title}
                      </p>
                      <p className="truncate text-xs text-foreground-muted">
                        {dashboard.name}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        pending ||
                        pinned ||
                        home.pins.length >= HOME_WIDGET_LIMIT
                      }
                      aria-label={
                        pinned
                          ? `${widget.title} is pinned`
                          : `Pin ${widget.title}`
                      }
                      onClick={() => void onPin(dashboard.id, widget.id)}
                    >
                      {pinned ? <Check /> : <Pin />}
                      {pinned ? "Pinned" : "Pin"}
                    </Button>
                  </li>
                )
              })}
            </ul>
          ) : (
            !sources.error && (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <p className="text-sm text-foreground-muted">
                  {query
                    ? "No widgets match your search."
                    : "Create a dashboard to start pinning widgets."}
                </p>
                {!query && (
                  <Button variant="outline" asChild>
                    <Link href={href("/dashboards")}>Open dashboards</Link>
                  </Button>
                )}
              </div>
            )
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
