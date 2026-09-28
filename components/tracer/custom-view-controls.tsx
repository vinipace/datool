"use client"

import * as React from "react"
import { Dialog } from "radix-ui"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PageViewMenu } from "@/components/ui/page-view-menu"
import { customViewsApi } from "./api"
import { HeaderSlot } from "./collection-header"
import { CollectionHeaderContext } from "./collection-header-context"
import { defaultTableSettings, sameViewSettings, type CustomView, type EvalViewSettings } from "@/src/lib/tracer/custom-views"
import { createPageViewDraftStore } from "@/src/lib/tracer/page-view-drafts"
import { pageViewResources } from "@/src/lib/tracer/view-resources"

const resourceLabels = Object.fromEntries(Object.entries(pageViewResources).map(([id, resource]) => [id, resource.label]))
const defaultNames: Partial<Record<CustomView["resource"], string>> = {
  traces: "All Logs", evaluations: "All evals view", "eval-runs": "All results view", "dataset-items": "All dataset items",
}
type Props = {
  resource?: CustomView["resource"]
  settings: EvalViewSettings
  defaultSettings?: EvalViewSettings
  storageKey?: string
  onApply: (settings: EvalViewSettings) => void | Promise<void>
  viewId: string | null
  onSelect: (id: string | null) => void
}

export function CustomViewControls(props: Props) {
  return <PageViewControls key={props.storageKey ?? props.resource} {...props} />
}

function PageViewControls({ resource = "eval-runs", settings, defaultSettings, storageKey, onApply, viewId, onSelect }: Props) {
  const slots = React.useContext(CollectionHeaderContext)
  const drafts = React.useMemo(() => createPageViewDraftStore(storageKey ?? `datool:page-view:${resource}`), [storageKey, resource])
  const defaults = React.useMemo<EvalViewSettings>(() => defaultSettings ?? {
    ...defaultTableSettings, schemaVersion: 1, computedColumns: [], customFields: [], columnOrder: [], detailsOpen: false, queryParams: {},
  }, [defaultSettings])
  const defaultName = defaultNames[resource] ?? `All ${resourceLabels[resource].toLowerCase()} view`
  const [views, setViews] = React.useState<CustomView[]>([])
  const orderedViews = React.useMemo(() => [...views].sort((a, b) =>
    Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id)
  ), [views])
  const [session, setSession] = React.useState<{ id: string | null; base: CustomView | null; baseline: EvalViewSettings } | null>(null)
  const selected = session?.id === viewId ? session.base : null
  const [busy, setBusy] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const storageError = React.useSyncExternalStore(drafts.subscribe, drafts.getError, () => "")
  const [dialog, setDialog] = React.useState<"save" | null>(null)
  const [name, setName] = React.useState("")
  const current = React.useRef({ settings, onApply })
  React.useLayoutEffect(() => { current.current = { settings, onApply } }, [settings, onApply])
  const [requestedView, setRequestedView] = React.useState(viewId)
  if (requestedView !== viewId) {
    setRequestedView(viewId)
    setLoading(true)
    setError(null)
  }
  const pendingApply = React.useRef<EvalViewSettings | null>(null)
  const initialized = React.useRef(false)
  const ready = !loading && session !== null && session.id === viewId
  const dirty = ready && !sameViewSettings(session.baseline, settings)

  React.useEffect(() => {
    let active = true
    void customViewsApi.list(resource).then(result => { if (active) setViews(result) })
      .catch(reason => { if (active) setError(reason.message) })
    return () => { active = false }
  }, [resource])

  React.useEffect(() => {
    let active = true
    void (async () => {
      let draft = null
      try { draft = drafts.read(viewId) }
      catch { drafts.report("The local Page View draft could not be loaded. Existing browser data has been retained."); return }
      let base = draft?.base ?? null
      if (viewId && !base) base = await customViewsApi.get(viewId)
      if (!active) return
      if (base && base.resource !== resource) throw new Error("This view belongs to another page type.")
      const baseline = base?.settings ?? drafts.defaultBaseline(
        draft || initialized.current ? defaults : current.current.settings
      )
      const target = draft?.settings ?? baseline
      pendingApply.current = target
      await current.current.onApply(target)
      if (!active) return
      initialized.current = true
      setSession({ id: viewId, base, baseline })
      if (base) setViews(items => [base, ...items.filter(item => item.id !== base.id)])
    })().catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [viewId, resource, drafts, defaults])

  React.useEffect(() => {
    if (!ready || busy) return
    // URL updates and resolved fields must settle before capturing a new draft.
    if (pendingApply.current) {
      if (!sameViewSettings(pendingApply.current, settings)) return
      pendingApply.current = null
    }
    if (dirty) drafts.write(viewId, { base: selected, settings })
    else drafts.clear(viewId)
  }, [ready, busy, dirty, settings, viewId, selected, drafts])

  const accept = (view: CustomView) => {
    setSession({ id: view.id, base: view, baseline: view.settings })
    setViews(items => [view, ...items.filter(item => item.id !== view.id)])
    drafts.clear(viewId)
    drafts.clear(view.id)
    if (!sameViewSettings(view.settings, current.current.settings)) {
      drafts.write(view.id, { base: view, settings: current.current.settings })
    }
    onSelect(view.id)
    setDialog(null)
  }
  const perform = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try { await action() }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save the view.") }
    finally { setBusy(false) }
  }
  const save = (asNew: boolean) => perform(async () => {
    if (asNew) accept(await customViewsApi.create({ name, resource, settings }))
    else if (selected) accept(await customViewsApi.update(selected.id, { name: selected.name, resource, settings, expectedRevision: selected.revision }))
  })
  const reset = () => perform(async () => {
    const base = viewId ? await customViewsApi.get(viewId, true) : null
    const target = base?.settings ?? drafts.defaultBaseline(defaults)
    pendingApply.current = target
    await onApply(target)
    setSession({ id: viewId, base, baseline: target })
    drafts.clear(viewId)
  })

  return (
    <>
      <HeaderSlot name={slots.pageView ? "pageView" : "filter"}>
        <PageViewMenu options={[{ id: null, name: defaultName }, ...orderedViews]}
          value={viewId} name={selected?.name ?? (viewId ? "Unavailable view" : defaultName)}
          dirty={dirty} loading={loading} disabled={busy}
          onSelect={id => { if (id !== viewId) onSelect(id) }}
          onSave={() => {
            if (selected) void save(false)
            else { setName(defaultName); setDialog("save") }
          }}
          onReset={() => { void reset() }}
          onDuplicate={() => { setName(`${selected?.name ?? defaultName} copy`); setDialog("save") }} />
      </HeaderSlot>
      {storageError && <p className="mb-2 text-xs text-destructive" role="alert">{storageError}</p>}
      {error && !dialog && <div className="mb-2 flex items-center gap-2 text-xs text-destructive" role="alert">
        {error}
        {viewId && <Button size="sm" variant="outline" disabled={busy || loading} onClick={() => { void reset() }}>Reload saved view</Button>}
      </div>}
      <Dialog.Root
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay" />
          <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[85vh] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-xl">
            <Dialog.Title className="text-base font-semibold">Save Page View</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-muted-foreground">
              {`Save filters, sorting, columns, display settings, and table/card layout. This view will be available on ${resourceLabels[resource]} in this project, across browsers.`}
            </Dialog.Description>
            <Dialog.Close
              disabled={busy}
              className="absolute top-4 right-4"
              aria-label="Close view dialog"
            >
              <X className="size-4" />
            </Dialog.Close>
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
