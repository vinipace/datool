import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import {
  createReviewAutosave,
  type ReviewScoreDraft,
} from "../src/lib/tracer/review-autosave"
import type { RecordReview, ReviewItemDetail } from "../src/lib/tracer/reviews"
import type { ReviewAnnotationInput } from "../src/lib/tracer/review-annotations"

const initial: ReviewItemDetail = {
  id: "item",
  sessionId: "session",
  traceId: "trace",
  traceName: "Trace",
  ordinal: 0,
  notes: "",
  annotations: [],
  revision: 0,
  reviewedAt: null,
  skippedAt: null,
  reviewedBy: null,
  definitions: [],
  scores: [],
  previousItemId: null,
  nextItemId: "next",
}
const score: ReviewScoreDraft = {
  key: "human-quality",
  definition: {
    id: "human-quality",
    name: "Quality",
    description: "",
    type: "numeric",
    min: 0,
    max: 1,
    step: 0.01,
    revision: 1,
    archived: false,
    createdAt: "",
    updatedAt: "",
  },
  value: "0.5",
  comment: "",
}
const response = (input: RecordReview): ReviewItemDetail => ({
  ...initial,
  notes: input.notes ?? initial.notes,
  revision: input.expectedRevision + 1,
})

test("removing a collection criterion replaces only this item's criteria and survives reopening", async () => {
  const writes: RecordReview[] = []
  const required = { ...initial, definitions: [score.definition] }
  const store = createReviewAutosave({
    initial: required,
    save: async input => {
      writes.push(input)
      return { ...required, definitions: [], revision: input.expectedRevision + 1 }
    },
  })
  store.update(() => [])
  await store.flush()
  expect(writes).toEqual([{ expectedRevision: 0, scores: [], replaceCriteria: true }])
  const reopened = createReviewAutosave({ initial: store.getSnapshot().saved, save: async () => required })
  expect(reopened.getSnapshot().drafts).toEqual([])
  expect(required.definitions).toEqual([score.definition])
})

test("annotation autosave serializes deletion during a save without overwriting notes or scores", async () => {
  const writes: RecordReview[] = []
  let resolveFirst!: (value: ReviewItemDetail) => void
  const store = createReviewAutosave({ initial, save: async (input) => {
    writes.push(input)
    if (writes.length === 1) return new Promise((resolve) => { resolveFirst = resolve })
    return response(input)
  } })
  const entry: ReviewAnnotationInput = {
    id: crypto.randomUUID(), comment: "Unsupported claim",
    reference: { traceId: "trace", spanId: "span", spanName: "Reply", field: "output", view: "text",
      outputHash: "a".repeat(64), start: 0, end: 4, exact: "Rain", prefix: "", suffix: "" },
  }
  store.updateAnnotations(() => [entry])
  const flight = store.flush()
  store.updateAnnotations(() => [])
  store.updateNotes("General note")
  resolveFirst(response(writes[0]))
  await flight
  expect(writes[0]).toEqual({ expectedRevision: 0, annotations: [entry] })
  expect(writes[1]).toEqual({ expectedRevision: 1, notes: "General note", annotations: [] })
  expect(store.getSnapshot().annotations).toEqual([])
  expect(store.getSnapshot().status).toBe("saved")
})

test("review autosave debounces edits and saves without a button", async () => {
  const writes: RecordReview[] = []
  const store = createReviewAutosave({
    initial,
    delay: 5,
    save: async (input) => {
      writes.push(input)
      return response(input)
    },
  })
  store.update(() => [score])
  store.update((drafts) =>
    drafts.map((draft) => ({ ...draft, value: "0.8", comment: "Clear" }))
  )
  await new Promise((resolve) => setTimeout(resolve, 25))
  expect(writes).toEqual([
    {
      expectedRevision: 0,
      scores: [
        {
          humanScoreId: "human-quality",
          humanScoreRevision: 1,
          value: 0.8,
          comment: "Clear",
        },
      ],
    },
  ])
  expect(store.getSnapshot().status).toBe("saved")
  expect(store.pending()).toBe(false)
})

test("edits during a save are serialized against the returned revision, even after navigating away", async () => {
  const writes: RecordReview[] = []
  let resolveFirst!: (value: ReviewItemDetail) => void
  const store = createReviewAutosave({
    initial,
    delay: 1000,
    save: async (input) => {
      writes.push(input)
      if (writes.length === 1)
        return new Promise((resolve) => {
          resolveFirst = resolve
        })
      return response(input)
    },
  })
  const unsubscribe = store.subscribe(() => {})
  store.update(() => [score])
  const flight = store.flush()
  store.update((drafts) =>
    drafts.map((draft) => ({ ...draft, comment: "Latest comment" }))
  )
  unsubscribe()
  expect(store.flush()).toBe(flight)
  expect(writes).toHaveLength(1)
  resolveFirst(response(writes[0]))
  await flight
  expect(writes.map((write) => write.expectedRevision)).toEqual([0, 1])
  expect(writes[1].scores?.[0].comment).toBe("Latest comment")
  expect(store.getSnapshot().drafts[0].comment).toBe("Latest comment")
  expect(store.getSnapshot().saved.revision).toBe(2)
})

