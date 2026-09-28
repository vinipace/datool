import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { createReportService } from "../src/server/tracer/reports"
import { readPublicReport } from "../src/server/tracer/public-reports"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"
import {
  getTracerProjectId,
  registerTracerProjectId,
} from "../src/server/tracer/db"
import { reportInputSchema } from "../src/lib/tracer/reports"
import { seedEvalAttributionFacts } from "./helpers/eval-attribution-fixture"
import { sql } from "drizzle-orm"
import {
  withWorkspace,
  type WorkspaceIdentity,
} from "../src/server/auth/context"

const input = () =>
  reportInputSchema.parse({
    creationKey: crypto.randomUUID(),
    name: "Review me",
    description: "",
    mdx: "Private draft",
    sources: {},
    bindings: {},
  })

test("reports record authenticated authors, preserve them on edits and attribute copies to their creator", async () => {
  const db = await createTracerFixture()
  try {
    const service = createReportService(db)
    const projectId = getTracerProjectId(db)
    const {
      rows: [workspace],
    } = await db.execute<{ organizationId: string; userId: string }>(
      sql`select p.organization_id as "organizationId", m."userId" as "userId"
          from project p join member m on m."organizationId"=p.organization_id where p.id=${projectId}`
    )
    const identity: WorkspaceIdentity = {
      ...workspace,
      projectId,
      scopes: [],
      kind: "session",
    }
    const createInput = input()
    const original = await withWorkspace(identity, () =>
      run(service.create(createInput))
    )
    expect(original.author).toEqual({
      id: workspace.userId,
      name: "Test owner",
      kind: "session",
    })
    expect((await run(service.list()))[0].author).toEqual(original.author)
    const apiIdentity: WorkspaceIdentity = {
      organizationId: workspace.organizationId,
      projectId,
      scopes: [],
      kind: "api-key",
      apiKeyId: "report-automation-key",
      apiKeyName: "Report automation",
    }
    const automated = await withWorkspace(apiIdentity, () =>
      run(service.create(input()))
    )
    expect(automated.author).toEqual({
      id: "report-automation-key",
      name: "Report automation",
      kind: "api-key",
    })
    const retried = await withWorkspace(apiIdentity, () =>
      run(service.create(createInput))
    )
    expect(retried.author).toEqual(original.author)
    const edited = await withWorkspace(apiIdentity, () =>
      run(
        service.update({
          number: original.number,
          revision: original.revision,
          document: { ...original.document!, name: "Edited by an agent" },
        })
      )
    )
    expect(edited.author).toEqual(original.author)
    const oauth = await withWorkspace({ ...identity, kind: "oauth" }, () =>
      run(service.create(input()))
    )
    expect(oauth.author).toEqual({ ...original.author!, kind: "oauth" })
    const copy = await withWorkspace(apiIdentity, () =>
      run(
        service.clone({
          number: original.number,
          creationKey: crypto.randomUUID(),
        })
      )
    )
    expect(copy.author).toEqual(automated.author)
    expect((await run(service.get(original.number))).author).toEqual(
      original.author
    )
    expect((await run(service.create(input()))).author).toBeNull()
    await rejects(
      run(service.create({ ...input(), author: original.author })),
      /Unrecognized key/
    )
    await rejects(
      withWorkspace({ ...identity, projectId: "another-project" }, () =>
        run(service.create(input()))
      ),
      /Project identity/
    )
    const published = await run(
      service.publish({ number: original.number, revision: edited.revision })
    )
    expect(published.author).toEqual(original.author)
    const shared = await run(
      service.share({
        number: original.number,
        revision: published.revision,
        enabled: true,
      })
    )
    expect(
      (await readPublicReport(shared.publicPath!.split("/").at(-1)!, db))
        ?.author
    ).toBeUndefined()
  } finally {
    await closeTracerFixture(db)
  }
})

