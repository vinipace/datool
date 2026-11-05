"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import {
  ArrowUpRight,
  Check,
  LayoutDashboard,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { DashboardSkeleton } from "@/components/ui/dashboard-skeleton"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import type { ProjectHome } from "@/src/lib/tracer/project-home"
import { dashboardFilterScope } from "@/src/lib/tracer/dashboard-queries"
import { CollectionHeaderControls, HeaderSlot } from "./collection-header"
import { DashboardRenderer } from "./dashboard-renderer"
import { ErrorState } from "./primitives"
import { HomeWidgetPicker } from "./home-widget-picker"
import { useProjectHome } from "./use-project-home"
import { useWorkspaceHref } from "./workspace-path"
import { useProjectScope } from "./project-scope-context"
import { ProjectHomeAgents } from "./project-home-agents"

export function ProjectHomePage({
  buildEnabled = false,
}: {
  buildEnabled?: boolean
}) {
  const projectId = useProjectScope()?.projectId
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {buildEnabled && <ProjectHomeAgents key={`agents:${projectId}`} />}
      <ProjectHomeContent key={projectId} />
    </div>
  )
}

function ProjectHomeContent() {
  const store = useProjectHome()
  const home = store.home
  const href = useWorkspaceHref()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [draft, setDraft] = useState<ProjectHome | null>(null)
  const [revision, setRevision] = useState(0)
  const [rangeEnd, setRangeEnd] = useState(() => Date.now())
  const scoped = useMemo(() => {
    try {
      return {
        scope: dashboardFilterScope(
          "startedAt >= -7d",
          rangeEnd,
          Intl.DateTimeFormat().resolvedOptions().timeZone
        ),
      }
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : "Choose a valid date range.",
      }
    }
  }, [rangeEnd])
  const current = draft ?? home
  const unavailable = home?.pins.filter((pin) => pin.unavailable) ?? []
  if (!home && store.state.error)
    return <ErrorState error={store.state.error} onRetry={store.refresh} />
  if (!current || !home) return <DashboardSkeleton />

  return (
    <div className="flex min-h-80 flex-col gap-3 p-3">
      <CollectionHeaderControls
        showExport={false}
        onRefresh={() => {
          store.refresh()
          setRangeEnd(Date.now())
          setRevision((value) => value + 1)
        }}
      />
      <HeaderSlot name="actions">
        {draft ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={store.pending}
              onClick={() => setDraft(null)}
            >
              <X />
              Cancel
            </Button>
            <Button
              size="sm"
              loading={store.pending}
              onClick={async () => {
                const saved = await store.saveLayout(
                  draft.pins.map(({ id, layout }) => ({ id, layout })),
                  draft.revision
                )
                if (saved) setDraft(null)
              }}
            >
              <Check />
              Save layout
            </Button>
          </>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Edit Home"
                title="Edit Home"
                disabled={store.pending}
              >
                <Pencil />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setPickerOpen(true)}>
                <Plus />
                Pin widgets
              </DropdownMenuItem>
              {home.widgets.length > 0 && (
                <DropdownMenuItem
                  className="hidden md:flex"
                  disabled={unavailable.length > 0}
                  onSelect={() => setDraft(home)}
                >
                  <LayoutDashboard />
                  Arrange widgets
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </HeaderSlot>
      {store.error && (
        <Notice variant="error" role="alert">
          {store.error}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDraft(null)
              store.refresh()
            }}
          >
            Reload Home
          </Button>
        </Notice>
      )}
      {store.state.error && (
        <Notice variant="error" role="alert">
          {store.state.error.message}
          <Button variant="outline" size="sm" onClick={store.refresh}>
            Retry
          </Button>
        </Notice>
      )}
      {scoped.error && (
        <Notice variant="error" role="alert">
          {scoped.error}
        </Notice>
      )}
      {unavailable.map((pin) => (
        <Notice key={pin.id} variant="warning" title={pin.title}>
          {pin.unavailable}
          <Button
            variant="outline"
            size="sm"
            disabled={store.pending}
            onClick={() => void store.unpin(pin.id)}
          >
            <PinOff />
            Unpin {pin.title}
          </Button>
        </Notice>
      ))}
      {home.pins.length === 0 ? (
        <div className="flex min-h-72 flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border p-6 text-center">
          <Pin className="size-6 text-foreground-muted" />
          <div className="space-y-2">
            <h2 className="text-base font-medium">Your project at a glance</h2>
            <p className="max-w-sm text-sm text-foreground-muted">
              Pin the metrics and charts you check most often. Choose widgets
              from any dashboard in this project.
            </p>
          </div>
          <Button variant="outline" onClick={() => setPickerOpen(true)}>
            <Plus />
            Choose widgets
          </Button>
        </div>
      ) : (
        current.widgets.length > 0 &&
        !scoped.error && (
          <DashboardRenderer
            widgets={current.widgets}
            scope={scoped.scope}
            revision={revision}
            editable={!!draft && !store.pending}
            onLayoutChange={(changes) =>
              setDraft((value) => {
                if (!value) return value
                const positions = new Map(
                  changes.map(({ id, layout: { x, y, w, h } }) => [
                    id,
                    { x, y, w, h },
                  ])
                )
                return {
                  ...value,
                  pins: value.pins.map((pin) => ({
                    ...pin,
                    layout: positions.get(pin.id) ?? pin.layout,
                  })),
                  widgets: value.widgets.map((widget) => ({
                    ...widget,
                    layout: positions.get(widget.id) ?? widget.layout,
                  })),
                }
              })
            }
            widgetActions={(widget) => {
              const pin = current.pins.find((pin) => pin.id === widget.id)!
              return (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost-muted"
                      size="icon-sm"
                      aria-label={`Actions for ${widget.title}`}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem asChild>
                      <Link
                        href={href(
                          `/dashboards/${encodeURIComponent(pin.dashboardId)}`
                        )}
                      >
                        <ArrowUpRight />
                        Open {pin.dashboardName}
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={store.pending || !!draft}
                      onSelect={() => void store.unpin(pin.id)}
                    >
                      <PinOff />
                      Unpin from Home
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )
            }}
          />
        )
      )}
      <HomeWidgetPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        home={home}
        pending={store.pending}
        error={store.error}
        onPin={store.pin}
      />
    </div>
  )
}
