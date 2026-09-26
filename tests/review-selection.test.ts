import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"
import {
  createTracerDatabase,
  closeTracerDatabase,
} from "../src/server/tracer/db"
import { TracerService } from "../src/server/tracer/service"
import { runTracerEffect } from "../src/server/tracer/effect"
import { withWorkspace } from "../src/server/auth/context"
import { workspaceScopes } from "../src/lib/auth/permissions"
import { routeScopes } from "../src/server/auth/request"
import {
  reviewSelectionSchema,
  type ReviewSessionDetail,
  type ReviewSelection,
} from "../src/lib/tracer/reviews"
import { traces } from "../src/server/tracer/schema"

test("review selection validates bounded unique item revisions and trace table reads require trace access", async () => {
  const input = {
    action: "skip",
    expectedRevision: 1,
    items: [{ id: "item", expectedRevision: 0 }],
  }
  expect(reviewSelectionSchema.safeParse(input).success).toBe(true)
  for (const patch of [
    { action: "delete" },
    { items: [] },
    { expectedRevision: 0 },
    { items: [input.items[0], input.items[0]] },
    { items: [{ id: "item", expectedRevision: -1 }] },
    {
      items: Array.from({ length: 501 }, (_, index) => ({
        id: String(index),
        expectedRevision: 0,
      })),
    },
  ])
    expect(
      reviewSelectionSchema.safeParse({ ...input, ...patch }).success
    ).toBe(false)
  expect(
    await routeScopes(
      new Request("https://datool.test/api/reviews/session/table")
    )
  ).toEqual(["reviews:read", "traces:read"])
  expect(
    await routeScopes(
      new Request("https://datool.test/api/reviews/session/items", {
        method: "PATCH",
      })
    )
  ).toEqual(["reviews:write"])
})

