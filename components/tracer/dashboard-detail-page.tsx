"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Check, Copy, Pencil, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DashboardSkeleton } from "@/components/ui/dashboard-skeleton"
import { Input } from "@/components/ui/input"
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { Combobox } from "@/components/ui/combobox"
import { dashboardWidgetOptions } from "./dashboard-widget-options"
import { Notice } from "@/components/ui/notice"
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog"
import {
  newDashboardWidget,
  type Dashboard,
  type DashboardWidget,
} from "@/src/lib/tracer/dashboards"
import type { SemanticCatalogMetadata } from "@/src/lib/semantic/catalog"
import { dashboardFilterScope } from "@/src/lib/tracer/dashboard-queries"
import { CollectionFilterBar } from "./collection-filter"
import { CollectionHeaderControls, HeaderSlot } from "./collection-header"
import { DashboardRenderer } from "./dashboard-renderer"
import {
  appendDashboardWidget,
  applyDashboardLayout,
  dashboardCanvasWidgets,
} from "./dashboard-canvas-layout"
import { DashboardRequestError, dashboardRequest } from "./dashboard-utils"
import { useDashboardAutosave } from "./use-dashboard-autosave"
import { useRemote } from "./hooks"
import { ErrorState } from "./primitives"
import { useCollectionFilter } from "./use-collection-filter"
import { useWorkspaceHref } from "./workspace-path"

export function DashboardDetailPage({ dashboardId }: { dashboardId: string }) {
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
      <div role="alert">
        <ErrorState error={state.error} onRetry={state.refresh} />
      </div>
    )
  if (!state.data) return <DashboardSkeleton />
  return <DashboardDetail key={dashboardId} dashboard={state.data} />
}

function DashboardName({
  value,
  onChange,
  readOnly,
}: {
  value: string
  onChange: (value: string) => void
  readOnly: boolean
}) {
  const [draft, setDraft] = React.useState({ source: value, text: value })
  if (draft.source !== value)
    setDraft({
      source: value,
      text: draft.text.trim() === value.trim() ? draft.text : value,
    })
  return (
    <div className="min-w-48 flex-1 space-y-1">
      <Input
        variant="title"
        aria-label="Dashboard name"
        readOnly={readOnly}
        maxLength={160}
        value={draft.text}
        invalid={!draft.text.trim()}
        onChange={(event) => {
          const text = event.target.value
          setDraft({ source: text.trim() ? text : value, text })
          if (text.trim()) onChange(text)
        }}
        onBlur={() => {
          if (!draft.text.trim()) setDraft({ source: value, text: value })
        }}
      />
      {!draft.text.trim() && (
        <p role="alert" className="text-xs text-destructive">
          A dashboard name is required.
        </p>
      )}
    </div>
  )
}

