import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
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
import { createMcpServer } from "../src/server/mcp/server"
import { routeScopes } from "../src/server/auth/request"
import { workspaceScopes } from "../src/lib/auth/permissions"
import { defaultScorer } from "../src/lib/tracer/scorers"
import {
  recordReviewSchema,
  reviewSessionInputSchema,
} from "../src/lib/tracer/reviews"
import { traces } from "../src/server/tracer/schema"
import { customFieldSource, customFieldValue, outputHash } from "../src/lib/tracer/review-annotations"

test("review inputs reject ambiguous scores, non-finite values, duplicate traces and oversized sessions", () => {
  expect(recordReviewSchema.safeParse({ expectedRevision: 0 }).success).toBe(
    false
  )
  expect(
    recordReviewSchema.safeParse({
      expectedRevision: 0,
      notes: "n".repeat(16001),
    }).success
  ).toBe(false)
  expect(
    recordReviewSchema.safeParse({ expectedRevision: 0, notes: "" }).success
  ).toBe(true)
  for (const value of [-1, 2, NaN, Infinity])
    expect(
      recordReviewSchema.safeParse({
        expectedRevision: 0,
        scores: [{ name: "Quality", value }],
      }).success
    ).toBe(false)
  for (const score of [
    { value: 1 },
    { name: "Quality", scorerId: "scorer", value: 1 },
  ])
    expect(
      recordReviewSchema.safeParse({ expectedRevision: 0, scores: [score] })
        .success
    ).toBe(false)
  expect(
    reviewSessionInputSchema.safeParse({ name: "Test", traceIds: ["a", "a"] })
      .success
  ).toBe(false)
  expect(
    reviewSessionInputSchema.safeParse({
      name: "Test",
      traceIds: Array.from({ length: 501 }, (_, i) => String(i)),
    }).success
  ).toBe(false)
})

test("review and Human Score routes use review permissions independently of Scorers", async () => {
  expect(
    await routeScopes(new Request("https://datool.test/api/reviews"))
  ).toEqual(["reviews:read"])
  expect(
    await routeScopes(
      new Request("https://datool.test/api/reviews", { method: "POST" })
    )
  ).toEqual(["reviews:write", "traces:read"])
  expect(
    await routeScopes(
      new Request("https://datool.test/api/reviews/s/items/i", {
        method: "PUT",
      })
    )
  ).toEqual(["reviews:write"])
  for (const resource of ["human-scores", "human-score-collections"]) {
    expect(
      await routeScopes(new Request(`https://datool.test/api/${resource}`))
    ).toEqual(["reviews:read"])
    expect(
      await routeScopes(
        new Request(`https://datool.test/api/${resource}`, { method: "POST" })
      )
    ).toEqual(["reviews:write"])
  }
})

