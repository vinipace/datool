"use client"

import { PanelActionLabel } from "@/components/ui/panel-action-label"
import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ReviewAnnotationsProvider, ReviewAnnotationComments } from "./review-annotations"
import { ReviewCustomFields } from "./review-custom-fields"
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  MessageSquare,
  ListChecks,
  Play,
  Plus,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { reviewAttribution } from "@/src/lib/tracer/review-provenance"
import { DEFAULT_REVIEW_NAME } from "@/src/lib/tracer/reviews"
import { Textarea } from "@/components/ui/textarea"
import { ReviewerCombobox } from "@/components/ui/reviewer-combobox"
import { Notice } from "@/components/ui/notice"
import { toast } from "@/components/ui/toast"
import { PieProgress } from "@/components/ui/pie-progress"
import { UserAvatar, UserAvatarImage } from "@/components/ui/user-avatar"
import { ComboboxMultiple, type ComboboxOption } from "@/components/ui/combobox"
import { HumanScoreInput } from "./human-score-input"
import { humanScoreIcon } from "./human-score-icon"
import { HumanScoreDialog, HumanCollectionSelect } from "./human-scores-page"
import {
  createReviewAutosave,
  emptyReviewDraft,
  type ReviewAutosave,
  type ReviewScoreDraft,
} from "@/src/lib/tracer/review-autosave"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type {
  ReviewItemDetail,
  ReviewOptions,
  ReviewScore,
  ReviewSessionDetail,
  ReviewSessionTable as ReviewSessionTableData,
} from "@/src/lib/tracer/reviews"
import {
  humanScoreTypeLabel,
  type HumanScoreLibrary,
} from "@/src/lib/tracer/human-scores"
import { tracerApi } from "./api"
import { CollectionPanel } from "./collection-panel"
import { CollectionPage } from "./collection-page"
import { CollectionFilterBar } from "./collection-filter"
import { InfiniteScroll } from "./infinite-scroll"
import { HeaderSlot } from "./collection-header"
import { useCollectionFilter } from "./use-collection-filter"
import { useCollectionPages } from "./use-collection-pages"
import { useMutation, useRemote } from "./hooks"
import { useWorkspaceHref, useWorkspaceStorageScope } from "./workspace-path"
import { useReviewSessionCreation } from "./review-session-creation"
import { EmptyState, ErrorState, LoadingState } from "./primitives"
import { LogTable, LogTableBody, LogRow } from "./log-table"
import { logTable } from "./log-table-styles"
import { formatDate } from "./format"
import { TraceInspector } from "./trace-inspector"
import { ReviewPanels } from "./review-panels"
import { ReviewSessionTable } from "./review-session-table"
import {
  ReviewSessionTitle,
  ReviewSessionReviewers,
  ReviewSessionCollection,
  ReviewSelectionActions,
} from "./review-session-controls"

const reviewStatus = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
}

