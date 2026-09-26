"use client"

import * as React from "react"
import { Layers, RotateCcw, SkipForward, Trash2 } from "lucide-react"
import { Combobox } from "@/components/ui/combobox"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import { toast } from "@/components/ui/toast"
import { PanelActionLabel } from "@/components/ui/panel-action-label"
import {
  SelectionToolbar,
  SelectionActionButton,
} from "@/components/ui/selection-toolbar"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog"
import type {
  ReviewSessionDetail,
  ReviewSelection,
} from "@/src/lib/tracer/reviews"
import { tracerApi } from "./api"
import { useMutation, useRemote } from "./hooks"
import { ReviewerCombobox } from "@/components/ui/reviewer-combobox"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Button } from "@/components/ui/button"

export function ReviewSessionCollection({
  session,
  disabled,
  prepare,
  onChange,
  onSaved,
  onError,
  onPendingChange,
}: {
  session: ReviewSessionDetail
  disabled?: boolean
  prepare: () => Promise<void>
  onChange: (session: ReviewSessionDetail) => void
  onSaved: () => void
  onError: () => void
  onPendingChange: (pending: boolean) => void
}) {
  const library = useRemote(tracerApi.humanScores.library, [])
  const [pending, setPending] = React.useState(false)
  const busy = React.useRef(false)
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Combobox
        label="Human Score collection"
        icon={<Layers />}
        variant="toolbar"
        className="max-w-64"
        value={session.collectionId ?? ""}
        disabled={disabled || pending || !library.data}
        options={[
          { value: "", label: "No collection" },
          ...(library.data?.collections ?? []).map((collection) => ({
            value: collection.id,
            label: collection.name,
            description: `${collection.scoreIds.length} Human Scores`,
          })),
          ...(session.collection &&
          !library.data?.collections.some(
            (collection) => collection.id === session.collectionId
          )
            ? [{ value: session.collection.id, label: session.collection.name }]
            : []),
        ]}
        onValueChange={(id) => {
          if (
            busy.current ||
            (id || null) === session.collectionId ||
            !library.data
          )
            return
          const previous = session
          const collection = library.data.collections.find(
            (collection) => collection.id === id
          )
          const scores =
            collection?.scoreIds.flatMap((scoreId) =>
              library.data!.scores.filter((score) => score.id === scoreId)
            ) ?? []
          if (collection && scores.length !== collection.scoreIds.length) {
            toast.add({
              title: "This collection includes unavailable Human Scores",
              description:
                "Update the collection in the Human Score library before attaching it.",
              type: "error",
            })
            return
          }
          const snapshot = collection ? { ...collection, scores } : null
          busy.current = true
          setPending(true)
          onPendingChange(true)
          onChange({
            ...session,
            collectionId: id || null,
            collection: snapshot,
          })
          void prepare()
            .then(() =>
              tracerApi.reviews.update(session.id, {
                expectedRevision: session.revision,
                collectionId: id || null,
              })
            )
            .then((next) => {
              onChange(next)
              onSaved()
            })
            .catch((error) => {
              onChange(previous)
              onError()
              toast.add({
                title: "Couldn’t update collection",
                description:
                  error instanceof Error ? error.message : "Try again.",
                type: "error",
              })
            })
            .finally(() => {
              busy.current = false
              setPending(false)
              onPendingChange(false)
            })
        }}
      />
      {library.error && (
        <Button size="sm" variant="outline" onClick={library.refresh}>
          Retry collections
        </Button>
      )}
    </div>
  )
}

export function ReviewSessionReviewers({
  session,
  onSaved,
  disabled,
}: {
  session: ReviewSessionDetail
  onSaved: () => void
  disabled?: boolean
}) {
  const options = useRemote(tracerApi.reviews.options, [])
  const mutation = useMutation()
  const [saved, setSaved] = React.useState(session)
  const busy = React.useRef(false)
  const current = saved.revision > session.revision ? saved : session
  const reviewers = [
    ...(options.data?.members ?? []),
    ...current.reviewers.filter(
      (reviewer) =>
        !options.data?.members.some((member) => member.id === reviewer.id)
    ),
  ]
  if (options.error)
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" variant="outline">
            Reviewers
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="space-y-2">
          <Notice variant="error">{options.error.message}</Notice>
          <Button size="sm" onClick={options.refresh}>
            Retry
          </Button>
        </PopoverContent>
      </Popover>
    )
  return (
    <ReviewerCombobox
      reviewers={reviewers}
      value={current.reviewers.map((reviewer) => reviewer.id)}
      disabled={disabled || options.isLoading || mutation.isPending}
      onValueChange={(ids) => {
        if (busy.current) return
        busy.current = true
        void mutation
          .run(() =>
            tracerApi.reviews.update(session.id, {
              expectedRevision: current.revision,
              reviewerUserIds: ids,
            })
          )
          .then((next) => {
            setSaved(next)
            onSaved()
          })
          .catch((error) =>
            toast.add({
              title: "Couldn’t update reviewers",
              description:
                error instanceof Error ? error.message : "Try again.",
              type: "error",
            })
          )
          .finally(() => {
            busy.current = false
          })
      }}
    />
  )
}

