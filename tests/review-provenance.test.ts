import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
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
import { runTracerEffect, type TracerEffect } from "../src/server/tracer/effect"
import {
  withWorkspace,
  type WorkspaceIdentity,
} from "../src/server/auth/context"
import { workspaceScopes } from "../src/lib/auth/permissions"
import { traces } from "../src/server/tracer/schema"
import { outputHash } from "../src/lib/tracer/review-annotations"
import { recordReviewSchema } from "../src/lib/tracer/reviews"

test("AI review provenance, permissions, revisions, completion and dataset labels remain independent", async () => {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const db = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
  })
  const service = new TracerService(db)
  const human: WorkspaceIdentity = {
    organizationId: target.organizationId,
    projectId: target.projectId,
    userId: target.ownerId,
    kind: "session",
    scopes: workspaceScopes,
  }
  const api: WorkspaceIdentity = {
    ...human,
    userId: undefined,
    kind: "api-key",
    apiKeyId: "verified-key-id",
    apiKeyName: "Review agent",
  }
  const run = <T>(effect: TracerEffect<T>, identity = api) =>
    withWorkspace(identity, () => runTracerEffect(effect))
  try {
    await db.insert(traces).values(
      ["ai", "human", "pending"].map((id) => ({
        id,
        projectId: target.projectId,
        name: id,
        operation: "test",
        status: "completed",
        outputJson: JSON.stringify("Unsupported brand"),
        startedAt: new Date().toISOString(),
      }))
    )
    const dataset = await run(
      service.createDataset({ name: "Preserved labels" })
    )
    await run(
      service.createDatasetItem(dataset.id, {
        input: { example: true },
        expectedOutput: null,
        sourceTraceId: "ai",
      })
    )
    const originalLabels = await db.execute(
      sql`select * from dataset_items where project_id=${target.projectId}`
    )
    const criterion = await run(
      service.humanScores.create({ name: "Grounding", type: "numeric" })
    )
    const collection = await run(
      service.humanScores.createCollection({
        name: "Brand calibration test",
        scoreIds: [criterion.id],
      })
    )
    const session = await run(
      service.reviews.create({
        name: "Separate AI review test",
        traceIds: ["ai", "human", "pending"],
        collectionId: collection.id,
      })
    )
    const [aiItem, humanItem, pending] = session.items
    const scores = [
      { humanScoreId: criterion.id, humanScoreRevision: 1, value: 0.5 },
    ]
    const input = {
      expectedRevision: 0,
      scores,
      notes: "Known-brand context is not evidence.",
      agent: { name: "Codex", model: "test-model" },
    }
    for (const identity of [
      { ...api, scopes: [] },
      { ...api, projectId: "other-project" },
      { ...api, apiKeyId: undefined },
    ])
      await assert.rejects(
        run(service.reviews.record(session.id, aiItem.id, input), identity)
      )
    for (const forged of [
      { source: "human" },
      { reviewerId: target.ownerId },
      { provenance: { label: "Human-reviewed" } },
      { humanVerified: true },
    ])
      expect(
        recordReviewSchema.safeParse({ ...input, ...forged }).success
      ).toBe(false)
    await assert.rejects(
      run(
        service.reviews.record(session.id, aiItem.id, {
          ...input,
          scores: [{ ...scores[0], value: 2 }],
        })
      ),
      /Invalid value/
    )
    await assert.rejects(
      run(
        service.reviews.record(session.id, aiItem.id, {
          ...input,
          scores: [{ ...scores[0], humanScoreRevision: 99 }],
        })
      ),
      /changed/
    )
    const outcomes = await Promise.allSettled([
      run(service.reviews.record(session.id, aiItem.id, input)),
      run(service.reviews.record(session.id, aiItem.id, input)),
    ])
    expect(
      outcomes.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1)
    let saved = await run(service.reviews.item(session.id, aiItem.id))
    expect(saved).toMatchObject({
      label: "AI-labelled",
      completionKind: "ai",
      humanVerified: false,
      reviewedBy: null,
      revision: 1,
    })
    expect(saved.scores[0]).toMatchObject({
      source: "api",
      reviewerId: null,
      provenance: {
        label: "AI-labelled",
        authType: "api-key",
        principal: { type: "api-key", id: api.apiKeyId },
        agent: input.agent,
      },
    })
    const beforeNotes = saved
    saved = await run(
      service.reviews.record(session.id, aiItem.id, {
        expectedRevision: saved.revision,
        notes: "Add an evidence quote.",
      })
    )
    expect(saved.scores).toEqual(beforeNotes.scores)
    expect(saved.reviewedAt).toBe(beforeNotes.reviewedAt)
    expect(saved.completionKind).toBe("ai")
    const annotation = {
      id: crypto.randomUUID(),
      comment: "Not grounded in the response",
      reference: {
        traceId: "ai",
        spanId: null,
        spanName: "Caller name",
        field: "output" as const,
        view: "text" as const,
        outputHash: await outputHash("Unsupported brand"),
        exact: "Unsupported",
        prefix: "",
        suffix: " brand",
        start: 0,
        end: 11,
      },
    }
    saved = await run(
      service.reviews.record(session.id, aiItem.id, {
        expectedRevision: saved.revision,
        annotations: [annotation],
      })
    )
    expect(saved.annotations[0]).toMatchObject({
      author: { id: api.apiKeyId },
      provenance: { label: "AI-labelled" },
      reference: { spanName: "ai" },
    })
    expect(saved.reviewedAt).toBe(beforeNotes.reviewedAt)
    // Browser autosave of the same values, even with a changed comment, cannot launder AI labels.
    saved = await run(
      service.reviews.record(session.id, aiItem.id, {
        expectedRevision: saved.revision,
        scores: [{ ...scores[0], comment: "Read by human" }],
      }),
      human
    )
    expect(saved.humanVerified).toBe(false)
    expect(saved.scores[0].provenance?.label).toBe("AI-labelled")
    expect(saved.scores[0].editedBy?.principal?.id).toBe(target.ownerId)
    saved = await run(
      service.reviews.record(session.id, aiItem.id, {
        expectedRevision: saved.revision,
        annotations: [{ ...annotation, comment: "Human follow-up" }],
      }),
      human
    )
    expect(saved.annotations[0].provenance?.label).toBe("AI-labelled")
    expect(saved.annotations[0].updatedBy?.label).toBe("Human-reviewed")
    await run(
      service.reviews.record(session.id, humanItem.id, {
        expectedRevision: 0,
        scores,
      }),
      human
    )
    const humanNotes = await run(
      service.reviews.record(session.id, humanItem.id, {
        expectedRevision: 1,
        notes: "AI note on human ratings",
      })
    )
    expect(humanNotes.completionKind).toBe("human")
    expect(humanNotes.humanVerified).toBe(false)
    expect(humanNotes.scores[0].source).toBe("human")
    const notesOnly = await run(
      service.reviews.record(session.id, pending.id, {
        expectedRevision: 0,
        notes: "Draft finding",
      })
    )
    expect(notesOnly.reviewedAt).toBeNull()
    expect(notesOnly.scores).toHaveLength(0)
    expect(notesOnly.label).toBe("AI-labelled")
    expect(await run(service.reviews.get(session.id))).toMatchObject({
      reviewedCount: 2,
      humanReviewedCount: 1,
      aiReviewedCount: 1,
      aiLabelledCount: 3,
    })
    expect((await run(service.reviews.list())).items[0].aiLabelledCount).toBe(3)
    const exported = await run(
      service.reviews.exportItems(session.id, { limit: 1 })
    )
    expect(exported.items[0].annotations[0].provenance?.label).toBe(
      "AI-labelled"
    )
    expect(exported.items[0].notesProvenance?.principal?.id).toBe(api.apiKeyId)
    expect(exported.nextCursor).toBe(aiItem.id)
    expect(
      (
        await run(
          service.reviews.exportItems(session.id, {
            cursor: exported.nextCursor,
          })
        )
      ).items
    ).toHaveLength(2)
    expect((await run(service.getTrace("ai"))).scores[0].metadata?.label).toBe(
      "AI-labelled"
    )
    expect(
      (
        await db.execute(
          sql`select * from dataset_items where project_id=${target.projectId}`
        )
      ).rows
    ).toEqual(originalLabels.rows)
    // Reattaching a rubric must retain the same AI vs human completion classification.
    await run(
      service.reviews.update(session.id, {
        expectedRevision: 1,
        collectionId: collection.id,
      })
    )
    expect(await run(service.reviews.get(session.id))).toMatchObject({
      humanReviewedCount: 1,
      aiReviewedCount: 1,
    })
    // Reconstruct the pre-provenance schema to prove the migration preserves labels and reviews.
    await db.execute(
      sql`update review_scores set source='mcp' where source='api'`
    )
    await db.execute(sql`update review_items i set annotations_json=coalesce(
      (select jsonb_agg(a-'provenance'-'updatedBy') from jsonb_array_elements(i.annotations_json) a),'[]'::jsonb)`)
    const historicalItems = (
      await db.execute(
        sql`select id,notes,annotations_json,revision,reviewed_at,reviewed_by from review_items order by id`
      )
    ).rows
    const historicalScores = (
      await db.execute(
        sql`select id,human_value,definition_json,comment,source,reviewer_id,updated_at from review_scores order by id`
      )
    ).rows
    await db.execute(
      sql`alter table review_scores drop column provenance_json, drop column edited_by_json`
    )
    await db.execute(
      sql`alter table review_items drop column notes_provenance_json, drop column last_submission_json`
    )
    await db.execute(
      sql.raw(await readFile("migrations/0029_review_provenance.sql", "utf8"))
    )
    const migratedItems = (
      await db.execute(
        sql`select id,notes,annotations_json,revision,reviewed_at,reviewed_by from review_items order by id`
      )
    ).rows
    for (const row of migratedItems) {
      row.annotations_json = (
        row.annotations_json as Record<string, unknown>[]
      ).map((annotation) => {
        expect(annotation.provenance).toMatchObject({
          label: "Unknown provenance",
        })
        const { provenance, ...original } = annotation
        void provenance
        return original
      })
    }
    expect(migratedItems).toEqual(historicalItems)
    expect(
      (
        await db.execute(
          sql`select id,human_value,definition_json,comment,source,reviewer_id,updated_at from review_scores order by id`
        )
      ).rows
    ).toEqual(historicalScores)
    const migrated = await run(service.reviews.item(session.id, aiItem.id))
    expect(migrated.scores[0].provenance?.label).toBe("AI-labelled")
    expect(migrated.notesProvenance?.label).toBe("Unknown provenance")
    expect(
      (
        await db.execute(
          sql`select * from dataset_items where project_id=${target.projectId}`
        )
      ).rows
    ).toEqual(originalLabels.rows)
  } finally {
    await closeTracerDatabase(db)
    await target.close()
  }
})
