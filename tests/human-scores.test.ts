import { Pool } from "pg"
import { readdir, readFile } from "node:fs/promises"
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
import { runTracerEffect, type TracerEffect } from "../src/server/tracer/effect"
import { withWorkspace } from "../src/server/auth/context"
import { workspaceScopes } from "../src/lib/auth/permissions"
import {
  humanScoreInputSchema,
  isHumanScoreValue,
  humanScoreValueLabel,
  type HumanScore,
} from "../src/lib/tracer/human-scores"
import { traces } from "../src/server/tracer/schema"

const choices = [
  { value: "good", label: "Good" },
  { value: "bad", label: "Needs work" },
]
const definition = (input: unknown): HumanScore => ({
  ...humanScoreInputSchema.parse(input),
  id: "human",
  revision: 1,
  archived: false,
  createdAt: "",
  updatedAt: "",
})
test("Human Score definitions validate all four input kinds and enum option identity", () => {
  const numeric = definition({
    name: "Confidence",
    type: "numeric",
    min: 1,
    max: 5,
    step: 1,
  })
  expect(isHumanScoreValue(numeric, 4)).toBe(true)
  for (const value of [0, 6, NaN, Infinity, "4"])
    expect(isHumanScoreValue(numeric, value)).toBe(false)
  const single = definition({
    name: "Verdict",
    type: "categorical",
    options: choices,
  })
  expect(isHumanScoreValue(single, "good")).toBe(true)
  for (const value of ["Good", "missing", ["good"], 0])
    expect(isHumanScoreValue(single, value)).toBe(false)
  const multiple = definition({
    name: "Issues",
    type: "categorical",
    options: choices,
    multiple: true,
  })
  expect(isHumanScoreValue(multiple, ["good", "bad"])).toBe(true)
  for (const value of [[], ["good", "good"], ["missing"], "good"])
    expect(isHumanScoreValue(multiple, value)).toBe(false)
  expect(humanScoreValueLabel(multiple, ["bad", "good"])).toBe(
    "Needs work, Good"
  )
  const text = definition({ name: "Rewrite", type: "text", maxLength: 20 })
  expect(isHumanScoreValue(text, "A better answer")).toBe(true)
  for (const value of ["", "   ", "a".repeat(21), []])
    expect(isHumanScoreValue(text, value)).toBe(false)
  for (const input of [
    { name: "Bad", type: "numeric", min: 5, max: 1 },
    { name: "Bad", type: "numeric", step: 2 },
    { name: "Bad", type: "categorical", options: [choices[0]] },
    { name: "Bad", type: "categorical", options: [choices[0], choices[0]] },
    {
      name: "Bad",
      type: "categorical",
      options: [choices[0], { value: "other", label: "GOOD" }],
    },
  ])
    expect(humanScoreInputSchema.safeParse(input).success).toBe(false)
})

