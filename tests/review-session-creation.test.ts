import { expect, test } from "bun:test"
import { createReviewSessionCreation } from "../src/lib/tracer/review-session-creation"
import type {
  CreateReviewSession,
  ReviewSessionDetail,
} from "../src/lib/tracer/reviews"
import { traceRows } from "../.storybook/scenarios/traces/fixtures"

test("creation shows selected traces before the response and shares in-flight attempts", async () => {
  let resolve!: (value: ReviewSessionDetail) => void
  const writes: CreateReviewSession[] = []
  const store = createReviewSessionCreation(traceRows, (input) => {
    writes.push(input)
    return new Promise((done) => {
      resolve = done
    })
  })
  const first = store.save()
  expect(store.save()).toBe(first)
  expect(store.getSnapshot().pending).toBe(true)
  expect(store.getSnapshot().data.traces).toEqual(traceRows)
  expect(store.getSnapshot().data.items.map((item) => item.traceId)).toEqual(
    traceRows.map((trace) => trace.id)
  )
  expect(store.getSnapshot().data.number).toBe(0)
  const saved = { ...store.getSnapshot().data, number: 123 }
  resolve(saved)
  await first
  expect(store.getSnapshot().data.number).toBe(123)
  expect(store.getSnapshot().pending).toBe(false)
  await store.save()
  expect(writes).toHaveLength(1)
})

test("failed creation keeps rows and retries with the same idempotency key", async () => {
  const writes: CreateReviewSession[] = []
  const store = createReviewSessionCreation(traceRows, async (input) => {
    writes.push(input)
    throw new Error("Connection lost")
  })
  await store.save()
  expect(store.getSnapshot().error?.message).toBe("Connection lost")
  expect(store.getSnapshot().data.traces).toEqual(traceRows)
  await store.save()
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual(writes[0])
})