test("reverting while a write is in flight saves the latest empty selection afterward", async () => {
  const writes: RecordReview[] = []
  let resolveFirst!: (value: ReviewItemDetail) => void
  const store = createReviewAutosave({
    initial,
    save: async (input) => {
      writes.push(input)
      if (writes.length === 1)
        return new Promise((resolve) => {
          resolveFirst = resolve
        })
      return response(input)
    },
  })
  store.update(() => [score])
  const flight = store.flush()
  store.update(() => [])
  expect(store.pending()).toBe(true)
  resolveFirst(response(writes[0]))
  await flight
  expect(writes[1]).toEqual({ expectedRevision: 1, scores: [] })
  expect(store.pending()).toBe(false)
})

test("incomplete or invalid values remain drafts and never become zero or overwrite saved scores", async () => {
  const writes: RecordReview[] = []
  const store = createReviewAutosave({
    initial,
    save: async (input) => {
      writes.push(input)
      return response(input)
    },
  })
  for (const value of ["2", "-1", "NaN"]) {
    store.update(() => [{ ...score, value, comment: "Keep this note" }])
    await store.flush()
    expect(store.getSnapshot().status).toBe("incomplete")
    expect(store.pending()).toBe(true)
  }
  expect(writes).toHaveLength(0)
  store.update((drafts) => drafts.map((draft) => ({ ...draft, value: "0" })))
  await store.flush()
  expect(writes[0].scores?.[0]).toEqual({
    humanScoreId: "human-quality",
    humanScoreRevision: 1,
    value: 0,
    comment: "Keep this note",
  })
})

test("failed saves retain newer drafts and retry without advancing the server revision", async () => {
  const writes: RecordReview[] = []
  const store = createReviewAutosave({
    initial,
    save: async (input) => {
      writes.push(input)
      if (writes.length === 1) throw new Error("Conflict")
      return response(input)
    },
  })
  store.update(() => [score])
  await assert.rejects(store.flush(), /Conflict/)
  store.update((drafts) => drafts.map((draft) => ({ ...draft, value: "1" })))
  expect(store.getSnapshot().status).toBe("error")
  expect(writes).toHaveLength(1)
  await store.flush()
  expect(writes[1]).toEqual({
    expectedRevision: 0,
    scores: [
      {
        humanScoreId: "human-quality",
        humanScoreRevision: 1,
        value: 1,
        comment: "",
      },
    ],
  })
  expect(store.pending()).toBe(false)
})

test("notes autosave while an incomplete scorer stays a draft", async () => {
  const writes: RecordReview[] = []
  const store = createReviewAutosave({
    initial,
    delay: 5,
    save: async (input) => {
      writes.push(input)
      return response(input)
    },
  })
  store.update(() => [{ ...score, value: "2" }])
  store.updateNotes("First observation\nSecond observation")
  await new Promise((resolve) => setTimeout(resolve, 25))
  expect(writes).toEqual([
    { expectedRevision: 0, notes: "First observation\nSecond observation" },
  ])
  expect(store.getSnapshot().saved.notes).toBe(
    "First observation\nSecond observation"
  )
  expect(store.getSnapshot().status).toBe("incomplete")
  expect(store.getSnapshot().drafts[0].value).toBe("2")
  store.update(() => [score])
  await store.flush()
  expect(writes[1]).toEqual({
    expectedRevision: 1,
    scores: [
      {
        humanScoreId: "human-quality",
        humanScoreRevision: 1,
        value: 0.5,
        comment: "",
      },
    ],
  })
  expect(store.getSnapshot().notes).toBe(
    "First observation\nSecond observation"
  )
  expect(store.pending()).toBe(false)
})

test("notes edited during an in-flight save use the next revision and can be cleared", async () => {
  const writes: RecordReview[] = []
  let resolveFirst!: (value: ReviewItemDetail) => void
  const store = createReviewAutosave({
    initial,
    save: async (input) => {
      writes.push(input)
      if (writes.length === 1)
        return new Promise((resolve) => {
          resolveFirst = resolve
        })
      return response(input)
    },
  })
  store.updateNotes("Initial observation")
  const flight = store.flush()
  store.updateNotes("Latest observation")
  resolveFirst(response(writes[0]))
  await flight
  expect(writes).toEqual([
    { expectedRevision: 0, notes: "Initial observation" },
    { expectedRevision: 1, notes: "Latest observation" },
  ])
  expect(store.getSnapshot().notes).toBe("Latest observation")
  store.updateNotes("")
  await store.flush()
  expect(writes[2]).toEqual({ expectedRevision: 2, notes: "" })
  expect(store.pending()).toBe(false)
})

test("attached unanswered scores do not become zero and their comments persist as drafts", async () => {
  const writes: RecordReview[] = []
  const store = createReviewAutosave({
    initial: { ...initial, definitions: [score.definition] },
    save: async (input) => {
      writes.push(input)
      return response(input)
    },
  })
  expect(store.pending()).toBe(false)
  expect(store.valid()).toBe(false)
  store.update((drafts) =>
    drafts.map((draft) => ({ ...draft, comment: "Need more context" }))
  )
  await store.flush()
  expect(writes[0].scores?.[0]).toEqual({
    humanScoreId: "human-quality",
    humanScoreRevision: 1,
    value: null,
    comment: "Need more context",
  })
  expect(store.pending()).toBe(false)
  expect(store.valid()).toBe(false)
})