test("collections snapshot definitions, typed ratings survive library changes and stay project scoped", async () => {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const db = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
  })
  const service = new TracerService(db)
  const run = <T>(effect: TracerEffect<T>) =>
    withWorkspace(
      {
        projectId: target.projectId,
        organizationId: target.organizationId,
        userId: target.ownerId,
        kind: "session",
        scopes: workspaceScopes,
      },
      () => runTracerEffect(effect)
    )
  try {
    await db.insert(traces).values({
      id: "weather",
      projectId: target.projectId,
      name: "Weather",
      operation: "test",
      status: "completed",
      startedAt: "2026-09-13T12:00:00Z",
    })
    const numeric = await run(
      service.humanScores.create({
        name: "Confidence",
        type: "numeric",
        min: 1,
        max: 5,
        step: 1,
      })
    )
    const single = await run(
      service.humanScores.create({
        name: "Verdict",
        type: "categorical",
        options: choices,
      })
    )
    const multi = await run(
      service.humanScores.create({
        name: "Issues",
        type: "categorical",
        options: choices,
        multiple: true,
      })
    )
    const text = await run(
      service.humanScores.create({
        name: "Rewrite",
        type: "text",
        maxLength: 100,
      })
    )
    await assert.rejects(
      run(service.humanScores.create({ name: " verdict ", type: "text" })),
      /already exists/
    )
    const definitions = [numeric, single, multi, text]
    const collection = await run(
      service.humanScores.createCollection({
        name: "Weather quality",
        scoreIds: definitions.map((score) => score.id),
      })
    )
    expect(collection.scores.map((score) => score.name)).toEqual([
      "Confidence",
      "Verdict",
      "Issues",
      "Rewrite",
    ])
    const session = await run(
      service.reviews.create({
        name: "Weather review",
        traceIds: ["weather"],
        collectionId: collection.id,
      })
    )
    await run(
      service.humanScores.update(single.id, {
        expectedRevision: 1,
        score: {
          name: "Verdict revised",
          type: "categorical",
          options: [
            { value: "new", label: "New" },
            { value: "old", label: "Old" },
          ],
        },
      })
    )
    await run(
      service.humanScores.updateCollection(collection.id, {
        expectedRevision: 1,
        collection: { name: "Weather revised", scoreIds: [text.id] },
      })
    )
    await assert.rejects(
      run(
        service.humanScores.updateCollection(collection.id, {
          expectedRevision: 1,
          collection: { name: "Stale", scoreIds: [text.id] },
        })
      ),
      /changed/
    )
    const item = await run(
      service.reviews.item(session.id, session.items[0].id)
    )
    expect(item.definitions).toEqual(definitions)
    expect((await run(service.reviews.get(session.id))).collection?.name).toBe(
      "Weather quality"
    )
    const pendingTable = await run(service.reviews.table(session.id))
    expect(pendingTable.scoreColumns).toEqual(
      definitions.map((score) => ({
        id: score.id,
        name: score.name,
        type: score.type,
      }))
    )
    expect(pendingTable.scores).toEqual([])
    const input = definitions.map((score, index) => ({
      humanScoreId: score.id,
      humanScoreRevision: score.revision,
      value: [4, "bad", ["good", "bad"], "Please check the forecast."][index],
    }))
    for (const invalid of [
      { ...input[1], value: "new" },
      { ...input[2], value: ["good", "good"] },
      { ...input[3], value: "a".repeat(101) },
      { ...input[0], value: 6 },
    ])
      await assert.rejects(
        run(
          service.reviews.record(session.id, item.id, {
            expectedRevision: 0,
            scores: [invalid],
          })
        ),
        /Invalid value/
      )
    const partial = await run(
      service.reviews.record(session.id, item.id, {
        expectedRevision: 0,
        scores: input.map((score, index) =>
          index === 0
            ? score
            : { ...score, value: null, comment: "Not answered yet" }
        ),
      })
    )
    expect(partial.reviewedAt).toBeNull()
    const partialTable = await run(service.reviews.table(session.id))
    expect(
      partialTable.scores.filter((score) => score.valueLabel === null)
    ).toHaveLength(3)
    expect((await run(service.listTraceScores("weather"))).items).toHaveLength(
      1
    )
    const rated = await run(
      service.reviews.record(session.id, item.id, {
        expectedRevision: partial.revision,
        scores: input,
        notes: "Keep the city and units.",
      })
    )
    expect(rated.reviewedAt).not.toBeNull()
    const reviewTable = await run(service.reviews.table(session.id))
    expect(
      reviewTable.scores.find((score) => score.humanScoreId === numeric.id)
        ?.valueLabel
    ).toBe("4")
    expect(
      reviewTable.scores.find((score) => score.humanScoreId === single.id)
        ?.valueLabel
    ).toBe("Needs work")
    expect(
      reviewTable.scores.find((score) => score.humanScoreId === text.id)
        ?.valueLabel
    ).toBe("Please check the forecast.")
    expect(
      reviewTable.scores.find((score) => score.humanScoreId === multi.id)?.value
    ).toEqual(["good", "bad"])
    expect(rated.scores.map((score) => score.value)).toEqual([
      4,
      ["good", "bad"],
      "Please check the forecast.",
      "bad",
    ])
    const displayed = (await run(service.listTraceScores("weather"))).items
    expect(
      displayed.find((score) => score.name === "Verdict")?.valueLabel
    ).toBe("Needs work")
    expect(displayed.find((score) => score.name === "Issues")?.score).toBeNull()
    expect(displayed.find((score) => score.name === "Confidence")?.score).toBe(
      0.75
    )
    expect(displayed.every((score) => score.evaluatorId === null)).toBe(true)
    expect((await run(service.scorers.list())).length).toBe(0)
    const extra = await run(
      service.humanScores.create({ name: "Safety", type: "numeric" })
    )
    const expanded = await run(
      service.humanScores.createCollection({
        name: "Extended review",
        scoreIds: [single.id, extra.id],
      })
    )
    const changed = await run(
      service.reviews.update(session.id, {
        expectedRevision: 1,
        collectionId: expanded.id,
      })
    )
    expect(changed.reviewedCount).toBe(0)
    const changedItem = await run(service.reviews.item(session.id, item.id))
    expect(changedItem.scores).toEqual(rated.scores)
    expect(changedItem.notes).toBe(rated.notes)
    expect(
      changedItem.definitions.find((score) => score.id === single.id)?.revision
    ).toBe(1)
    expect(changedItem.revision).toBe(rated.revision + 1)
    await assert.rejects(
      run(
        service.reviews.record(session.id, item.id, {
          expectedRevision: rated.revision,
          notes: "stale",
        })
      ),
      /reviewed by someone else/
    )
    const detached = await run(
      service.reviews.update(session.id, {
        expectedRevision: changed.revision,
        collectionId: null,
      })
    )
    expect(detached.collection).toBeNull()
    expect(detached.reviewedCount).toBe(1)
    const retained = await run(service.reviews.item(session.id, item.id))
    expect(retained.scores).toEqual(rated.scores)
    expect(retained.notes).toBe(rated.notes)
    const additional = await Promise.all(
      Array.from({ length: 27 }, (_, index) =>
        run(
          service.humanScores.create({
            name: `Additional ${index}`,
            type: "numeric",
          })
        )
      )
    )
    const tooLarge = await run(
      service.humanScores.createCollection({
        name: "Too many combined criteria",
        scoreIds: additional.map((score) => score.id),
      })
    )
    await assert.rejects(
      run(
        service.reviews.update(session.id, {
          expectedRevision: detached.revision,
          collectionId: tooLarge.id,
        })
      ),
      /limit of 30/
    )
    expect(
      (await run(service.reviews.item(session.id, item.id))).revision
    ).toBe(retained.revision)
    await db.execute(
      sql`insert into project(id,organization_id,name,slug) values ('foreign',${target.organizationId},'Foreign','foreign')`
    )
    const foreignDb = createTracerDatabase(target.databaseUrl, {
      projectId: "foreign",
    })
    try {
      const foreign = new TracerService(foreignDb)
      expect(
        (await runTracerEffect(foreign.humanScores.library())).scores
      ).toEqual([])
      await assert.rejects(runTracerEffect(foreign.humanScores.get(single.id)))
      await assert.rejects(
        runTracerEffect(
          foreign.humanScores.createCollection({
            name: "Foreign collection",
            scoreIds: [single.id],
          })
        )
      )
      const other = await runTracerEffect(
        foreign.humanScores.create({ name: "Foreign", type: "text" })
      )
      await assert.rejects(
        run(
          service.reviews.record(session.id, item.id, {
            expectedRevision: retained.revision,
            scores: [
              { humanScoreId: other.id, humanScoreRevision: 1, value: "bad" },
            ],
          })
        )
      )
    } finally {
      await closeTracerDatabase(foreignDb)
    }
    await db.execute(sql`delete from project where id=${target.projectId}`)
    expect((await run(service.humanScores.library())).scores).toEqual([])
  } finally {
    await closeTracerDatabase(db)
    await target.close()
  }
}, 30000)

