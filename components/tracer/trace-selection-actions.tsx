"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  ClipboardCheck,
  Download,
  Percent,
  Plus,
  Tag,
  Trash2,
} from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Combobox } from "@/components/ui/combobox"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import { PanelActionLabel } from "@/components/ui/panel-action-label"
import {
  SelectionToolbar,
  SelectionActionButton,
} from "@/components/ui/selection-toolbar"
import { toast } from "@/components/ui/toast"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { TraceSummary } from "@/src/lib/tracer/contracts"
import { tracerApi } from "./api"
import { ScorerPicker } from "./scorer-picker"
import { CollectionPagination } from "./collection-pagination"
import { useCollectionPages } from "./use-collection-pages"
import { useMutation } from "./hooks"
import { startReviewSession } from "./review-session-creation"
import { ErrorState, LoadingState } from "./primitives"
import { downloadTraceExport, tracesToCsv } from "./trace-list-utils"
import { useWorkspaceHref, useWorkspaceStorageScope } from "./workspace-path"

type Action = "dataset" | "tag" | "score" | "delete"
type SelectionAction = { kind: Action; traces: TraceSummary[] }

// List rows contain previews. Read full payloads before exporting or importing.
async function loadPayloads(traces: TraceSummary[]) {
  const rows: TraceSummary[] = []
  for (let index = 0; index < traces.length; index += 5) {
    rows.push(
      ...(await Promise.all(
        traces
          .slice(index, index + 5)
          .map((trace) => tracerApi.traces.payload(trace.id))
      ))
    )
  }
  return rows
}

