"use client"
import * as React from "react"
import { Combobox } from "@/components/ui/combobox"
import { MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
const starter = `import * as React from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@datool/ui";
export default function View({ trace }: ViewProps) {
  return <Card className="m-4"><CardHeader><CardTitle>{trace.name}</CardTitle></CardHeader><CardContent><pre className="whitespace-pre-wrap break-words text-sm">{JSON.stringify(trace.output, null, 2)}</pre></CardContent></Card>;
}`

export function ReactTraceViews(props: {
  trace: TraceViewData
  source?: ReactViewSource | null
  dataLoading?: boolean
  onDataModeChange?: (mode: TraceViewDataMode) => void
}) {
  const scope = useProjectScope()
  // Remount on project change so neither drafts nor late requests cross projects.
  return scope ? (
    <ProjectViews
      key={scope.projectId}
      {...props}
      projectId={scope.projectId}
    />
  ) : (
    <Notice variant="error">Select a project to use its view library.</Notice>
  )
}
function ProjectViews({
  trace,
  source,
  projectId,
  dataLoading,
  onDataModeChange,
}: {
  trace: TraceViewData
  source?: ReactViewSource | null
  dataLoading?: boolean
  onDataModeChange?: (mode: TraceViewDataMode) => void
  projectId: string
}) {
  const [views, setViews] = React.useState<ReactViewSummary[]>([])
  const [selected, setSelected] = React.useState<ReactView | null>(null)
  const [draft, setDraft] = React.useState<ReactViewInput | null>(null)
  const [draftSource, setDraftSource] = React.useState<ReactViewSource | null>(
    null
  )
  const [preview, setPreview] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  const [deleting, setDeleting] = React.useState(false)
  const [refresh, setRefresh] = React.useState(0)
  const requestId = React.useRef(0)
  const currentSource =
    source === undefined ? { kind: "trace" as const, id: trace.id } : source
  const ranked = rankReactViews(views, trace)
  const dataMode = draft?.dataMode ?? selected?.dataMode ?? "summary"
  React.useEffect(() => {
    onDataModeChange?.(dataMode)
  }, [dataMode, onDataModeChange])
  const remember = (id: string) => {
    try {
      localStorage.setItem(selectionKey(projectId), id)
    } catch {
      /* Selection is optional; view data lives in the database. */
    }
  }
  React.useEffect(() => {
    const controller = new AbortController()
    const id = ++requestId.current
    async function load() {
      setLoading(true)
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
        let saved: string | null = null
        try {
          saved = localStorage.getItem(selectionKey(projectId))
        } catch {
          /* optional preference */
        }
        const viewId = all.find((view) => view.id === saved)?.id
        if (viewId) {
          const view = await reactViewsApi.get(projectId, viewId)
          if (!controller.signal.aborted && requestId.current === id)
            setSelected(view)
        } else setSelected(null)
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
    return () => controller.abort()
  }, [projectId, refresh])
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
  function edit(view: ReactView | null) {
    setDraft(
      view
        ? {
            name: view.name,
            description: view.description,
            code: view.code,
            requirements: view.requirements,
            dataMode: view.dataMode,
          }
        : {
            name: "",
            description: "",
            code: starter,
            requirements: null,
            dataMode: "summary",
          }
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
      remember(saved.id)
      setDraft(null)
    })
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-2 py-0.5">
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
          <Combobox
            label="React view"
            variant="title-sm"
            className="min-w-0 shrink"
            disabled={loading || busy}
            placeholder={loading ? "Loading views…" : "Select view"}
            value={selected?.id ?? null}
            options={ranked.map(({ view }) => ({
              value: view.id,
              label: view.name,
            }))}
            onValueChange={(id) =>
              void perform(async () => {
                const loaded = await reactViewsApi.get(projectId, id)
                setSelected(loaded)
                remember(loaded.id)
              })
            }
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
      </div>
      {error && (
        <Notice variant="error" role="alert" className="m-3">
          {error}
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
      {draft ? (
        <div inert={busy} className="flex min-h-0 flex-1 flex-col">
          {preview ? (
            <ReactViewPreview
              code={draft.code}
              trace={trace}
              dataMode={dataMode}
              dataLoading={dataLoading}
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
          dataMode={dataMode}
          dataLoading={dataLoading}
        />
      ) : (
        !loading && (
          <div className="space-y-3 p-4 text-sm text-foreground-muted">
            <p>
              {views.length
                ? "Select a project view to preview this record."
                : "Create a view from the view menu to get started."}
            </p>
            <Button
              variant="secondary"
              size="sm"
              disabled={!!error || busy}
              onClick={() => edit(null)}
            >
              Create new view
            </Button>
          </div>
        )
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
                  remember("")
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