test("draft review, revision conflicts, publication, anonymous sharing and revocation", async () => {
  const db = await createTracerFixture()
  try {
    const service = createReportService(db)
    const source = input()
    const draft = await run(service.create(source))
    expect(draft.status).toBe("draft")
    expect(draft.revision).toBe(1)
    expect(draft.publicPath).toBeNull()
    expect(draft.document?.mdx).toEqual(source.mdx)
    await rejects(
      run(service.share({ number: draft.number, revision: 1, enabled: true })),
      /Publish/
    )
    expect(await readPublicReport(String(draft.number), db)).toBeNull()
    expect(await readPublicReport("a".repeat(64), db)).toBeNull()
    const snapshot = JSON.stringify(draft.snapshot.results)
    const edited = await run(
      service.update({
        number: draft.number,
        revision: 1,
        document: {
          ...draft.document!,
          name: "Reviewed report",
          mdx: "# Reviewed conclusion",
        },
      })
    )
    expect(edited.revision).toBe(2)
    expect(JSON.stringify(edited.snapshot.results)).toBe(snapshot)
    expect(edited.name).toBe("Reviewed report")
    await rejects(
      run(
        service.update({
          number: draft.number,
          revision: 1,
          document: { ...draft.document!, name: "Lost update" },
        })
      ),
      /changed/
    )
    await rejects(
      run(service.publish({ number: draft.number, revision: 1 })),
      /changed/
    )
    const results = await Promise.allSettled([
      run(
        service.update({
          number: draft.number,
          revision: 2,
          document: { ...edited.document!, description: "Concurrent change" },
        })
      ),
      run(service.publish({ number: draft.number, revision: 2 })),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const latest = await run(service.get(draft.number))
    const published = await run(
      service.publish({ number: draft.number, revision: latest.revision })
    )
    expect(published.status).toBe("published")
    expect(published.draftInput).toBeUndefined()
    expect(published.publicPath).toBeNull()
    expect(JSON.stringify(published.snapshot.results)).toBe(snapshot)
    await rejects(
      run(
        service.update({
          number: draft.number,
          revision: published.revision,
          document: { ...edited.document!, name: "Rewrite" },
        })
      ),
      /Published reports/
    )
    const shared = await run(
      service.share({
        number: draft.number,
        revision: published.revision,
        enabled: true,
      })
    )
    const token = shared.publicPath!.split("/").at(-1)!
    expect(/^[a-f0-9]{64}$/.test(token)).toBe(true)
    const publicReport = await readPublicReport(token, db)
    expect(publicReport?.name).toBe("Reviewed report")
    expect(publicReport?.mdx?.nodes[0].tag).toBe("h1")
    expect(publicReport?.document).toBeUndefined()
    expect(publicReport?.draftInput).toBeUndefined()
    expect(publicReport?.publicPath).toBeUndefined()
    expect(publicReport?.publicUrl).toBeUndefined()
    const own = getTracerProjectId(db)
    registerTracerProjectId(db, "foreign-project")
    const other = createReportService(db)
    for (const action of [
      other.get(draft.number),
      other.update({
        number: draft.number,
        revision: shared.revision,
        document: { ...edited.document!, name: "Foreign" },
      }),
      other.share({
        number: draft.number,
        revision: shared.revision,
        enabled: false,
      }),
      other.publish({ number: draft.number, revision: shared.revision }),
    ])
      await rejects(run(action), /not found/i)
    registerTracerProjectId(db, own)
    const cloned = await run(
      service.clone({
        number: draft.number,
        creationKey: source.creationKey.replace(
          /^./,
          source.creationKey[0] === "a" ? "b" : "a"
        ),
      })
    )
    expect(cloned.number).not.toBe(draft.number)
    expect(cloned.status).toBe("draft")
    expect(cloned.publicPath).toBeNull()
    expect(cloned.snapshot).toEqual(published.snapshot)
    const changedCopy = await run(
      service.update({
        number: cloned.number,
        revision: 1,
        document: { ...cloned.document!, mdx: "Revised copy" },
      })
    )
    expect(changedCopy.document?.mdx).toBe("Revised copy")
    expect((await readPublicReport(token, db))?.mdx).toEqual(published.mdx)
    const revoked = await run(
      service.share({
        number: draft.number,
        revision: shared.revision,
        enabled: false,
      })
    )
    expect(await readPublicReport(token, db)).toBeNull()
    const reenabled = await run(
      service.share({
        number: draft.number,
        revision: revoked.revision,
        enabled: true,
      })
    )
    expect(reenabled.publicPath).not.toBe(shared.publicPath)
    expect(await readPublicReport(token, db)).toBeNull()
  } finally {
    await closeTracerFixture(db)
  }
})

test("data edits recapture explicitly, publication retains reviewed evidence, public queries hide private selectors", async () => {
  const db = await createTracerFixture()
  try {
    await seedEvalAttributionFacts(db, 2, 5)
    const service = createReportService(db)
    const source = input()
    source.mdx += '\n\n<Table source="scores" />'
    source.sources.scores = {
      query: {
        measures: ["evalResults.meanScore"],
        dimensions: ["evalResults.runId"],
        timeDimensions: [
          {
            dimension: "evalResults.completedAt",
            dateRange: [
              new Date(Date.now() - 86400000).toISOString(),
              new Date(Date.now() + 1000).toISOString(),
            ],
          },
        ],
        filters: [
          {
            member: "evalResults.runId",
            operator: "equals",
            values: ["run-2"],
          },
        ],
      },
    } as never
    const draft = await run(service.create(source))
    const oldResults = structuredClone(draft.snapshot.results)
    await db.execute(
      sql`update scores set value=0.123 where project_id=${getTracerProjectId(db)}`
    )
    const { creationKey: _key, ...capture } = draft.draftInput!
    void _key
    const refreshed = await run(
      service.update({
        number: draft.number,
        revision: 1,
        document: capture,
        refresh: true,
      })
    )
    expect(refreshed.snapshot.results[0].data).not.toEqual(oldResults[0].data)
    await db.execute(
      sql`delete from eval_results where project_id=${getTracerProjectId(db)}`
    )
    const published = await run(
      service.publish({ number: draft.number, revision: refreshed.revision })
    )
    expect(published.snapshot).toEqual(refreshed.snapshot)
    const shared = await run(
      service.share({
        number: draft.number,
        revision: published.revision,
        enabled: true,
      })
    )
    const publicReport = await readPublicReport(
      shared.publicPath!.split("/").at(-1)!,
      db
    )
    expect(publicReport?.snapshot.results[0].data).toEqual(
      refreshed.snapshot.results[0].data
    )
    expect(publicReport?.snapshot.results[0].query.filters).toEqual([])
    expect(publicReport?.config.widgets[1]).toMatchObject({
      query: { filters: [] },
    })
    expect(publicReport?.snapshot.results[0].meta.requestId).toBe(
      "public-report"
    )
  } finally {
    await closeTracerFixture(db)
  }
})