test("ordered review sessions persist attributed scores, protect tenant boundaries and reject stale concurrent saves", async () => {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const db = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
  })
  const foreignDb = createTracerDatabase(target.databaseUrl, {
    projectId: "foreign-project",
  })
  const service = new TracerService(db)
  const identity: WorkspaceIdentity = {
    projectId: target.projectId,
    organizationId: target.organizationId,
    userId: target.ownerId,
    kind: "session",
    scopes: workspaceScopes,
  }
  const run = <T>(
    effect: TracerEffect<T>,
    override: Partial<WorkspaceIdentity> = {}
  ) =>
    withWorkspace({ ...identity, ...override }, () => runTracerEffect(effect))
  const clients: Client[] = []
  try {
    await db.insert(traces).values(
      ["first", "second", "third"].map((id) => ({
        id,
        projectId: target.projectId,
        name: `Prompt ${id}`,
        inputJson: JSON.stringify({ prompt: `Question ${id}` }),
        outputJson: JSON.stringify(`Answer ${id}`),
        operation: "test",
        status: "completed",
        startedAt: "2026-09-13T12:00:00.000Z",
      }))
    )
    await db.execute(
      sql`insert into "user" (id,name,email) values ('outsider','Outside','outside@example.test')`
    )
    await db.execute(
      sql`insert into project (id,organization_id,name,slug) values ('foreign-project',${target.organizationId},'Another project','foreign')`
    )
    await foreignDb.insert(traces).values({
      id: "foreign-trace",
      projectId: "foreign-project",
      name: "Foreign",
      operation: "test",
      status: "completed",
      startedAt: "2026-09-13T12:00:00.000Z",
    })
    for (const input of [
      { name: "Bad assignee", traceIds: ["first"], assigneeUserId: "outsider" },
      { name: "Bad trace", traceIds: ["foreign-trace"] },
      { name: "Missing trace", traceIds: ["missing"] },
    ])
      await assert.rejects(run(service.reviews.create(input)))
    expect((await run(service.reviews.list())).items).toHaveLength(0)
    const creationKey = crypto.randomUUID()
    const created = await run(
      service.reviews.create({
        idempotencyKey: creationKey,
        name: "Prompt review",
        prompt: "Check factual accuracy",
        assigneeUserId: target.ownerId,
        traceIds: ["second", "first", "third"],
      })
    )
    expect(created.items.map((item) => item.traceId)).toEqual([
      "second",
      "first",
      "third",
    ])
    expect(created.assigneeName).toBe("Test owner")
    expect(created.status).toBe("pending")
    const retries = await Promise.all(
      [0, 1].map(() =>
        run(
          service.reviews.create({
            idempotencyKey: creationKey,
            traceIds: ["second", "first", "third"],
          })
        )
      )
    )
    expect(retries.map((session) => session.id)).toEqual([
      created.id,
      created.id,
    ])
    expect(created.id).toBe(`review_${creationKey}`)
    expect((await run(service.reviews.list())).items).toHaveLength(1)
    const another = await run(
      service.reviews.create({ name: "Other session", traceIds: ["first"] })
    )
    const paged = await run(
      service.reviews.list({ limit: 1, includeTotal: true })
    )
    expect(paged.total).toBe(2)
    expect(
      (await run(service.reviews.list({ limit: 1, cursor: paged.nextCursor })))
        .items[0].id
    ).not.toBe(paged.items[0].id)
    expect(
      (
        await run(service.reviews.list({ filter: 'name:"Prompt review"' }))
      ).items.map((row) => row.id)
    ).toEqual([created.id])
    await assert.rejects(
      run(service.reviews.item(another.id, created.items[0].id))
    )
    await assert.rejects(
      run(new TracerService(foreignDb).reviews.get(created.id))
    )
    await assert.rejects(
      run(
        new TracerService(foreignDb).reviews.record(
          created.id,
          created.items[0].id,
          { expectedRevision: 0, scores: [{ name: "Quality", value: 1 }] }
        )
      )
    )
    const unassigned = await run(
      service.reviews.update(created.id, {
        expectedRevision: 1,
        assigneeUserId: null,
      })
    )
    expect(unassigned.assigneeUserId).toBeNull()
    await assert.rejects(
      run(
        service.reviews.update(created.id, {
          expectedRevision: 1,
          name: "stale",
        })
      ),
      new RegExp("Session changed")
    )
    const scorer = await run(
      service.scorers.save({
        ...defaultScorer,
        name: "Accuracy",
        slug: "accuracy",
        type: "javascript",
      })
    )
    const helpfulness = await run(
      service.humanScores.create({ name: "Helpfulness", type: "numeric" })
    )
    const accuracy = await run(
      service.humanScores.create({ name: "Accuracy", type: "numeric" })
    )
    const first = created.items[0]
    const input = {
      expectedRevision: 0,
      scores: [
        {
          humanScoreId: helpfulness.id,
          humanScoreRevision: 1,
          value: 0.8,
          comment: "Clear answer",
        },
        {
          humanScoreId: accuracy.id,
          humanScoreRevision: 1,
          value: 1,
          comment: "Verified",
        },
      ],
    }
    await assert.rejects(
      run(service.reviews.record(created.id, first.id, input), {
        userId: undefined,
        kind: "api-key",
      }),
      new RegExp("authenticated user or organization API key")
    )
    await assert.rejects(
      run(service.reviews.record(created.id, first.id, input), {
        userId: "outsider",
      }),
      new RegExp("member")
    )
    const invalid = {
      expectedRevision: 0,
      scores: [
        { humanScoreId: helpfulness.id, humanScoreRevision: 1, value: 1 },
        { humanScoreId: helpfulness.id, humanScoreRevision: 1, value: 0 },
      ],
    }
    await assert.rejects(
      run(service.reviews.record(created.id, first.id, invalid)),
      new RegExp("only once")
    )
    expect(
      (await run(service.reviews.item(created.id, first.id))).scores
    ).toHaveLength(0)
    const outcomes = await Promise.allSettled([
      run(service.reviews.record(created.id, first.id, input)),
      run(service.reviews.record(created.id, first.id, input)),
    ])
    expect(
      outcomes.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1)
    expect(
      outcomes.filter((result) => result.status === "rejected")
    ).toHaveLength(1)
    const reviewed = await run(service.reviews.item(created.id, first.id))
    expect(reviewed.revision).toBe(1)
    expect(reviewed.nextItemId).toBe(created.items[1].id)
    expect(reviewed.previousItemId).toBeNull()
    expect(reviewed.scores).toHaveLength(2)
    expect(
      reviewed.scores.every(
        (score) =>
          score.source === "human" && score.reviewerId === target.ownerId
      )
    ).toBe(true)
    expect(
      reviewed.scores.find((score) => score.humanScoreId === accuracy.id)
        ?.definition.revision
    ).toBe(1)
    expect((await run(service.reviews.get(created.id))).status).toBe(
      "in_progress"
    )
    expect(
      (await run(service.humanScores.library())).scores.map(
        (score) => score.name
      )
    ).toContain("Helpfulness")
    const traceScores = await run(
      service.listTraceScores("second", { limit: 1 })
    )
    expect(traceScores.items[0].metadata?.reviewSessionId).toBe(created.id)
    expect(traceScores.items[0].metadata?.reviewSessionNumber).toBe(
      created.number
    )
    expect(
      (
        await run(
          service.listTraceScores("second", {
            limit: 1,
            cursor: traceScores.nextCursor,
          })
        )
      ).items
    ).toHaveLength(1)
    expect((await run(service.getTrace("second"))).scores).toHaveLength(2)
    // Human feedback and automated scores share pagination without losing either source.
    await db.execute(
      sql`insert into eval_runs (id,project_id,status,created_at) values ('automated-run',${target.projectId},'completed','2026-09-13T12:00:00Z')`
    )
    await db.execute(sql`insert into eval_results (id,project_id,run_id,trace_id,evaluator_id,evaluator_version_id,score,passed,status,created_at)
      select 'automated-result',${target.projectId},'automated-run','second',id,active_version_id,0.5,false,'failed','2026-09-13T12:00:00Z' from evaluators where project_id=${target.projectId} and id=${scorer.id}`)
    await db.execute(sql`insert into scores (id,project_id,trace_id,eval_result_id,evaluator_id,name,value,status,created_at)
      values ('automated-score',${target.projectId},'second','automated-result',${scorer.id},'Accuracy',0.5,'ok','2026-09-13T12:00:00Z')`)
    const mixed = await run(
      service.listTraceScores("second", { limit: 2, includeTotal: true })
    )
    expect(mixed.total).toBe(3)
    const mixedTail = await run(
      service.listTraceScores("second", { limit: 2, cursor: mixed.nextCursor })
    )
    expect(
      new Set([...mixed.items, ...mixedTail.items].map((score) => score.id))
        .size
    ).toBe(3)
    const fullScores = (await run(service.getTrace("second"))).scores
    expect(
      fullScores.filter((score) => score.metadata?.reviewSessionId)
    ).toHaveLength(2)
    expect(
      fullScores.find((score) => score.evalResultId === "automated-result")
        ?.score
    ).toBe(0.5)
    // A changed rubric does not rewrite the definition revision on saved feedback.
    await run(
      service.scorers.save(
        { ...scorer, expectedRevision: 1, description: "Updated rubric" },
        scorer.id
      )
    )
    expect(
      (await run(service.reviews.item(created.id, first.id))).scores.find(
        (score) => score.humanScoreId === accuracy.id
      )?.definition.revision
    ).toBe(1)

    async function connect(scopes: readonly string[]) {
      const server = createMcpServer(service, scopes)
      const client = new Client({ name: "review-test", version: "1" })
      const [a, b] = InMemoryTransport.createLinkedPair()
      await server.connect(a)
      await client.connect(b)
      clients.push(client)
      return client
    }
    const reader = await connect(["reviews:read"])
    expect(
      (await reader.listTools()).tools.some(
        (tool) => tool.name === "record_review"
      )
    ).toBe(false)
    expect(
      (await reader.listPrompts()).prompts.map((prompt) => prompt.name)
    ).toContain("review_session")
    expect(
      JSON.stringify(
        await reader.getPrompt({
          name: "review_session",
          arguments: { sessionId: created.id },
        })
      )
    ).toContain("Check factual accuracy")
    expect(
      (
        await reader.callTool({
          name: "record_review",
          arguments: { sessionId: created.id, itemId: first.id, ...input },
        })
      ).isError
    ).toBe(true)
    await assert.rejects(
      run(
        service.reviews.record(created.id, first.id, {
          expectedRevision: 1,
          scores: [
            { humanScoreId: accuracy.id, humanScoreRevision: 999, value: 1 },
          ],
        })
      ),
      /Human Score changed/
    )
    expect(
      (await run(service.reviews.item(created.id, first.id))).revision
    ).toBe(1)

    expect((await reader.listTools()).tools.map((tool) => tool.name)).toContain(
      "list_human_scores"
    )
    expect(
      (await reader.listTools()).tools.map((tool) => tool.name)
    ).not.toContain("create_human_score")
    const mcp = await connect(workspaceScopes)
    const libraryScore = await mcp.callTool({
      name: "create_human_score",
      arguments: { score: { name: "MCP rationale", type: "text" } },
    })
    expect(libraryScore.isError).not.toBe(true)
    const humanId = (libraryScore.structuredContent as { data: { id: string } })
      .data.id
    const libraryCollection = await mcp.callTool({
      name: "create_human_score_collection",
      arguments: { name: "MCP collection", scoreIds: [humanId] },
    })
    expect(libraryCollection.isError).not.toBe(true)
    const collectionId = (
      libraryCollection.structuredContent as { data: { id: string } }
    ).data.id
    const mcpCreated = await withWorkspace({ ...identity, kind: "oauth" }, () =>
      mcp.callTool({
        name: "create_review_session",
        arguments: {
          name: "MCP prompt review",
          collectionId,
          prompt: "Review this captured prompt",
          traceIds: ["third", "second"],
          assigneeUserId: target.ownerId,
        },
      })
    )
    expect(mcpCreated.isError).not.toBe(true)
    const mcpSession = (
      mcpCreated.structuredContent as {
        data: { id: string; items: { traceId: string }[] }
      }
    ).data
    expect(mcpSession.items.map((item) => item.traceId)).toEqual([
      "third",
      "second",
    ])

    const response = await withWorkspace({ ...identity, kind: "oauth" }, () =>
      mcp.callTool({
        name: "record_review",
        arguments: {
          sessionId: created.id,
          itemId: created.items[1].id,
          expectedRevision: 0,
          scores: [
            {
              humanScoreId: helpfulness.id,
              humanScoreRevision: 1,
              value: 0,
              comment: "Needs improvement",
            },
          ],
        },
      })
    )
    expect(response.isError).not.toBe(true)
    expect(
      (await run(service.reviews.item(created.id, created.items[1].id)))
        .scores[0].source
    ).toBe("mcp")
    await run(
      service.reviews.record(created.id, created.items[2].id, {
        expectedRevision: 0,
        scores: [
          { humanScoreId: helpfulness.id, humanScoreRevision: 1, value: 1 },
        ],
      })
    )
    expect((await run(service.reviews.get(created.id))).status).toBe(
      "completed"
    )
    // Re-saving replaces the complete score set without duplicate rows and preserves zero.
    await run(
      service.reviews.record(created.id, first.id, {
        expectedRevision: 1,
        scores: [
          { humanScoreId: helpfulness.id, humanScoreRevision: 1, value: 0 },
        ],
      })
    )
    const replaced = await run(service.reviews.item(created.id, first.id))
    expect(replaced.scores).toHaveLength(1)
    expect(replaced.scores[0].value).toBe(0)
    expect(replaced.revision).toBe(2)
    // Removing the final scorer autosaves an empty set and reopens this trace.
    const cleared = await run(
      service.reviews.record(created.id, first.id, {
        expectedRevision: replaced.revision,
        scores: [],
      })
    )
    expect(cleared.scores).toHaveLength(0)
    expect(cleared.reviewedAt).toBeNull()
    expect(cleared.reviewedBy).toBeNull()
    expect(cleared.revision).toBe(3)
    expect((await run(service.reviews.get(created.id))).reviewedCount).toBe(2)
    expect((await run(service.reviews.get(created.id))).status).toBe(
      "in_progress"
    )
    expect((await run(service.getTrace("second"))).scores).toHaveLength(1)
    const noted = await run(
      service.reviews.record(created.id, first.id, {
        expectedRevision: cleared.revision,
        notes: "Prompt needs more context.\nKeep the original wording. ",
      })
    )
    expect(noted.notes).toBe(
      "Prompt needs more context.\nKeep the original wording. "
    )
    expect(noted.scores).toEqual([])
    expect(noted.reviewedAt).toBeNull()
    expect(noted.reviewedBy).toBeNull()
    await assert.rejects(
      run(
        service.reviews.record(created.id, first.id, {
          expectedRevision: cleared.revision,
          notes: "Stale note",
        })
      ),
      /Reload before saving/
    )
    const scored = await run(
      service.reviews.record(created.id, first.id, {
        expectedRevision: noted.revision,
        scores: [
          {
            humanScoreId: helpfulness.id,
            humanScoreRevision: 1,
            value: 0.7,
            comment: "Useful",
          },
        ],
      })
    )
    expect(scored.notes).toBe(noted.notes)
    const editedNote = await run(
      service.reviews.record(created.id, first.id, {
        expectedRevision: scored.revision,
        notes: "Updated observation",
      })
    )
    expect(editedNote.scores).toEqual(scored.scores)
    expect(editedNote.reviewedAt).toBe(scored.reviewedAt)
    expect(editedNote.reviewedBy).toBe(scored.reviewedBy)
    const clearedNote = await run(
      service.reviews.record(created.id, first.id, {
        expectedRevision: editedNote.revision,
        notes: "",
      })
    )
    expect(clearedNote.notes).toBe("")
    expect(clearedNote.scores).toEqual(scored.scores)
    expect(
      (await run(service.reviews.get(created.id))).items.find(
        (item) => item.id === first.id
      )?.notes
    ).toBe("")
    // Editing one criterion must not take credit for the other editor's unchanged score.
    await db.execute(
      sql`update "user" set image='https://example.test/owner.png' where id=${target.ownerId}`
    )
    await db.execute(sql`insert into member (id,"organizationId","userId",role,"createdAt")
      values ('second-reviewer',${target.organizationId},'outsider','member',now())`)
    const collaborative = await run(
      service.reviews.record(created.id, first.id, {
        expectedRevision: clearedNote.revision,
        scores: [
          {
            humanScoreId: helpfulness.id,
            humanScoreRevision: 1,
            value: 0.7,
            comment: "Useful",
          },
          { humanScoreId: accuracy.id, humanScoreRevision: 1, value: 0.9 },
        ],
      }),
      { userId: "outsider" }
    )
    const original = collaborative.scores.find(
      (score) => score.humanScoreId === helpfulness.id
    )!
    const added = collaborative.scores.find(
      (score) => score.humanScoreId === accuracy.id
    )!
    expect(original.reviewerId).toBe(target.ownerId)
    expect(original.reviewerImage).toBe("https://example.test/owner.png")
    expect(original.updatedAt).toBe(scored.scores[0].updatedAt)
    expect(added.reviewerId).toBe("outsider")
    expect(added.reviewerImage).toBeNull()
    const editedComment = await run(
      service.reviews.record(created.id, first.id, {
        expectedRevision: collaborative.revision,
        scores: [
          {
            humanScoreId: helpfulness.id,
            humanScoreRevision: 1,
            value: 0.7,
            comment: "Needs examples",
          },
          { humanScoreId: accuracy.id, humanScoreRevision: 1, value: 0.9 },
        ],
      }),
      { userId: "outsider" }
    )
    expect(
      editedComment.scores.every((score) => score.reviewerId === "outsider")
    ).toBe(true)
    const reference = {
      traceId: first.traceId, spanId: null, spanName: `Prompt ${first.traceId}`, field: "output",
      view: "text", outputHash: await outputHash(`Answer ${first.traceId}`),
      start: 0, end: 6, exact: "Answer", prefix: "", suffix: ` ${first.traceId}`,
    }
    const annotation = { id: crypto.randomUUID(), reference, comment: "Needs a source." }
    const annotated = await run(service.reviews.record(created.id, first.id, {
      expectedRevision: editedComment.revision, annotations: [annotation],
    }))
    expect(annotated.annotations[0].author.id).toBe(target.ownerId)
    expect(annotated.annotations[0].reference.exact).toBe("Answer")
    expect(annotated.reviewedAt).toBe(editedComment.reviewedAt)
    const reloaded = await run(service.reviews.item(created.id, first.id))
    expect(reloaded.annotations).toEqual(annotated.annotations)
    for (const invalid of [
      { ...reference, traceId: "foreign-trace" },
      { ...reference, spanId: "foreign-or-missing-span" },
      { ...reference, outputHash: await outputHash("Different output") },
    ]) await assert.rejects(run(service.reviews.record(created.id, first.id, {
      expectedRevision: annotated.revision,
      annotations: [{ ...annotation, id: crypto.randomUUID(), reference: invalid }],
    })))
    await assert.rejects(run(service.reviews.record(created.id, first.id, {
      expectedRevision: annotated.revision - 1, annotations: [],
    })))
    const notedWithAnnotation = await run(service.reviews.record(created.id, first.id, {
      expectedRevision: annotated.revision, notes: "Keep the quote",
    }))
    expect(notedWithAnnotation.annotations).toEqual(annotated.annotations)
    const removedAnnotation = await run(service.reviews.record(created.id, first.id, {
      expectedRevision: notedWithAnnotation.revision, annotations: [],
    }))
    expect(removedAnnotation.annotations).toEqual([])
    expect(removedAnnotation.notes).toBe("Keep the quote")
    const inputText = JSON.stringify({ prompt: `Question ${first.traceId}` }, null, 2)
    const inputStart = inputText.indexOf("Question")
    const inputReference = { ...reference, field: "input", exact: "Question", start: inputStart, end: inputStart + 8,
      prefix: inputText.slice(0, inputStart), suffix: inputText.slice(inputStart + 8), outputHash: await outputHash({ prompt: `Question ${first.traceId}` }) }
    const inputAnnotation = { ...annotation, id: crypto.randomUUID(), reference: inputReference }
    const inputSaved = await run(service.reviews.record(created.id, first.id, {
      expectedRevision: removedAnnotation.revision, annotations: [inputAnnotation],
    }))
    expect(inputSaved.annotations[0].reference.field).toBe("input")
    await assert.rejects(run(service.reviews.record(created.id, first.id, {
      expectedRevision: inputSaved.revision,
      annotations: [{ ...inputAnnotation, id: crypto.randomUUID(), reference: { ...inputReference, outputHash: reference.outputHash } }],
    })), /Input changed/)
    const field = await run(service.customFields.save({ field: {
      id: "question-field", name: "Question", code: "row.input.prompt", mode: "expression", format: "text",
    } }))
    const trace = await run(service.getTracePayload(first.traceId))
    const captured = customFieldValue(field, `Question ${first.traceId}`)
    const customReference = { ...inputReference, start: 0, end: 8, prefix: "", suffix: ` ${first.traceId}`, field: "custom", customField: {
      ...captured, sourceHash: await outputHash(customFieldSource(trace)),
    }, outputHash: await outputHash(captured) }
    const customAnnotation = { ...annotation, id: crypto.randomUUID(), reference: customReference }
    const customSaved = await run(service.reviews.record(created.id, first.id, {
      expectedRevision: inputSaved.revision, annotations: [inputAnnotation, customAnnotation],
    }))
    const reopened = await run(service.reviews.item(created.id, first.id))
    expect(reopened.annotations).toEqual(customSaved.annotations)
    expect(reopened.annotations[1].reference.customField?.value).toBe(`Question ${first.traceId}`)
    expect(reopened.reviewedAt).toBe(editedComment.reviewedAt)
    for (const customField of [
      { ...customReference.customField, id: "foreign-field" },
      { ...customReference.customField, code: "row.output" },
      { ...customReference.customField, sourceHash: "0".repeat(64) },
      { ...customReference.customField, value: "Different result" },
    ]) await assert.rejects(run(service.reviews.record(created.id, first.id, {
      expectedRevision: customSaved.revision,
      annotations: [{ ...customAnnotation, id: crypto.randomUUID(), reference: { ...customReference, customField } }],
    })))
    await run(service.customFields.save({ field: { ...field, code: "row.output" }, overwrite: true }))
    await assert.rejects(run(service.reviews.record(created.id, first.id, {
      expectedRevision: customSaved.revision,
      annotations: [{ ...customAnnotation, id: crypto.randomUUID() }],
    })), /Custom field changed/)
    // Older comments remain readable and editable after the field definition changes.
    const preserved = await run(service.reviews.record(created.id, first.id, {
      expectedRevision: customSaved.revision,
      annotations: [inputAnnotation, { ...customAnnotation, comment: "Updated comment on the original field." }],
    }))
    expect(preserved.annotations[1].reference.customField?.code).toBe("row.input.prompt")
    await db.execute(sql`delete from project where id=${target.projectId}`)
    expect((await run(service.reviews.list())).items).toHaveLength(0)
    expect(
      (
        await db.execute(
          sql`select id from review_scores where project_id=${target.projectId}`
        )
      ).rows
    ).toHaveLength(0)
  } finally {
    await Promise.all(clients.map((client) => client.close()))
    await closeTracerDatabase(db)
    await closeTracerDatabase(foreignDb)
    await target.close()
  }
}, 30000)