export function ReviewSessionTitle({
  session,
  onSaved,
  disabled,
}: {
  session: ReviewSessionDetail
  onSaved: () => void
  disabled?: boolean
}) {
  const [name, setName] = React.useState(session.name)
  const [failedName, setFailedName] = React.useState<string | null>(null)
  const cancelled = React.useRef(false)
  const saving = React.useRef(false)
  const mutation = useMutation()
  async function save() {
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    if (saving.current) return
    const trimmed = name.trim()
    if (!trimmed || trimmed === session.name) {
      setName(session.name)
      setFailedName(null)
      return
    }
    saving.current = true
    try {
      await mutation.run(() =>
        tracerApi.reviews.update(session.id, {
          name: trimmed,
          expectedRevision: session.revision,
        })
      )
      onSaved()
    } catch {
      setFailedName(trimmed)
    } finally {
      saving.current = false
    }
  }
  return (
    <div className="min-w-0">
      <Input
        variant="title"
        aria-label="Review name"
        maxLength={200}
        value={name}
        disabled={disabled || mutation.isPending}
        invalid={!!mutation.error && failedName === name.trim()}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === "Enter") {
            event.preventDefault()
            event.currentTarget.blur()
          }
          if (event.key === "Escape") {
            event.preventDefault()
            cancelled.current = true
            setName(session.name)
            setFailedName(null)
            event.currentTarget.blur()
          }
        }}
      />
      {mutation.error && failedName === name.trim() && (
        <Notice variant="error">{mutation.error.message}</Notice>
      )}
    </div>
  )
}

export function ReviewSelectionActions({
  session,
  checkedIds,
  onClear,
  onChanged,
  disabled,
  prepareItems,
}: {
  session: ReviewSessionDetail
  checkedIds: Set<string>
  onClear: () => void
  onChanged: (session: ReviewSessionDetail) => void
  disabled?: boolean
  prepareItems: () => Promise<ReviewSelection["items"]>
}) {
  const selected = session.items.filter((item) => checkedIds.has(item.traceId))
  const [confirming, setConfirming] = React.useState(false)
  const mutation = useMutation()
  async function apply(action: ReviewSelection["action"]) {
    try {
      const next = await mutation.run(async () =>
        tracerApi.reviews.mutateSelection(session.id, {
          action,
          expectedRevision: session.revision,
          items: await prepareItems(),
        })
      )
      setConfirming(false)
      onChanged(next)
      toast.add({
        title:
          action === "remove"
            ? "Removed from review session"
            : action === "skip"
              ? "Traces skipped"
              : "Traces restored",
        type: "success",
      })
    } catch (error) {
      if (action !== "remove")
        toast.add({
          title: "Couldn’t update selection",
          description: error instanceof Error ? error.message : "Try again.",
          type: "error",
        })
    }
  }
  const busy = disabled || mutation.isPending
  return (
    <>
      <SelectionToolbar
        count={selected.length}
        label="Selected review actions"
        onClear={onClear}
      >
        <SelectionActionButton
          disabled={busy || selected.every((item) => !!item.skippedAt)}
          onClick={() => void apply("skip")}
        >
          <SkipForward />
          <PanelActionLabel>Skip</PanelActionLabel>
        </SelectionActionButton>
        {selected.some((item) => item.skippedAt) && (
          <SelectionActionButton
            disabled={busy}
            onClick={() => void apply("restore")}
          >
            <RotateCcw />
            <PanelActionLabel>Restore</PanelActionLabel>
          </SelectionActionButton>
        )}
        <SelectionActionButton
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          <Trash2 />
          <PanelActionLabel>Remove</PanelActionLabel>
        </SelectionActionButton>
      </SelectionToolbar>
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!mutation.isPending) setConfirming(open)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {selected.length}{" "}
              {selected.length === 1 ? "trace" : "traces"} from this session?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The selected items and their ratings and notes in this review
              session will be removed. The original traces will be kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {mutation.error && (
            <Notice variant="error">{mutation.error.message}</Notice>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel size="sm" disabled={mutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              variant="destructive"
              loading={mutation.isPending}
              onClick={() => void apply("remove")}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
