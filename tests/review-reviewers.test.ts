import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Pool } from "pg"
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
import { runTracerEffect as run } from "../src/server/tracer/effect"
import {
  reviewSessionInputSchema,
  reviewSessionUpdateSchema,
} from "../src/lib/tracer/reviews"
import { traces } from "../src/server/tracer/schema"

test("reviewer selections validate duplicate, oversized, and ambiguous assignments", () => {
  for (const reviewerUserIds of [
    ["a", "a"],
    Array.from({ length: 51 }, (_, i) => String(i)),
  ]) {
    expect(
      reviewSessionInputSchema.safeParse({
        traceIds: ["trace"],
        reviewerUserIds,
      }).success
    ).toBe(false)
    expect(
      reviewSessionUpdateSchema.safeParse({
        expectedRevision: 1,
        reviewerUserIds,
      }).success
    ).toBe(false)
  }
  expect(
    reviewSessionUpdateSchema.safeParse({
      expectedRevision: 1,
      reviewerUserIds: [],
      assigneeUserId: "a",
    }).success
  ).toBe(false)
})

test("reviewers persist in order, remain project scoped, and update atomically with legacy assignment compatibility", async () => {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const db = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
  })
  const foreignDb = createTracerDatabase(target.databaseUrl, {
    projectId: "other",
  })
  const service = new TracerService(db)
  try {
    await db
      .insert(traces)
      .values({
        id: "trace",
        projectId: target.projectId,
        name: "Trace",
        operation: "test",
        status: "completed",
        startedAt: "2026-09-13",
      })
    await db.execute(
      sql`insert into "user"(id,name,email,image) values('jamie','Jamie Lee','jamie@example.test','https://example.test/avatar.png'),('outsider','Outsider','outside@example.test',null)`
    )
    await db.execute(
      sql`insert into member(id,"organizationId","userId",role,"createdAt") values('jamie-member',${target.organizationId},'jamie','member',now())`
    )
    await db.execute(
      sql`insert into project(id,organization_id,name,slug) values('other',${target.organizationId},'Other','other')`
    )
    expect(
      (await run(service.reviews.options())).members.find(
        (member) => member.id === "jamie"
      )?.image
    ).toBe("https://example.test/avatar.png")
    const created = await run(
      service.reviews.create({
        traceIds: ["trace"],
        reviewerUserIds: [target.ownerId, "jamie"],
      })
    )
    expect(created.reviewers.map((reviewer) => reviewer.id)).toEqual([
      target.ownerId,
      "jamie",
    ])
    expect(created.reviewers[1].image).toBe("https://example.test/avatar.png")
    expect(created.assigneeUserId).toBe(target.ownerId)
    expect(
      (await run(service.reviews.table(String(created.number)))).reviewers
    ).toEqual(created.reviewers)
    expect(
      (await run(service.reviews.list({ filter: 'assigneeName:"Jamie Lee"' })))
        .items[0].id
    ).toBe(created.id)
    await assert.rejects(
      run(
        new TracerService(foreignDb).reviews.update(created.id, {
          expectedRevision: 1,
          reviewerUserIds: [],
        })
      )
    )
    await assert.rejects(
      run(
        service.reviews.update(created.id, {
          expectedRevision: 1,
          reviewerUserIds: ["jamie", "outsider"],
        })
      )
    )
    const unchanged = await run(service.reviews.get(created.id))
    expect(unchanged.reviewers).toEqual(created.reviewers)
    expect(unchanged.revision).toBe(1)
    const next = await run(
      service.reviews.update(created.id, {
        expectedRevision: 1,
        reviewerUserIds: ["jamie", target.ownerId],
      })
    )
    expect(next.reviewers.map((reviewer) => reviewer.id)).toEqual([
      "jamie",
      target.ownerId,
    ])
    expect(next.assigneeName).toBe("Jamie Lee")
    await assert.rejects(
      run(
        service.reviews.update(created.id, {
          expectedRevision: 1,
          reviewerUserIds: [],
        })
      )
    )
    const legacy = await run(
      service.reviews.update(created.id, {
        expectedRevision: next.revision,
        assigneeUserId: target.ownerId,
      })
    )
    expect(legacy.reviewers.map((reviewer) => reviewer.id)).toEqual([
      target.ownerId,
    ])
    const cleared = await run(
      service.reviews.update(created.id, {
        expectedRevision: legacy.revision,
        reviewerUserIds: [],
      })
    )
    expect(cleared.reviewers).toEqual([])
    expect(cleared.assigneeUserId).toBeNull()
    await assert.rejects(
      run(
        service.reviews.create({
          traceIds: ["trace"],
          reviewerUserIds: ["outsider"],
        })
      )
    )
    expect((await run(service.reviews.list())).items).toHaveLength(1)
  } finally {
    await closeTracerDatabase(db)
    await closeTracerDatabase(foreignDb)
    await target.close()
  }
}, 30000)

test("reviewer migration preserves existing assignments and review identity", async () => {
  const target = await createIsolatedPostgres()
  const pool = new Pool({ connectionString: target.databaseUrl })
  try {
    for (const file of (await readdir("migrations"))
      .filter(
        (file) => file.endsWith(".sql") && file < "0016_review_reviewers.sql"
      )
      .sort())
      await pool.query(await readFile(`migrations/${file}`, "utf8"))
    await seedTestWorkspace(target)
    await pool.query(
      "insert into review_sessions(id,project_id,assignee_user_id,created_at,updated_at) values('existing',$1,$2,'2026-09-13','2026-09-13'),('unassigned',$1,null,'2026-09-13','2026-09-13')",
      [target.projectId, target.ownerId]
    )
    await pool.query(
      await readFile("migrations/0016_review_reviewers.sql", "utf8")
    )
    expect(
      (
        await pool.query(
          "select session_id,user_id,ordinal from review_session_reviewers"
        )
      ).rows
    ).toEqual([{ session_id: "existing", user_id: target.ownerId, ordinal: 0 }])
    expect(
      (
        await pool.query(
          "select id,number,revision from review_sessions order by number"
        )
      ).rows
    ).toEqual([
      { id: "existing", number: 1, revision: 1 },
      { id: "unassigned", number: 2, revision: 1 },
    ])
  } finally {
    await pool.end()
    await target.close()
  }
}, 30000)