export function ReviewsPage() {
  const href = useWorkspaceHref()
  const router = useRouter()
  const search = useCollectionFilter("reviews")
  const page = useCollectionPages(tracerApi.reviews.list, search.filter, 15000)
  const [creating, setCreating] = React.useState(false)
  return (
    <>
      <CollectionPanel label="Reviews">
        <CollectionPage
          className="contents"
          state={page}
          loadingLabel="Loading reviews"
          pagination={page}
          header={{
            exportRows: page.items,
            exportName: "reviews",
            children: <CollectionFilterBar resource="reviews" {...search} />,
            actions: (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-4" />
                <PanelActionLabel>New session</PanelActionLabel>
              </Button>
            ),
          }}
          isEmpty={!page.items.length}
          empty={
            <EmptyState
              icon={ClipboardCheck}
              title={
                search.filter ? "No matching reviews" : "No review sessions yet"
              }
              detail={
                search.filter
                  ? "Try changing or clearing the filter."
                  : "Collect traces, assign a reviewer, and review prompts and outputs one at a time."
              }
            />
          }
        >
          <LogTable
            persistenceKey="reviews"
            fillHeight
            columnIds={["name", "assignee", "progress", "provenance", "status", "created"]}
            widths={[300, 200, 160, 280, 140, 180]}
          >
            <thead className={logTable.head}>
              <tr>
                {[
                  "No.",
                  "Session",
                  "Assigned to",
                  "Complete",
                  "Provenance",
                  "Status",
                  "Created",
                ].map((label) => (
                  <th key={label} scope="col" className={logTable.heading}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <LogTableBody
              rows={page.items}
              empty="No review sessions."
              children={(session) => (
                <LogRow
                  key={session.id}
                  onClick={() =>
                    router.push(href(`/reviews/${session.number}`))
                  }
                >
                  <td className={logTable.cell}>{session.number}</td>
                  <td className={logTable.cell}>
                    <Link
                      href={href(`/reviews/${session.number}`)}
                      className="block truncate font-medium"
                    >
                      {session.name}
                    </Link>
                  </td>
                  <td className={logTable.cell}>
                    {session.reviewers.length ? (
                      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                        {session.reviewers.map((reviewer) => (
                          <span
                            key={reviewer.id}
                            className="flex min-w-0 items-center gap-2"
                          >
                            <span aria-hidden="true">
                              <UserAvatarImage
                                name={reviewer.name}
                                image={reviewer.image}
                              />
                            </span>
                            <span className="truncate" title={reviewer.name}>
                              {reviewer.name}
                            </span>
                          </span>
                        ))}
                      </div>
                    ) : (
                      "Unassigned"
                    )}
                  </td>
                  <td className={logTable.cell}>
                    {session.reviewedCount} /{" "}
                    {session.traceCount - session.skippedCount}
                    {session.skippedCount > 0 &&
                      ` · ${session.skippedCount} skipped`}
                  </td>
                  <td className={logTable.cell}>
                    {session.humanReviewedCount ?? session.reviewedCount} human · {session.aiReviewedCount ?? 0} AI complete · {session.aiLabelledCount ?? 0} AI-labelled
                  </td>
                  <td className={logTable.cell}>
                    {reviewStatus[session.status]}
                  </td>
                  <td className={logTable.cell}>
                    {formatDate(session.createdAt)}
                  </td>
                </LogRow>
              )}
            />
          </LogTable>
        </CollectionPage>
      </CollectionPanel>
      <Dialog open={creating} onOpenChange={setCreating}>
        {creating && (
          <CreateReviewDialog
            onCreated={(session) =>
              router.push(href(`/reviews/${session.number}`))
            }
          />
        )}
      </Dialog>
    </>
  )
}

export function CreateReviewDialog({
  onCreated,
  initialTraces = [],
  onCloseAutoFocus,
}: {
  onCreated: (session: ReviewSessionDetail) => void
  initialTraces?: { id: string; name: string }[]
  onCloseAutoFocus?: React.ComponentProps<
    typeof DialogContent
  >["onCloseAutoFocus"]
}) {
  const [name, setName] = React.useState(DEFAULT_REVIEW_NAME)
  const [prompt, setPrompt] = React.useState("")
  const [reviewerUserIds, setReviewerUserIds] = React.useState<string[]>([])
  const [collectionId, setCollectionId] = React.useState<string | null>(null)
  const [selected, setSelected] =
    React.useState<{ id: string; name: string }[]>(initialTraces)
  const options = useRemote(tracerApi.reviews.options, [])
  const search = useCollectionFilter("traces", "", { persist: false })
  const traces = useCollectionPages(tracerApi.traces.list, search.filter, 60000)
  const mutation = useMutation()
  function move(index: number, direction: number) {
    setSelected((current) => {
      const next = [...current]
      ;[next[index], next[index + direction]] = [
        next[index + direction],
        next[index],
      ]
      return next
    })
  }
  return (
    <DialogContent
      className="max-w-4xl"
      onCloseAutoFocus={onCloseAutoFocus}
      onEscapeKeyDown={(event) => {
        if (mutation.isPending) event.preventDefault()
      }}
      onInteractOutside={(event) => event.preventDefault()}
    >
      <DialogHeader>
        <DialogTitle>New review session</DialogTitle>
        <DialogDescription>
          Select traces in playback order and give the reviewer instructions.
        </DialogDescription>
      </DialogHeader>
      <form
        className="grid min-w-0 gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          void mutation
            .run(() =>
              tracerApi.reviews.create({
                name,
                prompt,
                reviewerUserIds,
                collectionId,
                traceIds: selected.map((trace) => trace.id),
              })
            )
            .then(onCreated)
            .catch(() => {})
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm">
            Session name
            <Input
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={DEFAULT_REVIEW_NAME}
              onBlur={() => {
                if (!name.trim()) setName(DEFAULT_REVIEW_NAME)
              }}
            />
          </label>
          <div className="grid justify-items-start gap-1.5 text-sm">
            <span>Reviewers</span>
            <ReviewerCombobox
              reviewers={options.data?.members ?? []}
              value={reviewerUserIds}
              onValueChange={setReviewerUserIds}
              disabled={!options.data || mutation.isPending}
            />
          </div>
        </div>
        <HumanCollectionSelect
          value={collectionId}
          onChange={setCollectionId}
          disabled={mutation.isPending}
        />
        {options.error && (
          <ErrorState error={options.error} onRetry={options.refresh} />
        )}
        <label className="grid gap-1.5 text-sm">
          Review prompt
          <Textarea
            rows={2}
            maxLength={16000}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="What should the reviewer check in each prompt and response?"
          />
        </label>
        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          <section className="min-w-0 space-y-2" aria-label="Available traces">
            <h3 className="text-sm font-medium">Choose traces</h3>
            <CollectionFilterBar resource="traces" {...search} />
            {traces.error && (
              <ErrorState error={traces.error} onRetry={traces.refresh} />
            )}
            {traces.isLoading && <LoadingState label="Loading traces" />}
            <div className="h-56 space-y-1 overflow-auto rounded-md border border-border p-2">
              {!traces.isLoading && !traces.error && !traces.items.length && (
                <p className="p-2 text-sm text-foreground-muted">
                  No matching traces.
                </p>
              )}
              {traces.items.map((trace) => (
                <label
                  key={trace.id}
                  className="flex min-w-0 items-center gap-2 rounded-md bg-surface-row p-2 text-sm"
                >
                  <Checkbox
                    checked={selected.some((item) => item.id === trace.id)}
                    disabled={
                      mutation.isPending ||
                      (selected.length >= 500 &&
                        !selected.some((item) => item.id === trace.id))
                    }
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, { id: trace.id, name: trace.name }]
                          : current.filter((item) => item.id !== trace.id)
                      )
                    }
                  />
                  <span className="min-w-0">
                    <span className="block truncate">{trace.name}</span>
                    <span className="text-xs text-foreground-muted">
                      {formatDate(trace.startedAt)}
                    </span>
                  </span>
                </label>
              ))}
              <InfiniteScroll {...traces} />
            </div>
          </section>
          <section className="min-w-0 space-y-2" aria-label="Playback order">
            <h3 className="text-sm font-medium">
              Playback order · {selected.length} / 500
            </h3>
            <ol className="max-h-72 space-y-1 overflow-auto">
              {selected.map((trace, index) => (
                <li
                  key={trace.id}
                  className="flex min-w-0 items-center gap-1 rounded-md bg-surface-row p-2 text-sm"
                >
                  <span className="w-6 shrink-0 text-foreground-muted">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{trace.name}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    aria-label={`Move ${trace.name} up`}
                    disabled={index === 0 || mutation.isPending}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    aria-label={`Move ${trace.name} down`}
                    disabled={
                      index === selected.length - 1 || mutation.isPending
                    }
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    aria-label={`Remove ${trace.name}`}
                    disabled={mutation.isPending}
                    onClick={() =>
                      setSelected((current) =>
                        current.filter((item) => item.id !== trace.id)
                      )
                    }
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ol>
            {!selected.length && (
              <p className="text-sm text-foreground-muted">
                Select traces on the left. You can change their order here.
              </p>
            )}
          </section>
        </div>
        {mutation.error && (
          <Notice variant="error">{mutation.error.message}</Notice>
        )}
        <div className="flex justify-end">
          <Button
            type="submit"
            loading={mutation.isPending}
            disabled={!selected.length}
          >
            Create session
          </Button>
        </div>
      </form>
    </DialogContent>
  )
}

export function ReviewSessionPage({
  sessionId,
  traceId,
}: {
  sessionId: string
  traceId?: string
}) {
  return <ReviewSession key={sessionId} sessionId={sessionId} traceId={traceId} />
}

function ReviewSession({
  sessionId,
  traceId,
}: {
  sessionId: string
  traceId?: string
}) {
  const router = useRouter()
  const href = useWorkspaceHref()
  const scope = useWorkspaceStorageScope()
  const creation = useReviewSessionCreation(scope, sessionId)
  const load = React.useCallback(
    (signal: AbortSignal) => tracerApi.reviews.table(sessionId, signal),
    [sessionId]
  )
  const state = useRemote(load, [sessionId], {
    enabled: !creation.snapshot || !!creation.snapshot.data.number,
  })
  const [sessionOverride, setSessionOverride] =
    React.useState<ReviewSessionTableData | null>(null)
  const [savingCollection, setSavingCollection] = React.useState(false)
  const [checkedIds, setCheckedIds] = React.useState<Set<string>>(
    () => new Set()
  )
  const [draftStores] = React.useState(() => new Map<string, ReviewAutosave>())
  const [reloadKey, setReloadKey] = React.useState(0)
  React.useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (![...draftStores.values()].some((store) => store.pending())) return
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warn)
    return () => {
      window.removeEventListener("beforeunload", warn)
      for (const store of draftStores.values())
        if (!store.getSnapshot().error) void store.flush().catch(() => {})
    }
  }, [draftStores])
  const confirmed = state.data ?? creation.snapshot?.data ?? null
  const session =
    sessionOverride &&
    (savingCollection ||
      !confirmed ||
      sessionOverride.revision > confirmed.revision)
      ? sessionOverride
      : confirmed
  const creating = !!creation.snapshot && !creation.snapshot.data.number
  const sessionBusy = creating || savingCollection
  const selectedItem = session?.items.find((item) => item.traceId === traceId)
  const itemId = selectedItem?.id ?? null
  const pageState = {
    ...state,
    data: session,
    isLoading: !session && state.isLoading,
  }
  const sessionHref = href(`/reviews/${session?.number || sessionId}`)
  const canonicalHref = session?.number
    ? `${sessionHref}${traceId ? `/${encodeURIComponent(traceId)}` : ""}`
    : null
  React.useEffect(() => {
    if (session && sessionId !== String(session.number) && canonicalHref)
      router.replace(canonicalHref, { scroll: false })
  }, [session, sessionId, canonicalHref, router])
  const activeItems = session?.items.filter((item) => !item.skippedAt) ?? []
  function navigate(id: string | null) {
    const target = id ? session?.items.find((item) => item.id === id) : null
    if (id && !target) return
    router.push(
      `${sessionHref}${target ? `/${encodeURIComponent(target.traceId)}` : ""}`,
      { scroll: false }
    )
  }
  const clearSelection = () => {
    setCheckedIds(new Set())
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(
          '[aria-label="Review session controls"] button[aria-label="More actions"]'
        )
        ?.focus()
    )
  }
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {session && (
        <HeaderSlot name="title">
          {traceId ? (
            <span
              aria-current="page"
              title={selectedItem?.traceName || traceId}
              className="block truncate"
            >
              {selectedItem?.traceName || traceId}
            </span>
          ) : session.number ? (
            `#${session.number}`
          ) : (
            "New review"
          )}
        </HeaderSlot>
      )}
      <CollectionPanel
        label="Review session"
        refreshInMenu
        displayIconOnly
        heading={
          session ? (
            <ReviewSessionTitle
              key={`${session.revision}:${session.name}`}
              session={session}
              disabled={state.isRefreshing || sessionBusy}
              onSaved={state.refresh}
            />
          ) : (
            <Skeleton className="h-10 w-48 max-w-full" />
          )
        }
        selectionControls={
          !traceId &&
          session &&
          session.items.some((item) => checkedIds.has(item.traceId)) ? (
            <ReviewSelectionActions
              session={session}
              checkedIds={checkedIds}
              onClear={clearSelection}
              disabled={state.isRefreshing || sessionBusy}
              prepareItems={async () => {
                const selected = session.items.filter((item) =>
                  checkedIds.has(item.traceId)
                )
                return Promise.all(
                  selected.map(async (item) => {
                    const store = draftStores.get(item.id)
                    if (store?.pending()) await store.flush()
                    if (store?.pending())
                      throw new Error(
                        `Complete or clear unsaved ratings for ${item.traceName} before updating its selection.`
                      )
                    return {
                      id: item.id,
                      expectedRevision:
                        store?.getSnapshot().saved.revision ?? item.revision,
                    }
                  })
                )
              }}
              onChanged={() => {
                for (const item of session.items)
                  if (checkedIds.has(item.traceId)) draftStores.delete(item.id)
                clearSelection()
                state.refresh()
              }}
            />
          ) : undefined
        }
      >
        {traceId && session && (!selectedItem || selectedItem.skippedAt) ? (
          <div className="p-3">
            <Notice variant="warning">
              {selectedItem
                ? "This trace is skipped."
                : "This trace is not in this review session."}{" "}
              <Link href={sessionHref} className="underline">
                Open session
              </Link>
            </Notice>
          </div>
        ) : itemId && session ? (
          <ReviewPlayer
            key={`${itemId}:${reloadKey}`}
            session={session}
            itemId={itemId}
            draftStores={draftStores}
            onPersisted={state.refresh}
            onReload={() => {
              draftStores.delete(itemId)
              setReloadKey((key) => key + 1)
            }}
            onNavigate={navigate}
            onSaved={(nextId) => {
              if (!nextId) {
                toast.add({
                  title: "Review saved",
                  description: session.items.every((item) =>
                    item.id === itemId
                      ? draftStores.get(item.id)?.getSnapshot().saved.reviewedAt
                      : item.reviewedAt || item.skippedAt
                  )
                    ? "All remaining traces have been reviewed."
                    : "Continue with the remaining traces when ready.",
                  type: "success",
                })
              }
              state.refresh()
              navigate(nextId)
            }}
          />
        ) : (
          <CollectionPage
            className="contents"
            state={pageState}
            loadingLabel="Loading review session"
            header={{
              actions: session && (
                <>
                  <ReviewSessionReviewers
                    session={session}
                    disabled={state.isRefreshing || sessionBusy}
                    onSaved={state.refresh}
                  />
                  <ReviewSessionCollection
                    session={session}
                    disabled={creating || state.isRefreshing}
                    onPendingChange={setSavingCollection}
                    prepare={async () => {
                      await Promise.all(
                        [...draftStores.values()].map((store) => store.flush())
                      )
                      if (
                        [...draftStores.values()].some((store) => store.pending())
                      )
                        throw new Error(
                          "Complete or clear invalid ratings before changing the collection."
                        )
                    }}
                    onChange={(next) => {
                      const columns = new Map(
                        (next.collection?.scores ?? []).map((score) => [
                          score.id,
                          { id: score.id, name: score.name, type: score.type },
                        ])
                      )
                      for (const column of session.scoreColumns)
                        if (
                          session.scores.some(
                            (score) => score.humanScoreId === column.id
                          ) &&
                          !columns.has(column.id)
                        )
                          columns.set(column.id, column)
                      setSessionOverride({
                        ...session,
                        ...next,
                        scoreColumns: [...columns.values()],
                      })
                    }}
                    onSaved={() => {
                      draftStores.clear()
                      state.refresh()
                    }}
                    onError={state.refresh}
                  />
                  <Button
                    size="sm"
                    disabled={
                      !activeItems.length || state.isRefreshing || sessionBusy
                    }
                    onClick={() => {
                      navigate(
                        activeItems.find((item) => !item.reviewedAt)?.id ??
                          activeItems[0]?.id ??
                          null
                      )
                    }}
                  >
                    <Play className="size-4" />
                    <PanelActionLabel>
                      {session.reviewedCount ? "Resume review" : "Start"}
                    </PanelActionLabel>
                  </Button>
                </>
              ),
            }}
          >
            {session && (
              <>
                {creating && (
                  <div className="shrink-0 p-3">
                    {creation.snapshot?.error ? (
                      <Notice variant="error" role="alert">
                        Couldn’t create this review.{" "}
                        {creation.snapshot.error.message}{" "}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void creation.retry?.()}
                        >
                          Retry
                        </Button>
                      </Notice>
                    ) : (
                      <p
                        role="status"
                        className="text-xs text-foreground-muted"
                      >
                        Creating review…
                      </p>
                    )}
                  </div>
                )}
                <p className="px-3 pt-3 text-xs text-foreground-muted">
                  {session.humanReviewedCount ?? session.reviewedCount} human complete · {session.aiReviewedCount ?? 0} AI complete · {session.aiLabelledCount ?? 0} AI-labelled
                </p>
                {session.prompt && (
                  <div className="shrink-0 p-3">
                    <p className="max-h-40 overflow-auto text-sm break-words whitespace-pre-wrap">
                      {session.prompt}
                    </p>
                  </div>
                )}
                <ReviewSessionTable
                  session={session}
                  checkedIds={checkedIds}
                  onCheckedIdsChange={setCheckedIds}
                  onOpen={(id) => {
                    if (sessionBusy) return
                    if (
                      session.items.find((item) => item.id === id)?.skippedAt
                    ) {
                      toast.add({
                        title: "This trace is skipped",
                        description:
                          "Select it and choose Restore to review it.",
                      })
                      return
                    }
                    navigate(id)
                  }}
                />
              </>
            )}
          </CollectionPage>
        )}
      </CollectionPanel>
    </div>
  )
}

