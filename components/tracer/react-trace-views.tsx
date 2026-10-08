"use client"
import * as React from "react"
import { Combobox } from "@/components/ui/combobox"
import { Code2, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardAction } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { Notice } from "@/components/ui/notice"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import type {
  TraceViewData,
  TraceViewDataMode,
} from "@/src/lib/tracer/trace-view-contract"
import { prepareTraceView } from "@/src/lib/tracer/trace-view-client"
import {
  rankReactViews,
  reactViewInputSchema,
  type ReactView,
  type ReactViewInput,
  type ReactViewSource,
  type ReactViewSummary,
} from "@/src/lib/tracer/react-views"
import {
  reactViewSelectionKey as selectionKey,
  reactViewLibraryEvent,
} from "@/src/lib/tracer/react-view-preferences"
import { useProjectScope } from "./project-scope-context"
import { reactViewsApi } from "./api"
import { ReactViewCodeEditor } from "./react-view-code-editor"
import { ReactViewPreview } from "./react-view-preview"
import { usePathname } from "next/navigation"
import { pageResourceForPath } from "@/src/lib/tracer/view-resources"
import { traceObjectViewInput, type ObjectViewInput } from "@/src/lib/tracer/object-views"
import { useViewPreference } from "./use-view-preference"
import { useObjectViewFields } from "./use-object-view-fields"
const starter = `import * as React from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@datool/ui";
export default function View({ kind, object, context }: ViewProps) {
  const output = kind === "trace" ? object.output : object.expectedOutput;
  return <Card className="m-4"><CardHeader><CardTitle>{kind === "trace" ? object.name : "Dataset item"}{context.unsaved ? " · Unsaved draft" : ""}</CardTitle></CardHeader><CardContent><pre className="whitespace-pre-wrap break-words text-sm">{JSON.stringify(output, null, 2)}</pre></CardContent></Card>;
}`

function newViewDraft(kind: "trace" | "dataset-item"): ReactViewInput {
  return { name: "", description: "", code: starter, requirements: null, dataMode: "summary", objectTypes: [kind], inputContract: "object", customFields: [] }
}

