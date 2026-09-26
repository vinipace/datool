import type { RecordReview, ReviewItemDetail } from "./reviews"
import type { ReviewAnnotationInput } from "./review-annotations"
import {
  isHumanScoreValue,
  type HumanScore,
  type HumanScoreValue,
} from "./human-scores"

export type ReviewScoreDraft = {
  key: string
  definition: HumanScore
  value: string | string[]
  comment: string
}
export function emptyReviewDraft(definition: HumanScore): ReviewScoreDraft {
  return {
    key: definition.id,
    definition,
    value: definition.type === "categorical" && definition.multiple ? [] : "",
    comment: "",
  }
}
export function reviewDrafts(item: ReviewItemDetail): ReviewScoreDraft[] {
  const definitions = new Map(
    item.definitions.map((definition) => [definition.id, definition])
  )
  for (const score of item.scores)
    if (!definitions.has(score.humanScoreId))
      definitions.set(score.humanScoreId, score.definition)
  return [...definitions.values()].map((definition) => {
    const saved = item.scores.find(
      (score) => score.humanScoreId === definition.id
    )
    return saved
      ? {
          ...emptyReviewDraft(definition),
          value:
            saved.value === null
              ? emptyReviewDraft(definition).value
              : Array.isArray(saved.value)
                ? saved.value
                : String(saved.value),
          comment: saved.comment,
        }
      : emptyReviewDraft(definition)
  })
}
function draftValue(draft: ReviewScoreDraft): HumanScoreValue | null {
  if (
    Array.isArray(draft.value)
      ? draft.value.length === 0
      : draft.value.trim() === ""
  )
    return null
  return draft.definition.type === "numeric" ? Number(draft.value) : draft.value
}
function scoresInput(
  drafts: ReviewScoreDraft[]
): NonNullable<RecordReview["scores"]> | null {
  if (
    drafts.some(
      (draft) =>
        draftValue(draft) !== null &&
        !isHumanScoreValue(draft.definition, draftValue(draft))
    )
  )
    return null
  return drafts.map((draft) => ({
    humanScoreId: draft.definition.id,
    humanScoreRevision: draft.definition.revision,
    value: draftValue(draft),
    comment: draft.comment,
  }))
}

/** One queue per trace keeps edits and server revisions intact across player navigation. */
export function createReviewAutosave({
  initial,
  save,
  onError,
  delay = 350,
}: {
  initial: ReviewItemDetail
  save: (input: RecordReview) => Promise<ReviewItemDetail>
  onError?: (error: Error) => void
  delay?: number
}) {
  let savedDrafts = reviewDrafts(initial)
  let savedNotes = initial.notes
  let savedAnnotations: ReviewAnnotationInput[] = (initial.annotations ?? []).map(({ id, reference, comment }) => ({ id, reference, comment }))
  let snapshot = {
    drafts: savedDrafts,
    notes: savedNotes,
    annotations: savedAnnotations,
    saved: initial,
    status: "saved" as "saved" | "saving" | "incomplete" | "error",
    error: null as Error | null,
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let flight: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const scoresChanged = () =>
    JSON.stringify(snapshot.drafts) !== JSON.stringify(savedDrafts)
  const notesChanged = () => snapshot.notes !== savedNotes
  const annotationsChanged = () => JSON.stringify(snapshot.annotations) !== JSON.stringify(savedAnnotations)
  const changed = () => scoresChanged() || notesChanged() || annotationsChanged()
  const pending = () => Boolean(flight) || changed()
  function publish(next: Partial<typeof snapshot>) {
    snapshot = { ...snapshot, ...next }
    listeners.forEach((listener) => listener())
  }
  async function drain() {
    while (changed()) {
      const drafts = snapshot.drafts
      const notes = snapshot.notes
      const scores = scoresChanged() ? scoresInput(drafts) : null
      const saveNotes = notesChanged()
      const annotations = snapshot.annotations
      const saveAnnotations = annotationsChanged()
      if (!scores && !saveNotes && !saveAnnotations) {
        publish({ status: "incomplete", error: null })
        return
      }
      publish({ status: "saving", error: null })
      try {
        const saved = await save({
          expectedRevision: snapshot.saved.revision,
          ...(scores ? { scores } : {}),
          ...(saveNotes ? { notes } : {}),
          ...(saveAnnotations ? { annotations } : {}),
        })
        if (scores) savedDrafts = drafts
        if (saveNotes) savedNotes = notes
        if (saveAnnotations) savedAnnotations = annotations
        publish({ saved })
      } catch (cause) {
        const error =
          cause instanceof Error ? cause : new Error("Unable to save review.")
        publish({ status: "error", error })
        onError?.(error)
        throw error
      }
    }
    clearTimeout(timer)
    publish({ status: "saved", error: null })
  }
  function flush(): Promise<void> {
    clearTimeout(timer)
    if (flight) return flight
    flight = drain().finally(() => {
      flight = undefined
    })
    return flight
  }
  function schedule() {
    clearTimeout(timer)
    // Conflicts retain local edits until the reviewer retries or reloads.
    if (snapshot.error) return
    const canSave =
      notesChanged() || annotationsChanged() ||
      (scoresChanged() && scoresInput(snapshot.drafts) !== null)
    publish({
      status: flight || canSave ? "saving" : changed() ? "incomplete" : "saved",
    })
    if (canSave)
      timer = setTimeout(() => {
        void flush().catch(() => {})
      }, delay)
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    update(update: (drafts: ReviewScoreDraft[]) => ReviewScoreDraft[]) {
      const drafts = update(snapshot.drafts)
      if (JSON.stringify(drafts) === JSON.stringify(snapshot.drafts)) return
      publish({ drafts })
      schedule()
    },
    updateNotes(notes: string) {
      if (notes === snapshot.notes) return
      publish({ notes })
      schedule()
    },
    updateAnnotations(update: (entries: ReviewAnnotationInput[]) => ReviewAnnotationInput[]) {
      const annotations = update(snapshot.annotations)
      if (JSON.stringify(annotations) === JSON.stringify(snapshot.annotations)) return
      publish({ annotations })
      schedule()
    },
    valid: () =>
      snapshot.drafts.length > 0 &&
      snapshot.drafts.every((draft) =>
        isHumanScoreValue(draft.definition, draftValue(draft))
      ),
    pending,
    flush,
  }
}

export type ReviewAutosave = ReturnType<typeof createReviewAutosave>