function ReviewEditors({ scores }: { scores: ReviewScore[] }) {
  const editors = new Map<string, ReviewScore>()
  for (const score of scores) {
    const key = score.editedBy?.principal?.id ?? score.provenance?.principal?.id ?? score.reviewerId ?? "former-member"
    const previous = editors.get(key)
    if (!previous || score.updatedAt > previous.updatedAt)
      editors.set(key, score)
  }
  if (!editors.size) return null
  return (
    <div
      role="group"
      aria-label="Score editors"
      className="flex max-w-1/2 flex-wrap justify-end gap-1"
    >
      {[...editors.entries()]
        .sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt))
        .map(([id, score]) => {
          const name = score.editedBy?.principal?.name ?? score.provenance?.principal?.name ?? score.reviewerName ?? "Former member"
          return (
            <UserAvatar
              key={id}
              name={name}
              image={score.reviewerImage}
              label={score.editedBy || score.provenance ? reviewAttribution(score.editedBy ?? score.provenance) : `Edited by ${name}${score.source === "mcp" ? " via MCP" : ""}`}
            />
          )
        })}
    </div>
  )
}

function ReviewPlayer({
  session,
  itemId,
  onNavigate,
  onSaved,
  draftStores,
  onPersisted,
  onReload,
}: {
  session: ReviewSessionDetail
  itemId: string
  onNavigate: (id: string) => void
  onSaved: (id: string | null) => void
  draftStores: Map<string, ReviewAutosave>
  onPersisted: () => void
  onReload: () => void
}) {
  const load = React.useCallback(
    (signal: AbortSignal) => tracerApi.reviews.item(session.id, itemId, signal),
    [session.id, itemId]
  )
  const item = useRemote(load, [session.id, itemId])
  const library = useRemote(tracerApi.humanScores.library, [])
  const options = useRemote(tracerApi.reviews.options, [])
  if (!item.data || !library.data || !options.data)
    return (
      <div className="p-4">
        {item.error || library.error || options.error ? (
          <ErrorState
            error={item.error ?? library.error ?? options.error!}
            onRetry={() => {
              item.refresh()
              library.refresh()
              options.refresh()
            }}
          />
        ) : (
          <LoadingState label="Loading review" />
        )}
      </div>
    )
  return (
    <ReviewEditor
      key={`${item.data.id}:${item.data.revision}`}
      session={session}
      item={item.data}
      library={library.data}
      onLibraryRefresh={library.refresh}
      options={options.data}
      draftStores={draftStores}
      onPersisted={onPersisted}
      errors={
        <>
          {item.error && (
            <ErrorState error={item.error} onRetry={item.refresh} />
          )}
          {library.error && (
            <ErrorState error={library.error} onRetry={library.refresh} />
          )}
          {options.error && (
            <ErrorState error={options.error} onRetry={options.refresh} />
          )}
        </>
      }
      onReload={onReload}
      onNavigate={onNavigate}
      onSaved={onSaved}
    />
  )
}

