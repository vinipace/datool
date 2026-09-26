"use client"

import { reviewAttribution } from "@/src/lib/tracer/review-provenance"

import * as React from "react"
import { Copy, MessageSquare, Trash2 } from "lucide-react"
import { useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { StructuredValueViewer } from "@/components/ui/structured-value-viewer"
import { TextAnnotation } from "@/components/ui/text-annotation"
import { UserAvatarImage } from "@/components/ui/user-avatar"
import { toast } from "@/components/ui/toast"
import type { JsonValue } from "@/src/lib/tracer/contracts"
import {
  outputHash,
  annotationFieldLabel,
  customFieldValue,
  type AnnotationReference,
  type ReviewAnnotation,
  type ReviewAnnotationInput,
} from "@/src/lib/tracer/review-annotations"
import type { ValueView } from "@/src/lib/tracer/value-views"
import { valueViewLabels } from "@/src/lib/tracer/value-views"

import {
  ReviewAnnotationContext as Context,
  useReviewAnnotations,
  type AnnotationContext,
  type AnnotationFocus as Focus,
} from "./review-annotation-context"

export function ReviewAnnotationsProvider({
  children,
  annotations,
  disabled,
}: React.PropsWithChildren<{
  annotations: ReviewAnnotationInput[]
  disabled: boolean
}>) {
  const params = useSearchParams()
  const linked = annotations.find(
    (annotation) => annotation.id === params.get("annotation")
  )
  const [focus, setFocus] = React.useState<Focus | null>(() =>
    linked ? { ...linked, nonce: 0 } : null
  )
  const [draft, setDraft] = React.useState<AnnotationReference | null>(null)
  const value = React.useMemo(
    () => ({ annotations, disabled, focus, setFocus, draft, setDraft }),
    [annotations, disabled, focus, draft]
  )
  return <Context.Provider value={value}>{children}</Context.Provider>
}

type AnnotationTarget = {
  traceId: string
  spanId: string | null
  spanName: string
  field: AnnotationReference["field"]
  customField?: AnnotationReference["customField"]
}

export function AnnotatableValue({
  value,
  target,
  renderValue,
}: {
  value: JsonValue
  target: AnnotationTarget
  renderValue?: (view: ValueView) => React.ReactNode
}) {
  const context = useReviewAnnotations()
  const label =
    target.field === "custom"
      ? target.customField!.name
      : target.field === "input"
        ? "Input"
        : "Output"
  if (!context) return <StructuredValueViewer value={value} label={label} />
  return (
    <ReviewValue
      key={`${target.spanId}:${target.field}:${target.customField?.id}:${context.focus?.nonce ?? "initial"}`}
      value={value}
      target={target}
      label={label}
      context={context}
      renderValue={renderValue}
    />
  )
}

function ReviewValue({
  value,
  target,
  label,
  context,
  renderValue,
}: {
  value: JsonValue
  target: AnnotationTarget
  label: string
  context: AnnotationContext
  renderValue?: (view: ValueView) => React.ReactNode
}) {
  const captured = JSON.stringify(
    target.customField
      ? customFieldValue(target.customField, target.customField.value)
      : value
  )
  const [fingerprint, setFingerprint] = React.useState<{
    captured: string
    hash: string
  } | null>(null)
  React.useEffect(() => {
    let cancelled = false
    void outputHash(JSON.parse(captured)).then((hash) => {
      if (!cancelled) setFingerprint({ captured, hash })
    })
    return () => {
      cancelled = true
    }
  }, [captured])
  const hash = fingerprint?.captured === captured ? fingerprint.hash : null
  const sameField = (reference: AnnotationReference) =>
    reference.traceId === target.traceId &&
    reference.spanId === target.spanId &&
    reference.field === target.field &&
    reference.customField?.id === target.customField?.id
  const focus = context.focus?.reference
  const targetFocus = focus && sameField(focus) ? focus : undefined
  const sameVersion = (reference: AnnotationReference) =>
    reference.outputHash === hash &&
    reference.customField?.sourceHash === target.customField?.sourceHash
  function annotate(view: ValueView, children: React.ReactNode) {
    const matching = (reference: AnnotationReference) =>
      sameField(reference) && reference.view === view && sameVersion(reference)
    return (
      <TextAnnotation
        disabled={
          context.disabled || !hash || context.annotations.length >= 100
        }
        anchors={context.annotations
          .map((entry) => entry.reference)
          .filter(matching)}
        active={
          context.draft && matching(context.draft)
            ? context.draft
            : targetFocus && matching(targetFocus)
              ? targetFocus
              : undefined
        }
        onAnnotate={(anchor) => {
          if (hash)
            context.setDraft({ ...anchor, ...target, outputHash: hash, view })
        }}
      >
        {children}
      </TextAnnotation>
    )
  }
  const customView =
    target.customField?.format === "markdown" ? "pretty" : "text"
  return (
    <div
      data-annotation-field={target.field}
      data-custom-field-id={target.customField?.id}
    >
      {targetFocus && hash && !sameVersion(targetFocus) && (
        <p role="status" className="text-xs text-foreground-muted">
          This field has changed since the annotation. The original quote is
          preserved in the comment.
        </p>
      )}
      {renderValue ? (
        annotate(customView, renderValue(customView))
      ) : (
        <StructuredValueViewer
          value={value}
          label={label}
          initialView={targetFocus?.view}
          renderContent={annotate}
        />
      )}
    </div>
  )
}

export function ReviewAnnotationComments({
  saved,
  onChange,
}: {
  saved: ReviewAnnotation[]
  onChange: (
    update: (annotations: ReviewAnnotationInput[]) => ReviewAnnotationInput[]
  ) => void
}) {
  const context = useReviewAnnotations()!
  const [comment, setComment] = React.useState("")
  const input = React.useRef<HTMLTextAreaElement>(null)
  const activeComment = React.useRef<HTMLElement>(null)
  React.useEffect(() => {
    if (context.focus)
      activeComment.current?.scrollIntoView({ block: "nearest" })
  }, [context.focus])
  React.useEffect(() => {
    if (context.draft) {
      input.current?.focus({ preventScroll: true })
      input.current?.scrollIntoView({ block: "center", behavior: "smooth" })
    }
  }, [context.draft])
  if (!context.draft && !context.annotations.length) return null
  return (
    <section aria-label="Review annotations" className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <MessageSquare className="size-4 text-foreground-muted" /> Comments
      </h3>
      {context.draft && (
        <div
          role="group"
          aria-label="New annotation comment"
          className="space-y-3 rounded-lg border border-border bg-muted p-3"
        >
          <ReferenceQuote reference={context.draft} />
          <Textarea
            ref={input}
            aria-label="Annotation comment"
            placeholder="Comment on this passage…"
            autoSize
            rows={2}
            maxLength={4000}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                context.setDraft(null)
                setComment("")
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={
                context.disabled ||
                !comment.trim() ||
                context.annotations.length >= 100
              }
              onClick={() => {
                const entry = {
                  id: crypto.randomUUID(),
                  reference: context.draft!,
                  comment: comment.trim(),
                }
                onChange((annotations) => [...annotations, entry])
                context.setDraft(null)
                context.setFocus({ ...entry, nonce: Date.now() })
                setComment("")
              }}
            >
              Add comment
            </Button>
          </div>
        </div>
      )}
      {context.annotations.map((annotation, index) => {
        const persisted = saved?.find((entry) => entry.id === annotation.id)
        return (
          <article
            key={annotation.id}
            ref={
              annotation.id === context.focus?.id ? activeComment : undefined
            }
            aria-label={`Annotation comment ${index + 1}`}
            className="space-y-2 rounded-lg border border-border bg-muted p-3"
          >
            <div className="flex items-center gap-2 text-xs text-foreground-muted">
              {persisted ? (
                <>
                  <span aria-hidden="true">
                    <UserAvatarImage {...persisted.author} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {reviewAttribution(persisted.provenance)}{!persisted.provenance?.principal && ` · ${persisted.author.name}`}{persisted.updatedBy && reviewAttribution(persisted.updatedBy) !== reviewAttribution(persisted.provenance) ? ` · Last edit: ${reviewAttribution(persisted.updatedBy)}` : ""}
                  </span>
                </>
              ) : (
                <span className="flex-1">Unsaved comment</span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Copy link to annotation comment ${index + 1}`}
                onClick={async () => {
                  const url = new URL(window.location.href)
                  url.searchParams.set("annotation", annotation.id)
                  try {
                    await navigator.clipboard.writeText(url.toString())
                    toast.add({
                      title: "Annotation link copied",
                      type: "success",
                    })
                  } catch {
                    toast.add({
                      title: "Couldn’t copy annotation link",
                      type: "error",
                    })
                  }
                }}
              >
                <Copy />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete annotation comment ${index + 1}`}
                disabled={context.disabled}
                onClick={() => {
                  onChange((entries) =>
                    entries.filter((entry) => entry.id !== annotation.id)
                  )
                  if (context.focus?.id === annotation.id)
                    context.setFocus(null)
                }}
              >
                <Trash2 />
              </Button>
            </div>
            <button
              type="button"
              aria-label={`View annotation reference ${index + 1}`}
              className="block w-full rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() =>
                context.setFocus({ ...annotation, nonce: Date.now() })
              }
            >
              <ReferenceQuote reference={annotation.reference} />
            </button>
            <p className="text-sm break-words whitespace-pre-wrap">
              {annotation.comment}
            </p>
          </article>
        )
      })}
    </section>
  )
}

function ReferenceQuote({ reference }: { reference: AnnotationReference }) {
  return (
    <div className="min-w-0 space-y-1">
      <p
        className="truncate text-xs text-foreground-muted"
        title={`Trace ${reference.traceId}${reference.spanId ? ` · Span ${reference.spanId}` : ""}`}
      >
        {reference.spanName} · {annotationFieldLabel(reference)} ·{" "}
        {valueViewLabels[reference.view]}
      </p>
      <blockquote className="line-clamp-4 border-l-2 border-selection-control pl-2 text-sm break-words whitespace-pre-wrap text-foreground-muted">
        {reference.exact}
      </blockquote>
    </div>
  )
}