export function TraceSelectionActions({
  traces,
  onClear,
  onChanged,
  onDeleted,
}: {
  traces: TraceSummary[]
  onClear: () => void
  onChanged: () => void
  onDeleted: (ids: string[]) => void
}) {
  const router = useRouter()
  const href = useWorkspaceHref()
  const scope = useWorkspaceStorageScope()
  const creating = React.useRef(false)
  const [action, setAction] = React.useState<SelectionAction | null>(null)
  const [downloading, setDownloading] = React.useState(false)
  const trigger = React.useRef<HTMLButtonElement | null>(null)
  const deleteMutation = useMutation()
  const [deleteAttempted, setDeleteAttempted] = React.useState(false)
  const count = traces.length
  const tooMany = count > 500
  function open(kind: Action, event: React.MouseEvent<HTMLButtonElement>) {
    setDeleteAttempted(false)
    trigger.current = event.currentTarget
    setAction({ kind, traces: [...traces] })
  }
  function restoreFocus(event: Event) {
    event.preventDefault()
    trigger.current?.focus()
  }
  async function download(format: "json" | "csv") {
    setDownloading(true)
    try {
      const rows = await loadPayloads(traces)
      downloadTraceExport({
        content:
          format === "json" ? JSON.stringify(rows, null, 2) : tracesToCsv(rows),
        filename: `datool-selected-traces.${format}`,
        type: format === "json" ? "application/json" : "text/csv;charset=utf-8",
      })
    } catch (error) {
      toast.add({
        title: "Download failed",
        description:
          error instanceof Error
            ? error.message
            : "Could not load the selected traces.",
        type: "error",
      })
    } finally {
      setDownloading(false)
    }
  }
  return (
    <>
      <SelectionToolbar
        count={count}
        onClear={onClear}
        label="Selected trace actions"
      >
        <SelectionActionButton
          variant="outline"
          size="sm"
          disabled={downloading || tooMany}
          onClick={() => {
            if (creating.current) return
            creating.current = true
            const creation = startReviewSession(scope, traces)
            void creation.save().finally(() => {
              creating.current = false
            })
            router.push(href(`/reviews/${creation.id}`))
          }}
        >
          <ClipboardCheck aria-hidden="true" className="size-3.5" />
          <PanelActionLabel>Review</PanelActionLabel>
        </SelectionActionButton>
        <SelectionActionButton
          variant="outline"
          size="sm"
          disabled={downloading || count > 100}
          title={
            count > 100
              ? "Select up to 100 traces to add to a dataset."
              : undefined
          }
          onClick={(event) => open("dataset", event)}
        >
          <Plus aria-hidden="true" className="size-3.5" />
          <PanelActionLabel>Add To</PanelActionLabel>
        </SelectionActionButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SelectionActionButton
              variant="outline"
              size="sm"
              loading={downloading}
            >
              <Download aria-hidden="true" className="size-3.5" />
              <PanelActionLabel>Download</PanelActionLabel>
            </SelectionActionButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => void download("json")}>
              Download JSON
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void download("csv")}>
              Download CSV
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <SelectionActionButton
          variant="outline"
          size="sm"
          disabled={downloading || tooMany}
          onClick={(event) => open("tag", event)}
        >
          <Tag aria-hidden="true" className="size-3.5" />
          <PanelActionLabel>Tag</PanelActionLabel>
        </SelectionActionButton>
        <SelectionActionButton
          variant="outline"
          size="sm"
          disabled={downloading || tooMany}
          onClick={(event) => open("score", event)}
        >
          <Percent aria-hidden="true" className="size-3.5" />
          <PanelActionLabel>Score</PanelActionLabel>
        </SelectionActionButton>
        <SelectionActionButton
          variant="outline"
          size="sm"
          disabled={downloading || tooMany}
          onClick={(event) => open("delete", event)}
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
          <PanelActionLabel>Delete</PanelActionLabel>
        </SelectionActionButton>
        {tooMany && (
          <span className="shrink-0 text-xs text-foreground-muted">
            Select up to 500 traces to run actions.
          </span>
        )}
      </SelectionToolbar>
      <Dialog
        open={!!action && action.kind !== "delete"}
        onOpenChange={(open) => {
          if (!open) setAction(null)
        }}
      >
        {action && action.kind !== "delete" && (
          <SelectionDialog
            key={action.kind}
            kind={action.kind}
            traces={action.traces}
            onCloseAutoFocus={restoreFocus}
            onDone={() => {
              setAction(null)
              onChanged()
            }}
          />
        )}
      </Dialog>
      <AlertDialog
        open={action?.kind === "delete"}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) setAction(null)
        }}
      >
        <AlertDialogContent size="sm" finalFocus={trigger}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {action?.traces.length ?? count} traces?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the selected traces and their spans and
              scores. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteAttempted && deleteMutation.error && (
            <Notice variant="error" role="alert">
              {deleteMutation.error.message}
            </Notice>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel size="sm" disabled={deleteMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="sm"
              loading={deleteMutation.isPending}
              onClick={() => {
                if (!action) return
                setDeleteAttempted(true)
                const ids = action.traces.map((trace) => trace.id)
                void deleteMutation
                  .run(() =>
                    tracerApi.traces.mutateSelection({
                      action: "delete",
                      traceIds: ids,
                    })
                  )
                  .then(() => {
                    setAction(null)
                    onDeleted(ids)
                  })
                  .catch(() => {})
              }}
            >
              Delete traces
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function SelectionDialog({
  kind,
  traces,
  onDone,
  onCloseAutoFocus,
}: {
  kind: "dataset" | "tag" | "score"
  traces: TraceSummary[]
  onDone: () => void
  onCloseAutoFocus: (event: Event) => void
}) {
  const mutation = useMutation()
  const [tag, setTag] = React.useState("")
  const title =
    kind === "dataset"
      ? "Add to dataset"
      : kind === "score"
        ? "Score traces"
        : "Tag traces"
  return (
    <DialogContent
      className={kind === "score" ? "overflow-visible" : undefined}
      onCloseAutoFocus={onCloseAutoFocus}
      showCloseButton={!mutation.isPending}
      onEscapeKeyDown={(event) => {
        if (mutation.isPending) event.preventDefault()
      }}
      onInteractOutside={(event) => event.preventDefault()}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {traces.length} selected {traces.length === 1 ? "trace" : "traces"}.{" "}
          {kind === "dataset"
            ? "Copy their inputs into cases. Keep observed outputs separate from reference answers."
            : kind === "score"
              ? "Choose scorers to run on these recorded traces."
              : "Add a tag while keeping existing tags."}
        </DialogDescription>
      </DialogHeader>
      {kind === "dataset" && (
        <DatasetSelection traces={traces} mutation={mutation} onDone={onDone} />
      )}
      {kind === "score" && (
        <ScorerSelection traces={traces} mutation={mutation} onDone={onDone} />
      )}
      {kind === "tag" && (
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void mutation
              .run(() =>
                tracerApi.traces.mutateSelection({
                  action: "tag",
                  traceIds: traces.map((trace) => trace.id),
                  tags: [tag.trim()],
                })
              )
              .then(onDone)
              .catch(() => {})
          }}
        >
          <label className="grid gap-1.5 text-sm">
            Tag
            <Input
              autoFocus
              value={tag}
              maxLength={200}
              required
              disabled={mutation.isPending}
              placeholder="e.g. needs-review"
              onChange={(event) => setTag(event.target.value)}
            />
          </label>
          <DialogFooter>
            <Button
              size="sm"
              type="submit"
              loading={mutation.isPending}
              disabled={!tag.trim()}
            >
              Add tag
            </Button>
          </DialogFooter>
        </form>
      )}
      {mutation.error && (
        <Notice variant="error" role="alert">
          {mutation.error.message}
        </Notice>
      )}
    </DialogContent>
  )
}