function ReviewEditor({
  session,
  item,
  library,
  onLibraryRefresh,
  options,
  errors,
  onReload,
  onNavigate,
  onSaved,
  draftStores,
  onPersisted,
}: {
  session: ReviewSessionDetail
  item: ReviewItemDetail
  library: HumanScoreLibrary
  onLibraryRefresh: () => void
  options: ReviewOptions | null
  errors: React.ReactNode
  onReload: () => void
  onNavigate: (id: string) => void
  onSaved: (id: string | null) => void
  draftStores: Map<string, ReviewAutosave>
  onPersisted: () => void
}) {
  const [autosave] = React.useState(() => {
    const cached = draftStores.get(item.id)
    if (
      cached &&
      (cached.pending() || cached.getSnapshot().saved.revision >= item.revision)
    )
      return cached
    const store = createReviewAutosave({
      initial: item,
      save: async (input) => {
        const result = await tracerApi.reviews.record(
          session.id,
          item.id,
          input
        )
        onPersisted()
        return result
      },
      onError: (error) =>
        toast.add({
          title: "Couldn’t save review",
          description: `${item.traceName}: ${error.message}`,
          type: "error",
        }),
    })
    draftStores.set(item.id, store)
    return store
  })
  const { drafts, notes, annotations, saved, status, error } = React.useSyncExternalStore(
    autosave.subscribe,
    autosave.getSnapshot,
    autosave.getSnapshot
  )
  const setDrafts = autosave.update
  React.useEffect(
    () => () => {
      if (!autosave.getSnapshot().error) void autosave.flush().catch(() => {})
    },
    [autosave]
  )
  const [finishing, setFinishing] = React.useState(false)
  const formId = React.useId()
  const [creatingName, setCreatingName] = React.useState<string | null>(null)
  const definitions = new Map(
    library.scores.map((definition) => [definition.id, definition])
  )
  for (const draft of drafts) definitions.set(draft.key, draft.definition)
  const scoreOptions: ComboboxOption[] = [...definitions.values()].map(
    (definition) => ({
      value: definition.id,
      label: definition.name,
      description: humanScoreTypeLabel(definition),
      icon: humanScoreIcon(definition),
    })
  )
  const valid = autosave.valid()
  const activeItems = session.items.filter((entry) => !entry.skippedAt)
  const position = activeItems.findIndex((entry) => entry.id === item.id) + 1
  function navigate(id: string) {
    if (!error) void autosave.flush().catch(() => {})
    onNavigate(id)
  }
  async function finish() {
    setFinishing(true)
    try {
      await autosave.flush()
      if (!autosave.pending()) onSaved(null)
    } catch {
      // The autosave error keeps this draft available for retry.
    } finally {
      setFinishing(false)
    }
  }
  function edit(index: number, patch: Partial<ReviewScoreDraft>) {
    setDrafts((current) =>
      current.map((score, i) => (i === index ? { ...score, ...patch } : score))
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <HeaderSlot name="actions">
        <div
          className="flex shrink-0 items-center gap-2 text-xs text-foreground-muted tabular-nums"
          aria-live="polite"
        >
          <span>
            {position}/{activeItems.length}
          </span>
          <PieProgress
            value={position}
            max={activeItems.length}
            label="Trace position"
          />
        </div>
        <div className="flex gap-1">
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Previous trace"
            disabled={finishing || !item.previousItemId}
            onClick={() => item.previousItemId && navigate(item.previousItemId)}
          >
            <ChevronLeft />
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Next trace"
            disabled={finishing || !item.nextItemId}
            onClick={() => item.nextItemId && navigate(item.nextItemId)}
          >
            <ChevronRight />
          </Button>
        </div>
        <Button
          type="submit"
          form={formId}
          formNoValidate={Boolean(item.nextItemId)}
          size="sm"
          loading={finishing}
          disabled={
            (!item.nextItemId && (!valid || !drafts.length)) ||
            !options?.currentUserId
          }
        >
          <Check />
          <PanelActionLabel>
            {item.nextItemId ? "Next" : "Finish review"}
          </PanelActionLabel>
        </Button>
      </HeaderSlot>
      <ReviewAnnotationsProvider annotations={annotations} disabled={finishing || !options?.currentUserId}>
        <ReviewPanels
          trace={
            <TraceInspector
              traceId={item.traceId}
              mode="panel"
              hideTraceNavigation
              hideOverviewScores
              customColumnDetails={<ReviewCustomFields key={item.traceId} traceId={item.traceId} />}
            />
          }
        >
          <aside
            className="h-full min-w-0 space-y-4 overflow-y-auto p-4"
            aria-label="Review scores"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">Human Scores</h2>
                <p className="mt-1 text-xs text-foreground-muted">
                  {session.collection
                    ? session.collection.name
                    : "Choose criteria from your Human Score library."}
                </p>
              </div>
              <ReviewEditors scores={saved.scores} />
            </div>
            {saved.lastSubmission && <p className="text-xs text-foreground-muted">Last submission: {reviewAttribution(saved.lastSubmission)}</p>}
            {saved.label === "AI-labelled" && (
              <Notice>AI-labelled. AI submissions are not human-verified dataset ground truth.</Notice>
            )}
            {errors}
            <form
              id={formId}
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault()
                if (item.nextItemId) navigate(item.nextItemId)
                else if (valid) void finish()
              }}
            >
              <ComboboxMultiple
                label="Human Scores"
                icon={<ListChecks />}
                placeholder="Select or add Human Scores…"
                options={scoreOptions}
                value={drafts.map((score) => score.key)}
                maxSelected={30}
                inputMaxLength={120}
                disabled={finishing || !options?.currentUserId}
                disabledValues={item.definitions.map(
                  (definition) => definition.id
                )}
                createDescription="custom"
                onCreate={setCreatingName}
                onValueChange={(keys) =>
                  setDrafts((current) => {
                    const selected = new Set([
                      ...item.definitions.map((definition) => definition.id),
                      ...keys,
                    ])
                    return [...selected].map(
                      (key) =>
                        current.find((score) => score.key === key) ??
                        emptyReviewDraft(definitions.get(key)!)
                    )
                  })
                }
              />
              {saved.notesProvenance && <p className="text-xs text-foreground-muted">Notes: {reviewAttribution(saved.notesProvenance)}</p>}
              <Textarea
                aria-label="Review notes"
                icon={<MessageSquare />}
                variant="plain"
                autoSize
                rows={1}
                maxLength={16000}
                value={notes}
                onChange={(event) => autosave.updateNotes(event.target.value)}
                placeholder="Add notes..."
                disabled={finishing || !options?.currentUserId}
              />
              <ReviewAnnotationComments saved={saved.annotations} onChange={autosave.updateAnnotations} />
              {drafts.length === 0 && (
                <p className="text-xs text-foreground-muted">
                  Select Human Scores to start reviewing this trace.
                </p>
              )}
              {drafts.map((score, index) => {
                const definition = score.definition
                const name = definition.name
                const Icon = humanScoreIcon(definition)
                return (
                  <fieldset
                    key={score.key}
                    aria-label={name}
                    className="min-w-0 space-y-3 rounded-md border border-border bg-muted p-3"
                    disabled={finishing || !options?.currentUserId}
                  >
                    <h3 className="flex items-center gap-2 text-lg font-medium">
                      <Icon
                        aria-hidden
                        className="size-4 shrink-0 text-foreground-muted"
                      />
                      <span className="min-w-0 break-words">{name}</span>
                    </h3>
                    {saved.scores.find(entry => entry.humanScoreId === definition.id)?.provenance && (
                      <p className="text-xs text-foreground-muted">{reviewAttribution(saved.scores.find(entry => entry.humanScoreId === definition.id)?.provenance)}</p>
                    )}
                    {definition.description && (
                      <p className="text-xs whitespace-pre-wrap text-foreground-muted">
                        {definition.description}
                      </p>
                    )}
                    <HumanScoreInput
                      definition={definition}
                      value={score.value}
                      onChange={(value) => edit(index, { value })}
                      disabled={finishing || !options?.currentUserId}
                    />
                  </fieldset>
                )
              })}
              {error && (
                <Notice variant="error">
                  {error.message}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() => {
                      void autosave.flush().catch(() => {})
                    }}
                  >
                    Retry save
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={onReload}
                  >
                    Reload saved review
                  </Button>
                </Notice>
              )}
              {(drafts.length > 0 ||
                notes.length > 0 ||
                status !== "saved" ||
                saved.revision > 0) && (
                <p role="status" className="text-xs text-foreground-muted">
                  {status === "saving"
                    ? "Saving…"
                    : status === "incomplete"
                      ? "Check the value against this Human Score’s limits."
                      : status === "error"
                        ? "Changes not saved."
                        : "All changes saved"}
                </p>
              )}
            </form>
          </aside>
        </ReviewPanels>
      </ReviewAnnotationsProvider>
      <Dialog
        open={creatingName !== null}
        onOpenChange={(open) => {
          if (!open) setCreatingName(null)
        }}
      >
        {creatingName !== null && (
          <HumanScoreDialog
            initialName={creatingName}
            onSaved={(definition) => {
              setDrafts((current) => [...current, emptyReviewDraft(definition)])
              setCreatingName(null)
              onLibraryRefresh()
            }}
          />
        )}
      </Dialog>
    </div>
  )
}
