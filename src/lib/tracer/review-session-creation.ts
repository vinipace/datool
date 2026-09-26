import type { TraceSummary } from "./contracts"
import {
  DEFAULT_REVIEW_NAME,
  type CreateReviewSession,
  type ReviewSessionDetail,
  type ReviewSessionTable,
} from "./reviews"

/** Keeps the selected rows visible across navigation while creation is in flight. */
export function createReviewSessionCreation(
  traces: TraceSummary[],
  create: (input: CreateReviewSession) => Promise<ReviewSessionDetail>,
  idempotencyKey = crypto.randomUUID()
) {
  const id = `review_${idempotencyKey}`
  const now = new Date().toISOString()
  let snapshot: {
    data: ReviewSessionTable
    pending: boolean
    error: Error | null
  } = {
    pending: true,
    error: null,
    data: {
      id,
      number: 0,
      name: DEFAULT_REVIEW_NAME,
      prompt: "",
      revision: 1,
      assigneeUserId: null,
      assigneeName: null,
      reviewers: [],
      createdBy: null,
      createdAt: now,
      updatedAt: now,
      collectionId: null,
      collection: null,
      traceCount: traces.length,
      reviewedCount: 0,
      skippedCount: 0,
      status: "pending",
      traces: [...traces],
      scores: [],
      scoreColumns: [],
      items: traces.map((trace, ordinal) => ({
        id: `pending-${ordinal}`,
        sessionId: id,
        traceId: trace.id,
        traceName: trace.name || trace.operation,
        ordinal,
        notes: "",
        revision: 0,
        reviewedAt: null,
        skippedAt: null,
        reviewedBy: null,
      })),
    },
  }
  const listeners = new Set<() => void>()
  let flight: Promise<void> | undefined
  function publish(next: Partial<typeof snapshot>) {
    snapshot = { ...snapshot, ...next }
    listeners.forEach((listener) => listener())
  }
  function save(): Promise<void> {
    if (flight) return flight
    if (snapshot.data.number) return Promise.resolve()
    publish({ pending: true, error: null })
    flight = create({
      idempotencyKey,
      traceIds: traces.map((trace) => trace.id),
    })
      .then((session) =>
        publish({ data: { ...snapshot.data, ...session }, pending: false })
      )
      .catch((reason) =>
        publish({
          pending: false,
          error:
            reason instanceof Error
              ? reason
              : new Error("Could not create the review session."),
        })
      )
      .finally(() => {
        flight = undefined
      })
    return flight
  }
  return {
    id,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    save,
  }
}
