import { afterEach, expect, test } from "bun:test"
import assert from "node:assert/strict"
import { eq } from "drizzle-orm"
import { traceSelectionMutationSchema } from "@/src/lib/tracer/trace-selection"
import {
  createTracerFixture,
  closeTracerFixture,
  scopeRows,
} from "./helpers/tracer-fixture"
import {
  registerTracerProjectId,
  type TracerDatabase,
} from "@/src/server/tracer/db"
import { runTracerEffect } from "@/src/server/tracer/effect"
import { mutateTraceSelection } from "@/src/server/tracer/trace-selection"
import {
  traces,
  spans,
  datasets,
  datasetItems,
  evalRuns,
  evalRunTargets,
  reviewSessions,
  reviewItems,
} from "@/src/server/tracer/schema"

let database: TracerDatabase | undefined
afterEach(async () => {
  if (database) await closeTracerFixture(database)
  database = undefined
})

async function setup() {
  database = await createTracerFixture()
  const timestamp = new Date().toISOString()
  await database.insert(traces).values(
    scopeRows(database, [
      {
        id: "trace-a",
        name: "A",
        operation: "test",
        status: "completed",
        startedAt: timestamp,
        attributesJson: JSON.stringify({
          tags: ["existing", 7],
          unrelated: { preserved: true },
        }),
      },
      {
        id: "trace-b",
        name: "B",
        operation: "test",
        status: "completed",
        startedAt: timestamp,
        attributesJson: JSON.stringify({ tags: "legacy", model: "test" }),
      },
    ])
  )
  return { db: database, timestamp }
}

test("rejects empty, duplicate, oversized and malformed selections", () => {
  for (const traceIds of [
    [],
    ["a", "a"],
    ["a/b"],
    Array.from({ length: 501 }, (_, index) => `trace-${index}`),
  ]) {
    expect(
      traceSelectionMutationSchema.safeParse({ action: "delete", traceIds })
        .success
    ).toBe(false)
  }
  expect(
    traceSelectionMutationSchema.safeParse({
      action: "tag",
      traceIds: ["a"],
      tags: [" "],
    }).success
  ).toBe(false)
})

test("bulk tagging preserves metadata and tags and is idempotent", async () => {
  const { db } = await setup()
  const input = {
    action: "tag",
    traceIds: ["trace-a", "trace-b"],
    tags: ["new", "new", "existing"],
  }
  await runTracerEffect(mutateTraceSelection(db, input))
  await runTracerEffect(mutateTraceSelection(db, input))
  const rows = await db.select().from(traces).orderBy(traces.id)
  expect(JSON.parse(rows[0].attributesJson)).toEqual({
    tags: ["existing", 7, "new"],
    unrelated: { preserved: true },
  })
  expect(JSON.parse(rows[1].attributesJson)).toEqual({
    tags: ["legacy", "new", "existing"],
    model: "test",
  })
})

test("a missing trace rolls back the entire tag or delete selection", async () => {
  const { db } = await setup()
  for (const input of [
    { action: "tag", traceIds: ["trace-a", "missing"], tags: ["new"] },
    { action: "delete", traceIds: ["trace-a", "missing"] },
  ])
    await assert.rejects(
      runTracerEffect(mutateTraceSelection(db, input)),
      /no longer available/
    )
  expect((await db.select().from(traces)).length).toBe(2)
  expect(
    JSON.parse(
      (await db.select().from(traces).where(eq(traces.id, "trace-a")))[0]
        .attributesJson
    ).tags
  ).toEqual(["existing", 7])
})

test("another project cannot mutate selected traces", async () => {
  const { db } = await setup()
  // Retain the fixture schema and deliberately change only the project scope.
  await db.transaction(async (transaction) => {
    const scoped = registerTracerProjectId(
      transaction as unknown as TracerDatabase,
      "other-project"
    )
    await assert.rejects(
      runTracerEffect(
        mutateTraceSelection(scoped, {
          action: "delete",
          traceIds: ["trace-a"],
        })
      ),
      /no longer available/
    )
  })
  expect((await db.select().from(traces)).length).toBe(2)
})

test("deletion cascades spans and detaches dataset source links", async () => {
  const { db, timestamp } = await setup()
  await db.insert(spans).values(
    scopeRows(db, {
      id: "span-a",
      traceId: "trace-a",
      name: "Span",
      kind: "custom",
      status: "completed",
      startedAt: timestamp,
      attributesJson: "{}",
    })
  )
  await db.insert(datasets).values(
    scopeRows(db, {
      id: "dataset-a",
      name: "Dataset",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
  )
  await db.insert(datasetItems).values(
    scopeRows(db, {
      id: "item-a",
      datasetId: "dataset-a",
      sourceTraceId: "trace-a",
      inputJson: "{}",
      metadataJson: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
  )
  await runTracerEffect(
    mutateTraceSelection(db, { action: "delete", traceIds: ["trace-a"] })
  )
  expect((await db.select().from(traces)).map((trace) => trace.id)).toEqual([
    "trace-b",
  ])
  expect(await db.select().from(spans)).toEqual([])
  expect((await db.select().from(datasetItems))[0].sourceTraceId).toBeNull()
})

test("evaluation references prevent deletion of any trace in the batch", async () => {
  const { db, timestamp } = await setup()
  await db
    .insert(evalRuns)
    .values(
      scopeRows(db, { id: "run-a", status: "completed", createdAt: timestamp })
    )
  await db.insert(evalRunTargets).values(
    scopeRows(db, {
      id: "target-a",
      runId: "run-a",
      traceId: "trace-b",
      ordinal: 0,
      createdAt: timestamp,
    })
  )
  await assert.rejects(
    runTracerEffect(
      mutateTraceSelection(db, {
        action: "delete",
        traceIds: ["trace-a", "trace-b"],
      })
    ),
    /No traces were deleted/
  )
  expect((await db.select().from(traces)).length).toBe(2)
})

test("review references prevent deletion of any trace in the batch", async () => {
  const { db, timestamp } = await setup()
  await db.insert(reviewSessions).values(
    scopeRows(db, {
      id: "review-a",
      name: "Review",
      prompt: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
  )
  await db.insert(reviewItems).values(
    scopeRows(db, {
      id: "review-item-a",
      sessionId: "review-a",
      traceId: "trace-b",
      ordinal: 0,
      notes: "",
    })
  )
  await assert.rejects(
    runTracerEffect(
      mutateTraceSelection(db, {
        action: "delete",
        traceIds: ["trace-a", "trace-b"],
      })
    ),
    /No traces were deleted/
  )
  expect((await db.select().from(traces)).length).toBe(2)
})