function DashboardDetail({ dashboard }: { dashboard: Dashboard }) {
  const router = useRouter()
  const workspaceHref = useWorkspaceHref()
  const save = useDashboardAutosave(dashboard)
  const opened = save.config
  const evalQuality =
    opened.widgets.length > 0 &&
    opened.widgets.every((widget) =>
      widget.query.measures.every(
        (measure) =>
          measure.startsWith("evalQuality.") ||
          measure.startsWith("evalResults.")
      )
    )
  const [editing, setEditing] = React.useState(dashboard.widgets.length === 0)
  const logFilter = useCollectionFilter(
    evalQuality ? "evalQuality" : "traces",
    `startedAt >= -${dashboard.defaultWindowDays ?? 3}d`
  )
  const [rangeEnd, setRangeEnd] = React.useState(() => Date.now())
  const [revision, setRevision] = React.useState(0)
  const [error, setError] = React.useState("")
  const [deleting, setDeleting] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const menuTriggerRef = React.useRef<HTMLButtonElement>(null)
  const deleteCancelRef = React.useRef<HTMLButtonElement>(null)
  const [cloning, setCloning] = React.useState(false)
  const catalogLoad = React.useCallback(
    (signal: AbortSignal) =>
      dashboardRequest<SemanticCatalogMetadata>(
        "/api/metrics/meta",
        "GET",
        undefined,
        { signal }
      ),
    []
  )
  const catalog = useRemote(catalogLoad, [])
  const scoped = React.useMemo(() => {
    try {
      return {
        scope: dashboardFilterScope(
          logFilter.filter,
          rangeEnd,
          Intl.DateTimeFormat().resolvedOptions().timeZone
        ),
        error: null,
      }
    } catch (cause) {
      return {
        scope: undefined,
        error: cause instanceof Error ? cause.message : "Invalid date filter.",
      }
    }
  }, [logFilter.filter, rangeEnd])
  const conflict =
    save.error instanceof DashboardRequestError && save.error.status === 409

  const saveStatus =
    save.status === "saving"
      ? "Saving…"
      : save.status === "error"
        ? "Not saved"
        : "Saved"

  async function cloneDashboard() {
    setCloning(true)
    setError("")
    try {
      const copied = await dashboardRequest<Dashboard>(
        "/api/dashboards",
        "POST",
        { ...opened, name: `${opened.name.slice(0, 153)} (copy)` }
      )
      router.push(workspaceHref(`/dashboards/${encodeURIComponent(copied.id)}`))
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to clone dashboard."
      )
    } finally {
      setCloning(false)
    }
  }

  function addWidget(newType: DashboardWidget["type"]) {
    const model =
      catalog.data?.models.find((item) => item.name === "traces") ??
      catalog.data?.models[0]
    if (!model || opened.widgets.length >= 20) return
    const widget = newDashboardWidget(model)
    widget.type = newType
    if (newType === "line" || newType === "stacked")
      widget.query.timeDimensions[0].granularity = "day"
    if (newType === "bar" || newType === "donut") {
      const group = model.members.find(
        (member) => member.kind === "dimension" && member.groupable !== false
      )
      if (group) widget.query.dimensions = [group.name]
      else widget.query.timeDimensions[0].granularity = "day"
    }
    save.update((current) => ({
      ...current,
      widgets: appendDashboardWidget(current.widgets, widget),
    }))
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3">
      <HeaderSlot name="title">
        <h1 className="truncate text-sm font-medium" title={opened.name}>
          {opened.name}
        </h1>
      </HeaderSlot>
      <CollectionHeaderControls
        showExport={false}
        menuTriggerRef={menuTriggerRef}
        onMenuCloseAutoFocus={(event) => {
          // The confirmation owns focus until it closes.
          if (deleteOpen) event.preventDefault()
        }}
        menuActions={
          <>
            <DropdownMenuLabel>
              <span className="text-xs text-foreground-muted">
                {saveStatus}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {!editing && (
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                <Pencil />
                Edit dashboard
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              disabled={save.pending || cloning || deleting}
              onSelect={() => void cloneDashboard()}
            >
              <Copy />
              {cloning ? "Cloning…" : "Clone dashboard"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={save.pending || deleting || cloning}
              onSelect={() => setDeleteOpen(true)}
            >
              <Trash2 />
              Delete dashboard
            </DropdownMenuItem>
          </>
        }
        onRefresh={() => {
          setRangeEnd(Date.now())
          setRevision((value) => value + 1)
        }}
      />
      <span
        role="status"
        aria-live="polite"
        aria-label="Dashboard save status"
        className="sr-only"
      >
        {saveStatus}
      </span>
      <div
        role="group"
        aria-label={editing ? "Dashboard editing" : "Dashboard controls"}
        className="flex shrink-0 flex-wrap items-center gap-3"
      >
        <DashboardName
          value={opened.name}
          readOnly={!editing}
          onChange={(name) => save.update((current) => ({ ...current, name }))}
        />
        {editing ? (
          <div className="flex max-w-full flex-wrap items-center gap-2">
            <Combobox
              label="Add widget"
              placeholder="Add widget"
              icon={<Plus />}
              className="h-8 w-44"
              options={[...dashboardWidgetOptions]}
              value={null}
              onValueChange={(type) =>
                addWidget(type as DashboardWidget["type"])
              }
              disabled={
                !catalog.data || !!catalog.error || opened.widgets.length >= 20
              }
            />
            <Button
              size="sm"
              aria-label="Done editing"
              onClick={() => setEditing(false)}
            >
              <Check />
              Done
            </Button>
          </div>
        ) : (
          <div className="min-w-0 flex-1 basis-80">
            <CollectionFilterBar
              resource={evalQuality ? "evalQuality" : "traces"}
              label={evalQuality ? "Filter evaluations" : undefined}
              value={logFilter.value}
              onChange={logFilter.onChange}
              error={logFilter.error}
            />
          </div>
        )}
      </div>
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent
          size="sm"
          initialFocus={deleteCancelRef}
          finalFocus={menuTriggerRef}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete dashboard?</AlertDialogTitle>
            <AlertDialogDescription>
              “{opened.name}” and its widget configuration will be removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={deleteCancelRef} disabled={deleting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              loading={deleting}
              onClick={async () => {
                setDeleting(true)
                setError("")
                try {
                  await dashboardRequest(
                    `/api/dashboards/${encodeURIComponent(dashboard.id)}?expectedRevision=${save.saved.revision}`,
                    "DELETE"
                  )
                  router.replace(workspaceHref("/dashboards"))
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Unable to delete dashboard."
                  )
                } finally {
                  setDeleting(false)
                  setDeleteOpen(false)
                }
              }}
            >
              Delete dashboard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {error && (
        <Notice role="alert" variant="error">
          {error}
        </Notice>
      )}
      {save.error && (
        <Notice role="alert" variant="error">
          <p>
            {conflict
              ? "This dashboard was changed elsewhere. Your edits are still visible, but have not been saved. Reload to use the latest version."
              : `Changes could not be saved: ${save.error.message}`}
          </p>
          {conflict ? (
            <AlertDialog>
              <AlertDialogTrigger
                render={<Button variant="outline" size="sm" />}
              >
                Reload latest version
              </AlertDialogTrigger>
              <AlertDialogContent size="sm">
                <AlertDialogHeader>
                  <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Reloading replaces your local edits with the latest saved
                    dashboard.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep editing</AlertDialogCancel>
                  <AlertDialogAction onClick={() => window.location.reload()}>
                    Reload dashboard
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void save.retry().catch(() => {})}
            >
              Retry saving
            </Button>
          )}
        </Notice>
      )}
      {editing && catalog.isLoading && (
        <p role="status" className="sr-only">
          Loading available metrics…
        </p>
      )}
      {editing && catalog.error && (
        <Notice role="alert" variant="error">
          {catalog.error.message}
          <Button variant="outline" size="sm" onClick={catalog.refresh}>
            Retry metrics
          </Button>
        </Notice>
      )}
      {scoped.error && (
        <Notice role="alert" variant="error">
          {scoped.error}
        </Notice>
      )}
      <DashboardRenderer
        widgets={opened.widgets}
        revision={revision}
        scope={scoped.scope}
        editable={editing}
        catalog={catalog}
        onLayoutChange={(changes) =>
          save.update((current) => ({
            ...current,
            widgets: applyDashboardLayout(current.widgets, changes),
          }))
        }
        onWidgetChange={(widget) =>
          save.update((current) => ({
            ...current,
            widgets: current.widgets.map((item) =>
              item.id === widget.id
                ? {
                    ...widget,
                    id: item.id,
                    width: item.width,
                    layout: item.layout,
                  }
                : item
            ),
          }))
        }
        onWidgetRemove={(id) =>
          save.update((current) => {
            const remaining = current.widgets.filter(
              (widget) => widget.id !== id
            )
            return {
              ...current,
              widgets: applyDashboardLayout(
                remaining,
                dashboardCanvasWidgets(remaining).map(({ id, layout }) => ({
                  id,
                  layout,
                }))
              ),
            }
          })
        }
      />
    </div>
  )
}