test("review selection is atomic, preserves source traces, and skips across removed or skipped items", async () => {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const db = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
  })
  const foreignDb = createTracerDatabase(target.databaseUrl, {
    projectId: "foreign",
  })
  const service = new TracerService(db)
  const run = runTracerEffect
  const selection = (
    session: ReviewSessionDetail,
    action: ReviewSelection["action"],
    indexes: number[]
  ) =>
    service.reviews.mutateSelection(session.id, {
      action,
      expectedRevision: session.revision,
      items: indexes.map((index) => ({
        id: session.items[index].id,
        expectedRevision: session.items[index].revision,
      })),
    })
  try {
    await db.insert(traces).values(
      ["first", "second", "third", "fourth"].map((id) => ({
        id,
        projectId: target.projectId,
        name: id,
        operation: "test",
        status: "completed",
        startedAt: "2026-09-13T12:00:00Z",
        inputJson: JSON.stringify({ question: id }),
        outputJson: JSON.stringify({ answer: id }),
      }))
    )
    let session = await run(
      service.reviews.create({
        name: "Selection",
        traceIds: ["first", "second", "third", "fourth"],
      })
    )
    const original = session
    const table = await run(service.reviews.table(session.id))
    expect(table.traces.map((trace) => trace.id)).toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ])
    expect(table.traces[0].input).toEqual({ question: "first" })
    expect(table.traces[0].spanStats?.spanCount).toBe(0)
    await assert.rejects(
      run(new TracerService(foreignDb).reviews.table(session.id))
    )
    await assert.rejects(
      run(
        new TracerService(foreignDb).reviews.mutateSelection(session.id, {
          expectedRevision: 1,
          action: "remove",
          items: [{ id: session.items[0].id, expectedRevision: 0 }],
        })
      )
    )
    // Mixing a valid selection with another session must roll back the entire action.
    const other = await run(
      service.reviews.create({ name: "Other", traceIds: ["first"] })
    )
    await assert.rejects(
      run(
        service.reviews.mutateSelection(session.id, {
          expectedRevision: 1,
          action: "remove",
          items: [session.items[0], other.items[0]].map((item) => ({
            id: item.id,
            expectedRevision: 0,
          })),
        })
      )
    )
    expect((await run(service.reviews.get(session.id))).traceCount).toBe(4)
    session = await run(selection(session, "skip", [1, 2]))
    expect(session.skippedCount).toBe(2)
    expect(session.reviewedCount).toBe(0)
    expect(session.items[1].reviewedAt).toBeNull()
    expect(
      (await run(service.reviews.item(session.id, session.items[0].id)))
        .nextItemId
    ).toBe(session.items[3].id)
    expect(
      (await run(service.reviews.item(session.id, session.items[3].id)))
        .previousItemId
    ).toBe(session.items[0].id)
    await assert.rejects(run(selection(original, "remove", [0])))
    session = await run(selection(session, "restore", [1]))
    expect(session.skippedCount).toBe(1)
    expect(
      (await run(service.reviews.item(session.id, session.items[0].id)))
        .nextItemId
    ).toBe(session.items[1].id)
    // A note saved after selecting an item invalidates its revision even when the session revision is unchanged.
    await withWorkspace(
      {
        projectId: target.projectId,
        organizationId: target.organizationId,
        userId: target.ownerId,
        kind: "session",
        scopes: workspaceScopes,
      },
      async () => {
        await run(
          service.reviews.record(session.id, session.items[0].id, {
            expectedRevision: session.items[0].revision,
            notes: "Newer review work",
          })
        )
        await assert.rejects(
          run(
            service.reviews.record(session.id, session.items[2].id, {
              expectedRevision: session.items[2].revision,
              notes: "Cannot edit skipped",
            })
          )
        )
      }
    )
    await assert.rejects(run(selection(session, "remove", [0, 1])))
    expect((await run(service.reviews.get(session.id))).traceCount).toBe(4)
    session = await run(service.reviews.get(session.id))
    const concurrent = await Promise.allSettled([
      run(selection(session, "skip", [0])),
      run(selection(session, "remove", [0])),
    ])
    expect(
      concurrent.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1)
    session = await run(service.reviews.get(session.id))
    session = await run(
      selection(
        session,
        "remove",
        session.items
          .map((_, index) => index)
          .filter((index) => session.items[index].traceId !== "fourth")
      )
    )
    expect(session.items.map((item) => item.traceId)).toEqual(["fourth"])
    const only = await run(
      service.reviews.item(session.id, session.items[0].id)
    )
    expect(only.previousItemId).toBeNull()
    expect(only.nextItemId).toBeNull()
    expect(
      (
        await db.execute(
          sql`select id from traces where project_id=${target.projectId}`
        )
      ).rows
    ).toHaveLength(4)
    expect((await run(service.reviews.get(other.id))).traceCount).toBe(1)
    session = await run(selection(session, "skip", [0]))
    expect(session.status).toBe("completed")
    expect(session.reviewedCount).toBe(0)
    session = await run(selection(session, "remove", [0]))
    expect((await run(service.reviews.table(session.id))).traces).toEqual([])
    const criterion = await run(
      service.humanScores.create({ name: "Quality", type: "numeric" })
    )
    const rated = await withWorkspace(
      {
        projectId: target.projectId,
        organizationId: target.organizationId,
        userId: target.ownerId,
        kind: "session",
        scopes: workspaceScopes,
      },
      () =>
        run(
          service.reviews.record(other.id, other.items[0].id, {
            expectedRevision: 0,
            scores: [
              { humanScoreId: criterion.id, humanScoreRevision: 1, value: 0.8 },
            ],
            notes: "Retain this evidence",
          })
        )
    )
    let scoredSession = await run(service.reviews.get(other.id))
    const scoreTable = await run(service.reviews.table(other.id))
    expect(scoreTable.scoreColumns).toEqual([
      { id: criterion.id, name: "Quality", type: "numeric" },
    ])
    expect(scoreTable.scores).toHaveLength(1)
    expect(scoreTable.scores[0]).toMatchObject({
        itemId: rated.id,
        humanScoreId: criterion.id,
        value: 0.8,
        valueLabel: "0.8",
      },
    )
    const unrelated = await run(
      service.reviews.create({
        name: "Separate review",
        traceIds: [other.items[0].traceId],
      })
    )
    expect((await run(service.reviews.table(unrelated.id))).scores).toEqual([])
    scoredSession = await run(selection(scoredSession, "skip", [0]))
    expect(scoredSession.reviewedCount).toBe(0)
    const skipped = await run(service.reviews.item(other.id, other.items[0].id))
    expect(skipped.scores).toEqual(rated.scores)
    expect((await run(service.reviews.table(other.id))).scores).toEqual(
      scoreTable.scores
    )
    expect(skipped.notes).toBe("Retain this evidence")
    expect(skipped.reviewedAt).toBe(rated.reviewedAt)
    scoredSession = await run(selection(scoredSession, "restore", [0]))
    expect(scoredSession.reviewedCount).toBe(1)
    await run(selection(scoredSession, "remove", [0]))
    expect(
      (
        await db.execute(
          sql`select id from review_scores where item_id=${rated.id}`
        )
      ).rows
    ).toEqual([])
    expect(
      (
        await db.execute(
          sql`select id from traces where project_id=${target.projectId}`
        )
      ).rows
    ).toHaveLength(4)
  } finally {
    await closeTracerDatabase(db)
    await closeTracerDatabase(foreignDb)
    await target.close()
  }
}, 30000)