export function ReactTraceViews(props: {
  trace: TraceViewData
  objectInput?: ObjectViewInput
  source?: ReactViewSource | null
  dataLoading?: boolean
  onDataModeChange?: (mode: TraceViewDataMode) => void
  selectedViewId?: string | null
  onSelectedViewChange?: (id: string | null, replace?: boolean) => void
  deferredData?: { onLoad?: () => void; loading: boolean; error?: string }
  displayMode?: "library" | "view"
  createNew?: boolean
  onOpenView?: (view: ReactViewSummary) => void
  onCreateView?: () => void
  onViewChange?: (view: ReactView | null) => void
  onCancelCreate?: () => void
}) {
  const scope = useProjectScope()
  // Remount on project change so neither drafts nor late requests cross projects.
  return scope ? (
    <ProjectViews
      key={scope.projectId + ":" + (props.objectInput?.kind ?? "trace")}
      {...props}
      projectId={scope.projectId}
    />
  ) : (
    <Notice variant="error">Select a project to use its view library.</Notice>
  )
}
function ProjectViews({
  trace,
  objectInput: suppliedInput,
  source,
  projectId,
  dataLoading,
  onDataModeChange,
  selectedViewId,
  onSelectedViewChange,
  deferredData,
  displayMode,
  createNew,
  onOpenView,
  onCreateView,
  onViewChange,
  onCancelCreate,
}: {
  trace: TraceViewData
  objectInput?: ObjectViewInput
  source?: ReactViewSource | null
  dataLoading?: boolean
  onDataModeChange?: (mode: TraceViewDataMode) => void
  selectedViewId?: string | null
  onSelectedViewChange?: (id: string | null, replace?: boolean) => void
  deferredData?: { onLoad?: () => void; loading: boolean; error?: string }
  displayMode?: "library" | "view"
  createNew?: boolean
  onOpenView?: (view: ReactViewSummary) => void
  onCreateView?: () => void
  onViewChange?: (view: ReactView | null) => void
  onCancelCreate?: () => void
  projectId: string
}) {
  const pathname = usePathname()
  const objectInput = React.useMemo(() => suppliedInput ?? traceObjectViewInput(trace), [suppliedInput, trace])
  const kind = objectInput.kind
  const preferenceScope = "object-view:" + (pageResourceForPath(pathname) ?? "inspector") + ":" + kind
  const { preference, error: preferenceError, save: savePreference } = useViewPreference(projectId, preferenceScope)
  const requestedViewId = displayMode === "library" || createNew ? null : selectedViewId ?? preference?.value.id
  const selectionReady = Boolean(displayMode === "library" || createNew || selectedViewId || preference || preferenceError)
  const [views, setViews] = React.useState<ReactViewSummary[]>([])
  const [viewFilter, setViewFilter] = React.useState("")
  const [selected, setSelected] = React.useState<ReactView | null>(null)
  const [draft, setDraft] = React.useState<ReactViewInput | null>(() => createNew ? newViewDraft(kind) : null)
  const [previousViewId, setPreviousViewId] = React.useState(selectedViewId)
  if (previousViewId !== selectedViewId) {
    setPreviousViewId(selectedViewId)
    setDraft(null)
  }
  const resolvedFields = useObjectViewFields(projectId, deferredData ? [] : draft?.customFields ?? selected?.customFields ?? [], objectInput)
  const currentSource = source === undefined ? { kind: "trace" as const, id: trace.id } : source
  const [draftSource, setDraftSource] = React.useState<ReactViewSource | null>(
    createNew ? currentSource : null
  )
  const [preview, setPreview] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  const [deleting, setDeleting] = React.useState(false)
  const [refresh, setRefresh] = React.useState(0)
  const requestId = React.useRef(0)
  const ranked = rankReactViews(views, trace, objectInput)
  const availableViews = ranked.filter(({ view }) => (view.objectTypes ?? ["trace", "dataset-item"]).includes(kind))
  const filteredViews = availableViews.filter(({ view }) => `${view.name} ${view.description}`.toLocaleLowerCase().includes(viewFilter.trim().toLocaleLowerCase()))
  const dataMode = draft?.dataMode ?? selected?.dataMode ?? "summary"
  React.useEffect(() => {
    onDataModeChange?.(dataMode)
  }, [dataMode, onDataModeChange])
  const remember = (view: ReactView | null) => {
    savePreference({ id: view?.id ?? "" })
    onSelectedViewChange?.(view?.id ?? null)
    onViewChange?.(view)
  }
  React.useEffect(() => {
    const controller = new AbortController()
    const id = ++requestId.current
    async function load() {
      if (!selectionReady) return
      setLoading(true)
      setSelected(null)
      setError("")
      try {
        const all: ReactViewSummary[] = []
        let cursor: string | undefined
        do {
          const page = await reactViewsApi.list(
            projectId,
            cursor,
            controller.signal
          )
          all.push(...page.items)
          cursor = page.nextCursor ?? undefined
        } while (cursor)
        if (controller.signal.aborted || requestId.current !== id) return
        setViews(all)
        const saved = requestedViewId
        const viewId = all.find((view) => view.id === saved && (view.objectTypes ?? ["trace", "dataset-item"]).includes(kind))?.id
        if (viewId) {
          const view = await reactViewsApi.get(projectId, viewId)
          if (!controller.signal.aborted && requestId.current === id) {
            setSelected(view)
            onViewChange?.(view)
            if (!selectedViewId) onSelectedViewChange?.(view.id, true)
          }
        } else {
          setSelected(null)
          if (selectedViewId) setError(`The linked view is unavailable or does not support ${kind === "trace" ? "traces" : "dataset items"}. Select another project view.`)
        }
      } catch (error) {
        if (!controller.signal.aborted && requestId.current === id)
          setError(
            error instanceof Error
              ? error.message
              : "Could not load project views."
          )
      } finally {
        if (!controller.signal.aborted && requestId.current === id)
          setLoading(false)
      }
    }
    void load()
    const invalidate = () => { requestId.current++ }
    return () => { controller.abort(); invalidate() }
  }, [projectId, refresh, selectionReady, requestedViewId, kind, selectedViewId, onSelectedViewChange, onViewChange])
  React.useEffect(() => {
    const changed = (event: Event) => {
      if (event instanceof CustomEvent && event.detail?.projectId !== projectId)
        return
      if (
        event instanceof StorageEvent &&
        event.key !== selectionKey(projectId)
      )
        return
      if (draft)
        setNotice(
          "The project library changed. Your draft is preserved; reload when ready."
        )
      else if (!busy) setRefresh((value) => value + 1)
    }
    window.addEventListener(reactViewLibraryEvent, changed)
    window.addEventListener("storage", changed)
    return () => {
      window.removeEventListener(reactViewLibraryEvent, changed)
      window.removeEventListener("storage", changed)
    }
  }, [projectId, draft, busy])
  async function perform(action: () => Promise<void>) {
    setBusy(true)
    setError("")
    setNotice("")
    try {
      await action()
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to update view."
      )
    } finally {
      setBusy(false)
    }
  }
  function selectView(id: string) {
    void perform(async () => {
      const request = ++requestId.current
      const loaded = await reactViewsApi.get(projectId, id)
      if (requestId.current !== request) return
      if (!(loaded.objectTypes ?? ["trace", "dataset-item"]).includes(kind)) throw new Error(`This view does not support ${kind}.`)
      setSelected(loaded)
      remember(loaded)
    })
  }
  function edit(view: ReactView | null) {
    setDraft(
      view
        ? {
            name: view.name,
            description: view.description,
            code: view.code,
            requirements: view.requirements,
            dataMode: view.dataMode,
            objectTypes: view.objectTypes,
            inputContract: view.inputContract,
            customFields: view.customFields,
          }
        : newViewDraft(kind)
    )
    setDraftSource(currentSource)
    setPreview(false)
    setError("")
    setNotice("")
  }
  async function save(asNew: boolean) {
    if (!draft) return
    await perform(async () => {
      const parsed = reactViewInputSchema.safeParse(draft)
      if (!parsed.success)
        throw new Error(
          parsed.error.issues.map((issue) => issue.message).join("; ")
        )
      await prepareTraceView(parsed.data.code)
      const saved =
        selected && !asNew
          ? await reactViewsApi.update(projectId, selected.id, {
              ...parsed.data,
              expectedRevision: selected.revision,
            })
          : await reactViewsApi.create(projectId, {
              ...parsed.data,
              source: draftSource,
            })
      setSelected(saved)
      setViews((current) => [
        ...current.filter((view) => view.id !== saved.id),
        saved,
      ])
      remember(saved)
      setDraft(null)
      window.dispatchEvent(new CustomEvent(reactViewLibraryEvent, { detail: { projectId } }))
    })
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
      {displayMode !== "library" && <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-2 py-0.5">
        {draft ? (
          <>
            <Input
              variant="title-sm"
              className="min-w-0 flex-1"
              aria-label="View name"
              placeholder="Untitled view"
              maxLength={120}
              value={draft.name}
              disabled={busy}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    aria-label="View actions"
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Trace data</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={draft.dataMode}
                    onValueChange={(value) =>
                      setDraft({
                        ...draft,
                        dataMode: value as TraceViewDataMode,
                        requirements: null,
                      })
                    }
                  >
                    <DropdownMenuRadioItem value="summary">
                      Input and output only
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="full">
                      Complete trace with spans and scores
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => setPreview((value) => !value)}
                  >
                    {preview ? "Edit code" : "Preview"}
                  </DropdownMenuItem>
                  {selected && (
                    <DropdownMenuItem onSelect={() => void save(true)}>
                      Save as new view
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  if (!selected && onCancelCreate) { onCancelCreate(); return }
                  setDraft(null)
                  setError("")
                  setNotice("")
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                aria-label="Save view"
                loading={busy}
                onClick={() => void save(!selected)}
              >
                Save
              </Button>
            </div>
          </>
        ) : (
          displayMode === "view" ? <p className="min-w-0 truncate px-1 text-sm font-medium">{selected?.name ?? (loading ? "Loading view…" : "Unavailable view")}</p> : <Combobox
            label="View"
            variant="title-sm"
            className="min-w-0 shrink"
            disabled={loading || busy}
            placeholder={loading ? "Loading views…" : "Select view"}
            value={selected?.id ?? null}
            options={ranked.map(({ view }) => ({
              value: view.id,
              label: view.name,
              disabled: !(view.objectTypes ?? ["trace", "dataset-item"]).includes(kind),
              description: (view.objectTypes ?? ["trace", "dataset-item"]).includes(kind) ? undefined : `Supports ${(view.objectTypes ?? []).join(", ")}`,
            }))}
            onValueChange={selectView}
            searchPlaceholder="Search project views…"
            popupClassName="w-80 max-w-[calc(100vw-2rem)]"
            popupFooter={
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  setSelected(null)
                  edit(null)
                }}
              >
                <Plus className="size-3" />
                Create new view
              </Button>
            }
          />
        )}
        {!draft && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label="View actions"
                size="icon-sm"
                variant="ghost"
                disabled={busy || loading}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {selected && (
                <DropdownMenuItem onSelect={() => edit(selected)}>
                  <Pencil className="size-4" />
                  Edit view
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() => setRefresh((value) => value + 1)}
              >
                <RefreshCw className="size-4" />
                Refresh
              </DropdownMenuItem>
              {selected && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setDeleting(true)}
                  >
                    <Trash2 className="size-4" />
                    Delete view
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>}
      {(error || preferenceError) && (
        <Notice variant="error" role="alert" className="m-3">
          {error || preferenceError}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setDraft(null)
              setRefresh((value) => value + 1)
            }}
          >
            Reload views
          </Button>
        </Notice>
      )}
      {draft && notice && <Notice className="m-3">{notice}</Notice>}
      {deferredData && (selected || (draft && preview)) ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
          <p className="text-sm text-foreground-muted">This row has large fields. Load them to render the selected view.</p>
          <Button size="sm" variant="outline" loading={deferredData.loading}
            disabled={!deferredData.onLoad || busy || loading} onClick={deferredData.onLoad}>
            {deferredData.loading ? "Loading and rendering…" : "Load and render"}
          </Button>
          {deferredData.error && <Notice variant="error" role="alert">{deferredData.error}</Notice>}
        </div>
      ) : draft ? (
        <div inert={busy} className="flex min-h-0 flex-1 flex-col">
          {preview ? (
            <ReactViewPreview
              code={draft.code}
              trace={trace}
              objectInput={resolvedFields.input}
              dataMode={dataMode}
              dataLoading={dataLoading || resolvedFields.loading}
            />
          ) : (
            <ReactViewCodeEditor
              code={draft.code}
              onChange={(code) =>
                setDraft(
                  (current) =>
                    current && { ...current, code, requirements: null }
                )
              }
            />
          )}
        </div>
      ) : selected ? (
        <ReactViewPreview
          code={selected.code}
          trace={trace}
          objectInput={resolvedFields.input}
          dataMode={dataMode}
          dataLoading={dataLoading || resolvedFields.loading}
        />
      ) : (
          <div className="flex min-h-0 flex-1 flex-col" aria-label="Project views">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-3">
              <div className="min-w-0 flex-1">
                <Input icon={<Search />} aria-label="Filter project views" placeholder="Search views…" value={viewFilter} disabled={loading || busy} onChange={(event) => setViewFilter(event.target.value)} />
              </div>
              <Button variant="secondary" size="sm" disabled={loading || !!error || busy} onClick={() => onCreateView ? onCreateView() : edit(null)}>
                <Plus />
                Create new view
              </Button>
            </div>
            <div className="space-y-3 p-3">
              {loading ? (
                <div role="status" aria-label="Loading project views" className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-3">
                  {[0, 1, 2].map((index) => <Skeleton key={index} className="h-32" />)}
                </div>
              ) : filteredViews.length ? (
                <>
                  <p className="text-sm text-foreground-muted">Select a project view to preview this record.</p>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-3">
                    {filteredViews.map(({ view, compatibility }) => (
                      <Card key={view.id}>
                        <CardAction className="h-full gap-3 p-4" disabled={busy} onClick={() => onOpenView ? onOpenView(view) : selectView(view.id)} aria-label={`Open ${view.name}`}>
                          <div className="flex min-w-0 items-center gap-2">
                            <Code2 className="size-4 shrink-0 text-foreground-muted" />
                            <span className="min-w-0 break-words font-medium">{view.name}</span>
                          </div>
                          {view.description && <p className="line-clamp-3 break-words text-sm text-foreground-muted">{view.description}</p>}
                          {compatibility.state === "missing" && <p className="text-xs text-foreground-muted">{compatibility.label}</p>}
                        </CardAction>
                      </Card>
                    ))}
                  </div>
                </>
              ) : !error && (
                <div className="space-y-3 py-4 text-sm text-foreground-muted">
                  <p>{viewFilter.trim() ? "No matching views." : views.length ? `No project views support ${kind === "trace" ? "traces" : "dataset items"} yet.` : "Create a view from the view menu to get started."}</p>
                  {viewFilter.trim() && <Button variant="ghost" size="sm" onClick={() => setViewFilter("")}>Clear filter</Button>}
                </div>
              )}
            </div>
          </div>
      )}
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent>
          <DialogTitle>Delete project view?</DialogTitle>
          {error && (
            <Notice variant="error" role="alert">
              {error}
            </Notice>
          )}
          <DialogDescription>
            This removes {selected?.name} from the library for everyone in this
            project.
          </DialogDescription>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={busy}
              onClick={() =>
                selected &&
                void perform(async () => {
                  await reactViewsApi.delete(
                    projectId,
                    selected.id,
                    selected.revision
                  )
                  setViews((current) =>
                    current.filter((view) => view.id !== selected.id)
                  )
                  setSelected(null)
                  setDeleting(false)
                  remember(null)
                  window.dispatchEvent(new CustomEvent(reactViewLibraryEvent, { detail: { projectId } }))
                })
              }
            >
              Delete view
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