test("migration preserves legacy ratings, comments and colliding criterion names", async () => {
  const target = await createIsolatedPostgres()
  const pool = new Pool({ connectionString: target.databaseUrl })
  try {
    for (const file of (await readdir("migrations"))
      .filter((file) => file.endsWith(".sql") && file < "0013")
      .sort())
      await pool.query(await readFile(`migrations/${file}`, "utf8"))
    await seedTestWorkspace(target)
    await pool.query(
      `insert into traces(id,project_id,name,operation,status,started_at) values('legacy',$1,'Legacy','test','completed','2026-09-13')`,
      [target.projectId]
    )
    await pool.query(
      `insert into review_sessions(id,project_id,name,created_at,updated_at) values('session',$1,'Legacy','2026-09-13','2026-09-13')`,
      [target.projectId]
    )
    await pool.query(
      `insert into review_items(id,project_id,session_id,trace_id,ordinal,notes) values('item',$1,'session','legacy',0,'Keep these notes')`,
      [target.projectId]
    )
    for (const [index, name] of ["Quality", "Quality", "Quality (2)"].entries())
      await pool.query(
        `insert into review_scores(id,project_id,item_id,trace_id,criterion_key,name,value,comment,source,updated_at) values($1,$2,'item','legacy',$3,$4,$5,'Keep this comment','human','2026-09-13')`,
        [
          `rating${index}`,
          target.projectId,
          `criterion${index}`,
          name,
          index / 2,
        ]
      )
    await pool.query(
      await readFile("migrations/0013_human_score_library.sql", "utf8")
    )
    const ratings = (
      await pool.query(
        `select s.name,s.value,s.human_value,s.comment,s.definition_json,h.name as library_name from review_scores s join human_scores h on h.id=s.human_score_id order by s.id`
      )
    ).rows
    expect(ratings.map((row) => row.human_value)).toEqual([0, 0.5, 1])
    expect(ratings.map((row) => row.name)).toEqual([
      "Quality",
      "Quality",
      "Quality (2)",
    ])
    expect(new Set(ratings.map((row) => row.library_name)).size).toBe(3)
    expect(
      ratings.every(
        (row) =>
          row.comment === "Keep this comment" &&
          row.definition_json.type === "numeric"
      )
    ).toBe(true)
    expect(
      (await pool.query(`select notes from review_items`)).rows[0].notes
    ).toBe("Keep these notes")
  } finally {
    await pool.end()
    await target.close()
  }
}, 30000)
