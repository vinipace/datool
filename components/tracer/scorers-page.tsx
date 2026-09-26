"use client"
import { PanelActionLabel } from "@/components/ui/panel-action-label"
import { projectFetch } from "@/lib/workspace-routing"

import { useWorkspaceHref, useWorkspaceStorageScope } from "./workspace-path"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Plus, Save, Sparkles, Trash2 } from "lucide-react"
import { withScorerTypes } from "@/src/lib/tracer/scorer-typings"
import { createScorerDraftStore, type ScorerDraftStore } from "@/src/lib/tracer/scorer-draft-store"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { InspectorSection } from "@/components/ui/inspector-section"
import { MessagesForm } from "@/components/ui/messages-form"
import { ScorerTypeBadge } from "@/components/ui/scorer-type-badge"
import { Checkbox } from "@/components/ui/checkbox"
import { ScorerTestPanel } from "./scorer-test-panel"
import { ScorerModelField } from "./scorer-model-field"
import { LibraryScorerForm } from "./library-scorer-form"
import { GATEWAY_PROVIDER } from "@/src/lib/model-providers"
import { ScorerIcon } from "./scorer-icon"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ScorerCodeEditor } from "./scorer-code-editor"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { LoadingState } from "@/components/ui/loading-state"
import { compileCollectionFilter } from "@/src/lib/tracer/collection-filters"
import {
  defaultScorer,
  defaultPythonScorerCode,
  scorerInputSchema,
  type Scorer,
  type ScorerInput,
} from "@/src/lib/tracer/scorers"
import {
  LogTable,
  LogTableBody,
  LogRow,
  LogRowSelection,
  LogSelectAll,
} from "./log-table"
import { logTable } from "./log-table-styles"
import { useRemote } from "./hooks"
import { CollectionPanel } from "./collection-panel"
import { CollectionPage } from "./collection-page"
import { HeaderSlot } from "./collection-header"
import { CollectionFilterBar } from "./collection-filter"
import { useCollectionFilter } from "./use-collection-filter"
import { useTableView } from "./use-table-view"
import { formatDate } from "./format"

