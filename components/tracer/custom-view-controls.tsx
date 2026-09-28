"use client"

import * as React from "react"
import { Dialog } from "radix-ui"
import { Combobox } from "@base-ui/react/combobox"
import { Bookmark, Check, ChevronDown, History, Plus, Save, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { customViewsApi } from "./api"
import { HeaderSlot, headerButtonClass } from "./collection-header"
import {
  sameViewSettings,
  viewHistory,
  type CustomView,
  type EvalViewSettings,
} from "@/src/lib/tracer/custom-views"

const resourceLabels: Record<CustomView["resource"], string> = {
  "eval-runs": "eval runs",
  "playground-traces": "playground trace tables",
  agents: "Agents tables",
  workflows: "Workflows tables",
  scorers: "Scorers tables",
  reports: "Reports tables",
  prompts: "Prompts tables",
}

export function CustomViewControls({
  resource = "eval-runs",
  settings,
  onApply,
  viewId,
  onSelect,
}: {
  resource?: CustomView["resource"]
  settings: EvalViewSettings
  onApply: (settings: EvalViewSettings) => void
  viewId: string | null
  onSelect: (id: string | null) => void
}) {
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const [views, setViews] = React.useState<CustomView[]>([])
  const [selected, setSelected] = React.useState<CustomView | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [loading, setLoading] = React.useState(!!viewId)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [dialog, setDialog] = React.useState<
    "save" | "history" | "delete" | null
  >(null)
  const [name, setName] = React.useState("")
  const [versions, setVersions] = React.useState<CustomView[]>([])
  const [requestedView, setRequestedView] = React.useState({ viewId, resource })
  if (viewId !== requestedView.viewId || resource !== requestedView.resource) {
    setRequestedView({ viewId, resource })
    const isSelected = selected?.id === viewId && selected?.resource === resource
    if (!isSelected) setSelected(null)
    setLoading(!!viewId && !isSelected)
    setError(null)
  }
  const dirty =
    selected !== null && !sameViewSettings(selected.settings, settings)
  const unavailable = busy || loading || (!!viewId && selected?.id !== viewId)

  React.useEffect(() => {
    let active = true
    void customViewsApi
      .list(resource)
      .then((views) => {
        if (active) setViews(views)
      })
      .catch((error) => {
        if (active) setError(error.message)
      })
    return () => {
      active = false
    }
  }, [resource])

  React.useEffect(() => {
    if (!viewId || selected?.id === viewId) return
    let active = true
    void customViewsApi
      .get(viewId)
      .then((view) => {
        if (!active) return
        if (view.resource !== resource) throw new Error("This view belongs to another table type.")
        onApply(view.settings)
        setLoading(false)
        setSelected(view)
        setViews((current) => [
          view,
          ...current.filter((item) => item.id !== view.id),
        ])
        try {
          viewHistory(localStorage, view.id).remember(view)
        } catch {
          setNotice(
            "View loaded. Local version history is unavailable in this browser."
          )
        }
      })
      .catch((error) => {
        if (active) setError(error.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [viewId, selected?.id, onApply, resource])

  const accept = (view: CustomView, apply = false) => {
    if (apply) onApply(view.settings)
    setSelected(view)
    setViews((current) => [
      view,
      ...current.filter((item) => item.id !== view.id),
    ])
    onSelect(view.id)
    try {
      viewHistory(localStorage, view.id).remember(view)
    } catch {
      setNotice(
        "View saved in the database, but this browser could not store its local version history."
      )
    }
    setDialog(null)
  }
  const perform = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not save the view."
      )
    } finally {
      setBusy(false)
    }
  }
  const save = (asNew: boolean, restored?: CustomView) =>
    perform(async () => {
      if (asNew) {
        accept(
          await customViewsApi.create({ name, resource, settings })
        )
      } else if (selected) {
        // Preserve the previous DB revision before replacing it. If storage fails,
        // don't claim the user can roll back a save that has no local snapshot.
        try {
          viewHistory(localStorage, selected.id).remember(selected)
        } catch {
          throw new Error(
            "Could not preserve the previous version in this browser. Free some browser storage or save as a new view."
          )
        }
        accept(
          await customViewsApi.update(selected.id, {
            name: restored?.name ?? selected.name,
            resource,
            settings: restored?.settings ?? settings,
            expectedRevision: selected.revision,
          }),
          !!restored
        )
      }
    })
  const switchView = (id: string) => {
    if (dirty && !window.confirm("Discard unsaved changes and switch views?"))
      return
    setSelected(null)
    setError(null)
    setNotice(null)
    onSelect(id || null)
  }
  const openHistory = () => {
    if (!selected) return
    try {
      const history = viewHistory(localStorage, selected.id)
      history.remember(selected)
      setVersions(history.read())
      setDialog("history")
      setError(null)
    } catch {
      setError("Local version history could not be read in this browser.")
    }
  }

  return (
    <>
      <HeaderSlot name="filter">
        <Combobox.Root items={views} value={selected} open={pickerOpen} onOpenChange={setPickerOpen}
          itemToStringLabel={view => view.name} isItemEqualToValue={(a, b) => a.id === b.id}
          onValueChange={view => { if (view) switchView(view.id) }}>
          <Combobox.Trigger render={<Button variant="ghost" className={`${headerButtonClass} max-w-52 border-0`} />} disabled={busy || loading} aria-label="Custom view">
            <Bookmark className="size-3.5 @min-[640px]/page:hidden" />
            <span className="hidden truncate @min-[640px]/page:inline">{selected?.name ?? (viewId ? "Loading view…" : "Unsaved view")}</span>
            {dirty && <span className="size-1.5 shrink-0 rounded-full bg-info" aria-label="Unsaved changes" />}
            <ChevronDown className="hidden size-3.5 shrink-0 @min-[640px]/page:block" />
          </Combobox.Trigger>
          <Combobox.Portal>
            <Combobox.Positioner sideOffset={4} align="end" className="z-50">
              <Combobox.Popup aria-label="Saved views" className="w-72 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
                <Combobox.Input aria-label="Search views" placeholder="Search views…" className="h-9 w-full border-b bg-transparent px-3 text-sm outline-none" />
                <Combobox.Empty className="p-3 text-sm text-muted-foreground">No views found.</Combobox.Empty>
                <Combobox.List className="max-h-60 overflow-y-auto p-1">
                  {(view: CustomView) => <Combobox.Item key={view.id} value={view} className="flex cursor-pointer items-center justify-between rounded-sm px-2 py-1.5 text-sm data-highlighted:bg-accent data-highlighted:text-accent-foreground">
                    {view.name}<Combobox.ItemIndicator><Check className="size-3.5" /></Combobox.ItemIndicator>
                  </Combobox.Item>}
                </Combobox.List>
                <div className="space-y-1 border-t p-1">
                  <Button variant="ghost" className="w-full justify-start text-xs" disabled={unavailable || !selected || !dirty} onClick={() => { setPickerOpen(false); void save(false) }}>
                    <Save className="size-3.5" />Save changes to view
                  </Button>
                  <Button variant="ghost" className="w-full justify-start text-xs" disabled={busy || loading} onClick={() => {
                    setPickerOpen(false)
                    setName(selected ? `${selected.name} copy` : "")
                    setError(null)
                    setDialog("save")
                  }}><Plus className="size-3.5" />Create new view with changes</Button>
                  {selected && <Button variant="ghost" className="w-full justify-start text-xs" disabled={unavailable} onClick={() => { setPickerOpen(false); openHistory() }}><History className="size-3.5" />View history</Button>}
                </div>
              </Combobox.Popup>
            </Combobox.Positioner>
          </Combobox.Portal>
        </Combobox.Root>
      </HeaderSlot>
      {loading ? (
        <p className="mb-2 text-xs text-muted-foreground" role="status">
          Loading saved view…
        </p>
      ) : null}
      {error && !dialog ? (
        <div
          className="mb-2 flex items-center gap-2 text-xs text-destructive"
          role="alert"
        >
          {error}
          {viewId ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || loading}
              onClick={() =>
                void perform(async () => {
                  if (
                    dirty &&
                    !window.confirm(
                      "Discard unsaved changes and reload the saved view?"
                    )
                  )
                    return
                  accept(await customViewsApi.get(viewId), true)
                })
              }
            >
              Reload saved view
            </Button>
          ) : null}
        </div>
      ) : null}
      {notice ? (
        <p className="mb-2 text-xs text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}
      <Dialog.Root
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[85vh] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-xl">
            <Dialog.Title className="text-base font-semibold">
              {dialog === "save"
                ? "Save custom view"
                : dialog === "delete"
                  ? "Delete custom view"
                  : `${selected?.name} · Version history`}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-muted-foreground">
              {dialog === "save"
                ? `Save columns, formulas, widths, visibility, and table/card layout. This view will be available on ${resourceLabels[resource]} in this project, across browsers.`
                : dialog === "delete"
                  ? "Remove this saved view from the database. Your current table layout and local history will remain."
                  : "The latest 50 saved versions seen in this browser are kept locally. Restoring creates a new database revision. Other browsers keep their own history."}
            </Dialog.Description>
            <Dialog.Close
              disabled={busy}
              className="absolute top-4 right-4"
              aria-label="Close view dialog"
            >
              <X className="size-4" />
            </Dialog.Close>
            {dialog === "save" ? (
              <form
                className="mt-4 space-y-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  void save(true)
                }}
              >
                <label className="block text-sm">
                  View name
                  <input
                    autoFocus
                    required
                    maxLength={120}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2"
                  />
                </label>
                <Button type="submit" disabled={busy || !name.trim()}>
                  {busy ? "Saving…" : "Save view"}
                </Button>
              </form>
            ) : dialog === "delete" ? (
              <div className="mt-4 flex gap-2">
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      if (!selected) return
                      await customViewsApi.delete(
                        selected.id,
                        selected.revision
                      )
                      setViews((current) =>
                        current.filter((view) => view.id !== selected.id)
                      )
                      setSelected(null)
                      onSelect(null)
                      setDialog(null)
                    })
                  }
                >
                  Delete view
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setDialog("history")}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <>
                <ol className="mt-4 divide-y divide-border">
                  {versions.map((version) => (
                    <li
                      key={version.revision}
                      className="flex items-center justify-between gap-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          Version {version.revision}
                          {version.revision === selected?.revision
                            ? " · Current"
                            : ""}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(version.updatedAt).toLocaleString()} ·{" "}
                          {version.settings.computedColumns.length} custom
                          columns · {version.settings.view}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          busy || version.revision === selected?.revision
                        }
                        onClick={() => {
                          if (
                            !dirty ||
                            window.confirm(
                              "Discard unsaved changes and restore this version?"
                            )
                          )
                            void save(false, version)
                        }}
                      >
                        Restore
                      </Button>
                    </li>
                  ))}
                </ol>
                {versions.length <= 1 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Save changes to this view to create another version.
                  </p>
                ) : null}
                <Button
                  className="mt-4"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setDialog("delete")}
                >
                  Delete view…
                </Button>
              </>
            )}
            {error ? (
              <p className="mt-3 text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