type SelectionFormProps = {
  traces: TraceSummary[]
  mutation: ReturnType<typeof useMutation>
  onDone: () => void
}

function DatasetSelection({ traces, mutation, onDone }: SelectionFormProps) {
  const datasets = useCollectionPages(tracerApi.datasets.list, "", 60_000)
  const [datasetId, setDatasetId] = React.useState<string | null>(null)
  const [copyObservedOutput, setCopyObservedOutput] = React.useState(false)
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!datasetId) return
        void mutation
          .run(async () => {
            const payloads = await loadPayloads(traces)
            await tracerApi.datasets.importItems(
              datasetId,
              payloads.map((trace) => ({
                input: trace.input ?? null,
                expectedOutput: copyObservedOutput ? trace.output ?? null : null,
                sourceTraceId: trace.id,
              }))
            )
          })
          .then(onDone)
          .catch(() => {})
      }}
    >
      {datasets.isLoading && <LoadingState compact label="Loading datasets" />}
      {datasets.error && (
        <ErrorState error={datasets.error} onRetry={datasets.refresh} />
      )}
      {!datasets.isLoading && !datasets.error && !datasets.items.length && (
        <p className="text-sm text-foreground-muted">
          Create a dataset to add these traces.
        </p>
      )}
      <Combobox
        label="Dataset"
        placeholder="Find a dataset"
        options={datasets.items.map((dataset) => ({
          value: dataset.id,
          label: dataset.name,
        }))}
        value={datasetId}
        onValueChange={setDatasetId}
        disabled={mutation.isPending || !datasets.items.length}
      />
      <CollectionPagination {...datasets} />
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={copyObservedOutput} onChange={event => setCopyObservedOutput(event.target.checked)} />Use observed outputs as reviewed reference answers</label>
      <DialogFooter>
        <Button
          size="sm"
          type="submit"
          disabled={!datasetId}
          loading={mutation.isPending}
        >
          Add to dataset
        </Button>
      </DialogFooter>
    </form>
  )
}

function ScorerSelection({ traces, mutation, onDone }: SelectionFormProps) {
  const router = useRouter()
  const href = useWorkspaceHref()
  const [selected, setSelected] = React.useState<string[]>([])
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        void mutation
          .run(() =>
            tracerApi.evals.create({
              mode: "traces",
              background: true,
              traceIds: traces.map((trace) => trace.id),
              evaluatorIds: selected,
              name: `Score ${traces.length} selected traces`,
            })
          )
          .then((run) => {
            onDone()
            router.push(href(`/evals/${run.id}`))
          })
          .catch(() => {})
      }}
    >
      <ScorerPicker value={selected} onValueChange={setSelected} disabled={mutation.isPending}
        traceIds={traces.map(trace => trace.id)} />
      <DialogFooter>
        <Button
          size="sm"
          type="submit"
          loading={mutation.isPending}
          disabled={!selected.length}
        >
          Run scorers
        </Button>
      </DialogFooter>
    </form>
  )
}
