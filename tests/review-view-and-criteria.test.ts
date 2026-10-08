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
} from "@/src/server/tracer/db"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect as run } from "@/src/server/tracer/effect"
import { withWorkspace } from "@/src/server/auth/context"
import { workspaceScopes } from "@/src/lib/auth/permissions"
import { recordReviewSchema } from "@/src/lib/tracer/reviews"
import { traces } from "@/src/server/tracer/schema"

test("criteria replacement requires a score selection", () => {
  expect(
    recordReviewSchema.safeParse({
      expectedRevision: 0,
      replaceCriteria: true,
      notes: "note",
    }).success
  ).toBe(false)
  expect(
    recordReviewSchema.safeParse({
      expectedRevision: 0,
      replaceCriteria: true,
      scores: [],
    }).success
  ).toBe(true)
})

test("review defaults are project-scoped and removing collection scores affects only the selected trace", async () => {
  const target = await createIsolatedPostgres()
  const db = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
  })
  const foreignDb = createTracerDatabase(target.databaseUrl, {
    projectId: "foreign-project",
  })
  try {
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    await db.insert(traces).values(
      ["first", "second"].map((id) => ({
        id,
        projectId: target.projectId,
        name: id,
        operation: "test",
        status: "completed" as const,
        startedAt: "2026-10-08T12:00:00Z",
      }))
    )
    await db.execute(
      sql`insert into project(id,organization_id,name,slug) values('foreign-project',${target.organizationId},'Other','other')`
    )
    const identity = {
      organizationId: target.organizationId,
      projectId: target.projectId,
      userId: target.ownerId,
      kind: "session" as const,
      scopes: workspaceScopes,
    }
    const service = new TracerService(db)
    const viewInput = {
      name: "Evidence",
      description: "",
      dataMode: "summary",
      requirements: [],
      code: "export default function View() { return <div>Evidence</div> }",
      source: null,
    }
    const foreignView = await withWorkspace(
      { ...identity, projectId: "foreign-project" },
      () => run(new TracerService(foreignDb).reactViews.create(viewInput))
    )
    await withWorkspace(identity, async () => {
      const view = await run(
        service.reactViews.create({ ...viewInput, objectTypes: ["trace"] })
      )
      const datasetView = await run(
        service.reactViews.create({
          ...viewInput,
          objectTypes: ["dataset-item"],
        })
      )
      const quality = await run(
        service.humanScores.create({ name: "Quality", type: "numeric" })
      )
      const evidence = await run(
        service.humanScores.create({ name: "Evidence", type: "numeric" })
      )
      const collection = await run(
        service.humanScores.createCollection({
          name: "Rubric",
          scoreIds: [quality.id, evidence.id],
        })
      )
      const session = await run(
        service.reviews.create({
          traceIds: ["first", "second"],
          collectionId: collection.id,
          defaultObjectViewId: view.id,
        })
      )
      expect(session.defaultObjectViewId).toBe(view.id)
      expect(
        (await run(service.reviews.table(session.id))).defaultObjectViewId
      ).toBe(view.id)
      const [first, second] = session.items
      const selection = [
        {
          humanScoreId: quality.id,
          humanScoreRevision: quality.revision,
          value: 1,
        },
      ]
      const edited = await run(
        service.reviews.record(session.id, first.id, {
          expectedRevision: 0,
          replaceCriteria: true,
          scores: selection,
        })
      )
      expect(edited.definitions.map((score) => score.id)).toEqual([quality.id])
      expect(edited.reviewedAt).not.toBeNull()
      expect(
        (await run(service.reviews.item(session.id, first.id))).definitions.map(
          (score) => score.id
        )
      ).toEqual([quality.id])
      expect(
        (
          await run(service.reviews.item(session.id, second.id))
        ).definitions.map((score) => score.id)
      ).toEqual([quality.id, evidence.id])
      expect(
        (await run(service.reviews.get(session.id))).collection?.scoreIds
      ).toEqual([quality.id, evidence.id])
      const partial = await run(
        service.reviews.record(session.id, second.id, {
          expectedRevision: 0,
          scores: selection,
        })
      )
      expect(partial.reviewedAt).toBeNull()
      await assert.rejects(
        run(
          service.reviews.record(session.id, first.id, {
            expectedRevision: 0,
            replaceCriteria: true,
            scores: [],
          })
        ),
        /Reload before saving/
      )
      const changedCollection = await run(
        service.reviews.update(session.id, {
          expectedRevision: session.revision,
          collectionId: collection.id,
        })
      )
      const preserved = await run(service.reviews.item(session.id, first.id))
      expect(preserved.definitions.map((score) => score.id)).toEqual([
        quality.id,
      ])
      expect(preserved.reviewedAt).not.toBeNull()
      const cleared = await run(
        service.reviews.record(session.id, first.id, {
          expectedRevision: preserved.revision,
          replaceCriteria: true,
          scores: [],
        })
      )
      expect(cleared.definitions).toEqual([])
      expect(cleared.scores).toEqual([])
      expect(cleared.reviewedAt).toBeNull()
      expect(
        (await run(service.reviews.item(session.id, first.id))).definitions
      ).toEqual([])
      for (const invalidView of [foreignView.id, datasetView.id, "missing"]) {
        await assert.rejects(
          run(
            service.reviews.update(session.id, {
              expectedRevision: changedCollection.revision,
              defaultObjectViewId: invalidView,
            })
          ),
          /trace Object View/
        )
        await assert.rejects(
          run(
            service.reviews.create({
              traceIds: ["first"],
              defaultObjectViewId: invalidView,
            })
          ),
          /trace Object View/
        )
      }
      const reset = await run(
        service.reviews.update(session.id, {
          expectedRevision: changedCollection.revision,
          defaultObjectViewId: null,
        })
      )
      expect(reset.defaultObjectViewId).toBeNull()
      await assert.rejects(
        run(
          service.reviews.update(session.id, {
            expectedRevision: changedCollection.revision,
            defaultObjectViewId: view.id,
          })
        ),
        /Reload before saving/
      )
      const selected = await run(
        service.reviews.update(session.id, {
          expectedRevision: reset.revision,
          defaultObjectViewId: view.id,
        })
      )
      expect(
        (await run(service.reviews.get(session.id))).defaultObjectViewId
      ).toBe(view.id)
      expect(selected.revision).toBe(reset.revision + 1)
      await run(service.reactViews.delete(view.id, view.revision))
      expect(
        (await run(service.reviews.get(session.id))).defaultObjectViewId
      ).toBeNull()
    })
  } finally {
    await closeTracerDatabase(db)
    await closeTracerDatabase(foreignDb)
    await target.close()
  }
}, 30000)