async function request<T>(
  path = "",
  method = "GET",
  body?: unknown,
  signal?: AbortSignal
): Promise<T> {
  const response = await projectFetch(`/api/scorers${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  const result = await response.json()
  if (!response.ok)
    throw new Error(
      result.error?.message ??
        (method === "GET" ? "Unable to load scorer." : "Unable to save scorer.")
    )
  return result.data
}

export function ScorersPage() {
  const workspaceHref = useWorkspaceHref()
  const router = useRouter()
  const storageScope = useWorkspaceStorageScope()
  const tableView = useTableView({
    resource: "scorers",
    settingsStorageKey: `datool:scorers:${storageScope}:settings`,
    orderStorageKey: "datool.scorers.columns",
  })
  const load = React.useCallback(() => request<Scorer[]>(), [])
  const state = useRemote(load, [])
  const search = useCollectionFilter("scorers")
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const matches = React.useMemo(
    () => compileCollectionFilter("scorers", search.filter),
    [search.filter]
  )
  const rows = (state.data ?? []).filter(matches)
  return (
    <CollectionPanel label="Scorers">
      <CollectionPage
        className="contents"
        selection={{
          rows: rows.filter((row) => selected.has(row.id)),
          onClear: () => setSelected(new Set()),
        }}
        state={state}
        loadingLabel="Loading scorers"
        savedView={tableView.savedView}
        toolbar={
          tableView.storageError ? (
            <Notice variant="error" role="status" className="mb-2">
              {tableView.storageError}
            </Notice>
          ) : null
        }
        header={{
          exportRows: rows,
          exportName: "scorers",
          children: (
            <CollectionFilterBar
              resource="scorers"
              {...search}
              isLoading={state.isLoading || state.isRefreshing}
            />
          ),
          actions: (
            <Button size="sm" asChild>
              <Link href={workspaceHref("/scorers/new")}>
                <Plus className="size-4" />
                <PanelActionLabel>New scorer</PanelActionLabel>
              </Link>
            </Button>
          ),
        }}
      >
        <LogTable
          fillHeight
          enableCardView
          settings={tableView.settings}
          onSettingsChange={tableView.onSettingsChange}
          columnOrderStore={tableView.columnOrderStore}
          widths={[240, 200, 150, 260, 100, 190]}
          columnIds={[
            "name",
            "slug",
            "type",
            "description",
            "version",
            "updated",
          ]}
          reorderable
        >
          <thead className={logTable.head}>
            <tr>
              <th className={logTable.heading}>
                <LogSelectAll
                  label="Select all scorers"
                  disabled={!rows.length}
                  checked={
                    !!rows.length && rows.every((r) => selected.has(r.id))
                  }
                  partial={
                    rows.some((r) => selected.has(r.id)) &&
                    !rows.every((r) => selected.has(r.id))
                  }
                  onChange={() =>
                    setSelected(
                      rows.every((r) => selected.has(r.id))
                        ? new Set()
                        : new Set(rows.map((r) => r.id))
                    )
                  }
                />
              </th>
              {[
                "Name",
                "Slug",
                "Type",
                "Description",
                "Version",
                "Updated",
              ].map((label) => (
                <th key={label} className={logTable.heading}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <LogTableBody
            rows={rows}
            empty={
              <tr>
                <td colSpan={7} className="py-24 text-center">
                  <Sparkles className="mx-auto mb-3 size-6 text-foreground-muted" />
                  <p className="font-medium">
                    {search.filter
                      ? "No matching scorers"
                      : "Create your first scorer"}
                  </p>
                  <p className="mt-1 text-sm text-foreground-muted">
                    Choose a library evaluator, use an LLM judge or write a code scorer.
                  </p>
                  <Button className="mt-4" size="sm" variant="outline" asChild>
                    <Link href={workspaceHref("/scorers/new")}>
                      <Plus className="size-4" />
                      New scorer
                    </Link>
                  </Button>
                </td>
              </tr>
            }
          >
            {(row, index) => (
              <LogRow
                rowLabel={`Open ${row.name}`}
                onClick={() =>
                  router.push(
                    workspaceHref(`/scorers/${encodeURIComponent(row.id)}`)
                  )
                }
                key={row.id}
                checked={selected.has(row.id)}
              >
                <LogRowSelection
                  index={index}
                  checked={selected.has(row.id)}
                  label={`Select ${row.name}`}
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current)
                      if (next.has(row.id)) next.delete(row.id)
                      else next.add(row.id)
                      return next
                    })
                  }
                />
                <td className={logTable.cell}>
                  <Link
                    className="font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    href={workspaceHref(
                      `/scorers/${encodeURIComponent(row.id)}`
                    )}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {row.name}
                  </Link>
                </td>
                <td
                  className={`${logTable.cell} font-mono text-xs text-foreground-muted`}
                >
                  {row.slug}
                </td>
                <td className={logTable.cell}>
                  <ScorerTypeBadge type={row.type} />
                </td>
                <td
                  className={`${logTable.cell} truncate text-foreground-muted`}
                >
                  {row.description || "—"}
                </td>
                <td className={logTable.cell}>v{row.revision}</td>
                <td
                  className={`${logTable.cell} text-xs text-foreground-muted`}
                >
                  {formatDate(row.updatedAt)}
                </td>
              </LogRow>
            )}
          </LogTableBody>
        </LogTable>
      </CollectionPage>
    </CollectionPanel>
  )
}

export function NewScorerPage({ traceIds = [] }: { traceIds?: string[] }) {
  const workspaceHref = useWorkspaceHref()
  const router = useRouter()
  return (
    <ScorerEditor
      traceIds={traceIds}
      onDeleted={() => router.replace(workspaceHref("/scorers"))}
    />
  )
}

export function ScorerDetailPage({ scorerId }: { scorerId: string }) {
  const workspaceHref = useWorkspaceHref()
  const router = useRouter()
  const load = React.useCallback(
    (signal: AbortSignal) =>
      request<Scorer>(
        `/${encodeURIComponent(scorerId)}`,
        "GET",
        undefined,
        signal
      ),
    [scorerId]
  )
  const state = useRemote(load, [scorerId])
  if (state.error)
    return (
      <Notice variant="error" role="alert" className="m-4">
        <p>{state.error.message}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={state.refresh}
        >
          Retry
        </Button>
      </Notice>
    )
  if (!state.data)
    return (
      <div role="status">
        <LoadingState label="Loading scorer" />
      </div>
    )
  return (
    <ScorerEditor
      key={scorerId}
      scorer={state.data}
      onDeleted={() => router.replace(workspaceHref("/scorers"))}
    />
  )
}

type ScorerEditorProps = {
  scorer?: Scorer
  traceIds?: string[]
  onDeleted: () => void
}

function ScorerEditor(props: ScorerEditorProps) {
  const scope = useWorkspaceStorageScope()
  const storageKey = `datool:scorer-draft:${scope}:${encodeURIComponent(props.scorer?.id ?? "new")}`
  return <ScorerDraftEditor key={storageKey} {...props} storageKey={storageKey} />
}

function ScorerDraftEditor({ storageKey, ...props }: ScorerEditorProps & { storageKey: string }) {
  const [store] = React.useState(() => {
    const initial = props.scorer ?? { ...structuredClone(defaultScorer), provider: GATEWAY_PROVIDER }
    return createScorerDraftStore(storageKey, {
      ...initial, code: initial.type === "python" ? initial.code : withScorerTypes(initial.code),
    }, props.scorer?.revision)
  })
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  React.useEffect(() => store.hydrate(), [store])
  if (!state.ready) return <LoadingState label="Loading scorer draft" />
  return <ScorerEditorForm {...props} store={store} storageKey={storageKey} />
}

function ScorerEditorForm({
  scorer,
  traceIds = [],
  onDeleted,
  store,
  storageKey,
}: ScorerEditorProps & { store: ScorerDraftStore; storageKey: string }) {
  const { draft, dirty: hasChanges, revision, storageError } = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const setDraft = store.update
  const [savedId, setSavedId] = React.useState(scorer?.id)
  const [savedName, setSavedName] = React.useState(scorer?.name)
  const workspaceHref = useWorkspaceHref()
  const codeLanguage = React.useRef<"javascript" | "python">(draft.type === "python" ? "python" : "javascript")
  const codeDrafts = React.useRef({
    javascript: draft.type === "python" ? withScorerTypes(defaultScorer.code) : draft.code,
    python: draft.type === "python" ? draft.code : defaultPythonScorerCode,
  })
  const [testActionsContainer, setTestActionsContainer] =
    React.useState<HTMLDivElement | null>(null)
  const container = React.useRef<HTMLDivElement>(null)
  const [horizontal, setHorizontal] = React.useState(true)
  React.useEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      setHorizontal(entry.contentRect.width >= 896)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const [slugEdited, setSlugEdited] = React.useState(Boolean(scorer || draft.slug))
  const slugify = (name: string) =>
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [libraryValid, setLibraryValid] = React.useState(true)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [modelAttention, setModelAttention] = React.useState(0)
  const saveButton = React.useRef<HTMLButtonElement>(null)
  const saving = React.useRef(false)
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "s" || !event.metaKey || event.altKey || event.shiftKey || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) saveButton.current?.click()
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [])
  const set = <K extends keyof ScorerInput>(key: K, value: ScorerInput[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))
  async function save() {
    if (pending || saving.current || !hasChanges || !libraryValid) return
    setError(null)
    const parsed = scorerInputSchema.safeParse(draft)
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join(" "))
      if (draft.type === "llm" && !draft.model.trim())
        setModelAttention((request) => request + 1)
      return
    }
    setPending(true)
    saving.current = true
    try {
      const saved = await request<Scorer>(savedId ? `/${savedId}` : "", savedId ? "PUT" : "POST", {
        ...parsed.data,
        ...(savedId ? { expectedRevision: revision } : {}),
      })
      setSavedId(saved.id)
      setSavedName(saved.name)
      store.saved(draft, saved.revision)
      if (!savedId) {
        store.move(`${storageKey.slice(0, storageKey.lastIndexOf(":"))}:${encodeURIComponent(saved.id)}`)
        // Give a newly created scorer its reloadable URL without remounting the editor.
        window.history.replaceState(null, "", `${workspaceHref(`/scorers/${encodeURIComponent(saved.id)}`)}${window.location.search}`)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      saving.current = false
      setPending(false)
    }
  }
  return (
    <div
      ref={container}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
    >
      <HeaderSlot name="title">
        <h1 className="truncate text-sm font-medium" title={savedName}>
          {savedName ?? "Create scorer"}
        </h1>
      </HeaderSlot>
      <div
        role="group"
        aria-label="Scorer controls"
        className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-6 py-2"
      >
        <div className="flex min-w-0 flex-1 basis-48 items-center gap-3">
          <ScorerIcon aria-hidden="true" className="size-5 shrink-0" />
          <Input
            variant="title"
            className="-ml-2"
            aria-label="Name"
            value={draft.name}
            placeholder="Untitled scorer"
            maxLength={120}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                name: e.target.value,
                slug: slugEdited ? d.slug : slugify(e.target.value),
              }))
            }
          />
          {hasChanges && <span role="img" aria-label="Unsaved draft" title={storageError ? "Draft · local storage unavailable" : "Draft · saved locally"} className="size-2 shrink-0 rounded-full bg-warning" />}
        </div>
        <div className="ml-auto flex max-w-full flex-wrap items-center gap-2">
          {savedId ? (
            <Button
              variant={confirmDelete ? "destructive" : "ghost-muted"}
              size="icon-sm"
              aria-label={confirmDelete ? "Confirm delete" : "Delete"}
              title={confirmDelete ? "Confirm delete" : "Delete"}
              disabled={pending}
              onClick={async () => {
                if (!confirmDelete) {
                  setConfirmDelete(true)
                  return
                }
                setPending(true)
                try {
                  await request(`/${savedId}`, "DELETE")
                  store.clear()
                  onDeleted()
                } catch (e) {
                  setError((e as Error).message)
                } finally {
                  setPending(false)
                }
              }}
            >
              <Trash2 className="size-3.5" />
            </Button>
          ) : null}
          <Button ref={saveButton} size="icon-sm" aria-label="Save" title="Save (⌘S)" aria-keyshortcuts="Meta+S" loading={pending} disabled={!hasChanges || !libraryValid} onClick={() => void save()}>
            {!pending && <Save aria-hidden="true" className="size-4" />}
          </Button>
          <div
            ref={setTestActionsContainer}
            className="flex items-center gap-2"
          />
        </div>
      </div>
      <ResizablePanelGroup
        orientation={horizontal ? "horizontal" : "vertical"}
        className="min-h-0 flex-1"
      >
        <ResizablePanel
          id="scorer-configuration"
          defaultSize="50%"
          minSize="20%"
        >
          <section aria-label="Scorer configuration" className="min-w-0 px-4">
            {storageError && <Notice variant="error" role="alert">{storageError}</Notice>}
            {error && (
              <Notice variant="error" role="alert">
                {error}
              </Notice>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-3">
              <p className="text-sm">Type</p>
              <div className="flex flex-wrap gap-1">
                {(["llm", "javascript", "python"] as const).map((type) => (
                  <Button
                    key={type}
                    aria-pressed={draft.type === type}
                    variant={draft.type === type ? `scorer-${type}` : "ghost"}
                    size="sm"
                    onClick={() => {
                      if (type === draft.type) return
                      codeDrafts.current[codeLanguage.current] = draft.code
                      if (type === "javascript" || type === "python") codeLanguage.current = type
                      setLibraryValid(true)
                      setDraft((current) => ({
                        ...current, type, code: codeDrafts.current[codeLanguage.current],
                      }))
                    }}
                  >
                    <ScorerTypeBadge
                      type={type}
                      variant="label"
                      active={draft.type === type}
                    />
                  </Button>
                ))}
              </div>
            </div>
            {draft.type === "library" ? <LibraryScorerForm config={draft} onChange={setDraft} onValidityChange={setLibraryValid} disabled={pending} /> : draft.type === "llm" ? (
              <>
                <ScorerModelField model={draft.model} provider={draft.provider}
                  attentionRequest={modelAttention}
                  onChange={(selection) => {
                    setModelAttention(0)
                    setDraft((current) => ({
                      ...current,
                      ...selection,
                      ...(selection.modelType === "evaluation"
                        ? { chainOfThought: false, imagePaths: [] }
                        : {}),
                    }))
                  }} />
                {draft.modelType === "evaluation" && (
                  <p className="px-3 py-2 text-xs text-foreground-muted">
                    Evaluation models return a choice and available probabilities without a written explanation. Use text evidence and the choice scores below.
                  </p>
                )}
                <MessagesForm<ScorerInput["messages"][number]["role"]>
                  messages={draft.messages}
                  onChange={(messages) => set("messages", messages)}
                  roles={[
                    { value: "system", label: "System" },
                    { value: "user", label: "User" },
                  ]}
                  defaultRole="user"
                  maxMessages={20}
                  disabled={pending}
                  description={<>Use {"{{input}}"}, {"{{output}}"}, and {"{{expected}}"} from your test data.</>}
                />
                <InspectorSection label="Choice scores" variant="form">
                  <p className="mt-1 mb-3 text-xs text-foreground-muted">
                    Map each unique choice to a score between 0 and 1.
                  </p>
                  {draft.choices.map((choice, index) => (
                    <div className="mb-2 flex gap-2" key={index}>
                      <Input
                        aria-label={`Choice ${index + 1}`}
                        className="min-w-0 flex-1"
                        value={choice.label}
                        onChange={(e) =>
                          set(
                            "choices",
                            draft.choices.map((c, i) =>
                              i === index ? { ...c, label: e.target.value } : c
                            )
                          )
                        }
                      />
                      <Input
                        aria-label={`Score ${index + 1}`}
                        type="number"
                        min="0"
                        max="1"
                        step="0.01"
                        className="w-24"
                        value={choice.score}
                        onChange={(e) =>
                          set(
                            "choices",
                            draft.choices.map((c, i) =>
                              i === index
                                ? { ...c, score: e.target.valueAsNumber }
                                : c
                            )
                          )
                        }
                      />
                      <Button
                        variant="ghost"
                        aria-label={`Remove choice ${index + 1}`}
                        onClick={() =>
                          set(
                            "choices",
                            draft.choices.filter((_, i) => i !== index)
                          )
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    className="-ml-2"
                    variant="ghost-muted"
                    size="sm"
                    onClick={() =>
                      set("choices", [
                        ...draft.choices,
                        { label: "", score: 0 },
                      ])
                    }
                  >
                    <Plus className="size-3.5" />
                    Add choice score
                  </Button>
                  <label className="ml-4 text-sm">
                    <Checkbox
                      checked={draft.allowSkip}
                      onChange={(e) => set("allowSkip", e.target.checked)}
                      className="mr-2"
                    />
                    Allow skip
                  </label>
                </InspectorSection>
              </>
            ) : (
              <InspectorSection
                label={draft.type === "python" ? "Python Code" : "Javascript Code"}
                variant="form"
                summaryClassName="pr-24"
              >
                <ScorerCodeEditor
                  label="Scorer code"
                  language={draft.type === "python" ? "python" : "javascript"}
                  showPrettify
                  className="h-96"
                  value={draft.code}
                  onChange={(value) => {
                    set("code", value)
                  }}
                />
              </InspectorSection>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-3 text-sm">
              <label htmlFor="scorer-threshold">Pass threshold</label>
              <div className="flex w-64 max-w-full min-w-0 items-center gap-3">
                <Slider
                  aria-label="Pass threshold slider"
                  min={0}
                  max={1}
                  step={0.01}
                  value={[draft.threshold ?? 0]}
                  onValueChange={([value]) => {
                    set("threshold", value)
                  }}
                  className="min-w-0 flex-1"
                />
                <Input
                  id="scorer-threshold"
                  className="w-20 shrink-0"
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  placeholder="None"
                  value={draft.threshold ?? ""}
                  onChange={(e) => {
                    const value = e.target.valueAsNumber
                    set(
                      "threshold",
                      Number.isFinite(value)
                        ? Math.min(1, Math.max(0, value))
                        : null
                    )
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={draft.threshold === null}
                  onClick={() => {
                    set("threshold", null)
                  }}
                >
                  Clear
                </Button>
              </div>
            </div>
            {draft.type === "llm" && draft.modelType !== "evaluation" && (
              <label className="flex items-center justify-between gap-3 border-b border-border px-3 py-3 text-sm">
                <span>Chain of thought</span>
                <Switch
                  aria-label="Chain of thought"
                  checked={draft.chainOfThought ?? false}
                  onCheckedChange={(checked) => set("chainOfThought", checked)}
                />
              </label>
            )}
            <InspectorSection label="Description" variant="form">
              <Textarea
                aria-label="Description"
                autoSize
                rows={1}
                className="mt-2"
                placeholder="What does this scorer measure?"
                value={draft.description}
                onChange={(e) => set("description", e.target.value)}
              />
            </InspectorSection>
            <InspectorSection label="Slug" variant="form">
              <Input
                aria-label="Slug"
                value={draft.slug}
                placeholder="answer-correctness"
                onChange={(e) => {
                  setSlugEdited(Boolean(e.target.value))
                  set("slug", e.target.value || slugify(draft.name))
                }}
              />
            </InspectorSection>
            {draft.type === "llm" && draft.modelType !== "evaluation" && (
              <InspectorSection label="Custom Image Path" variant="form">
                <p className="mt-1 mb-3 text-xs text-foreground-muted">
                  Send images to a vision-capable model. Enter up to four image URL fields, separated by commas, such as output.image.url.
                </p>
                <Input
                  aria-label="Custom Image Path"
                  placeholder="output.image.url"
                  value={(draft.imagePaths ?? []).join(", ")}
                  onChange={(event) => set("imagePaths", event.target.value ? event.target.value.split(",").map((path) => path.trim()) : [])}
                />
              </InspectorSection>
            )}
          </section>
        </ResizablePanel>
        <ResizableHandle withHandle aria-label="Resize scorer panels" />
        <ResizablePanel id="scorer-tests" defaultSize="50%" minSize="20%">
          <ScorerTestPanel
            onModelError={() => setModelAttention((request) => request + 1)}
            config={draft}
            actionsContainer={testActionsContainer}
            traceIds={traceIds}
            disabled={pending || !libraryValid}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
