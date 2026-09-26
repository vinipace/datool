import { afterEach, describe, expect, test } from "bun:test"

import { Pool } from "pg"

import { runTracerEffect } from "@/src/server/tracer/effect"
import {
  closeTracerDatabase,
  createTracerDatabase,
  type TracerDatabase,
} from "@/src/server/tracer/db"
import { TracerService } from "@/src/server/tracer/service"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
  type IsolatedPostgres,
} from "@/tests/helpers/postgres"

type Resource = { databases: TracerDatabase[]; target: IsolatedPostgres }

const resources: Resource[] = []

afterEach(async () => {
  for (const { databases, target } of resources.splice(0)) {
    await Promise.all(databases.map(closeTracerDatabase))
    await target.close()
  }
})

function createService(target: IsolatedPostgres, projectId: string) {
  // Exercise the explicit schema option without duplicating it in the URL.
  const url = new URL(target.databaseUrl)
  url.searchParams.delete("options")
  const database = createTracerDatabase(url.toString(), {
    projectId,
    schema: target.schema,
  })
  return { database, service: new TracerService(database) }
}

async function expectNotFound(effect: Promise<unknown>) {
  let error: unknown
  try {
    await effect
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain("was not found")
}

describe("tracer service project isolation", () => {
  test("same-org and foreign-org projects cannot read, mutate, relate, or measure another project's typed data", async () => {
    const target = await createIsolatedPostgres()
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)

    const sameOrganizationProjectId = crypto.randomUUID()
    const foreignOrganizationId = crypto.randomUUID()
    const foreignProjectId = crypto.randomUUID()
    const pool = new Pool({ connectionString: target.databaseUrl })
    try {
      const now = new Date()
      await pool.query(
        `INSERT INTO organization (id, name, slug, "createdAt") VALUES ($1, 'Foreign organization', 'foreign-org', $2)`,
        [foreignOrganizationId, now]
      )
      await pool.query(
        `INSERT INTO project (id, organization_id, name, slug, created_at, updated_at)
         VALUES ($1, $2, 'Sibling project', 'sibling-project', $3, $3),
                ($4, $5, 'Foreign project', 'foreign-project', $3, $3)`,
        [
          sameOrganizationProjectId,
          target.organizationId,
          now,
          foreignProjectId,
          foreignOrganizationId,
        ]
      )
    } finally {
      await pool.end()
    }

    const ownerDatabase = createTracerDatabase(target.databaseUrl, {
      projectId: target.projectId,
      schema: target.schema,
    })
    const owner = new TracerService(ownerDatabase)
    const sibling = createService(target, sameOrganizationProjectId)
    const foreign = createService(target, foreignProjectId)
    resources.push({
      databases: [ownerDatabase, sibling.database, foreign.database],
      target,
    })

    const trace = await runTracerEffect(
      owner.createTrace({
        name: "owner trace",
        operation: "isolation",
        status: "completed",
      })
    )
    const dataset = await runTracerEffect(
      owner.createDataset({ name: "owner dataset" })
    )
    const evaluator = await runTracerEffect(
      owner.createEvaluator({
        code: "function evaluate() { return { score: 1, passed: true } }",
        language: "javascript",
        name: "owner evaluator",
      })
    )
    const run = await runTracerEffect(
      owner.createEvalRun({
        evaluatorIds: [evaluator.id],
        traceIds: [trace.id],
      })
    )
    const view = await runTracerEffect(
      owner.createSavedView({
        columns: [],
        name: "owner view",
        resource: "traces",
      })
    )

    for (const { service } of [sibling, foreign]) {
      await expectNotFound(runTracerEffect(service.getTrace(trace.id)))
      await expectNotFound(
        runTracerEffect(
          service.patchTrace(trace.id, { name: "cross-project write" })
        )
      )
      await expectNotFound(runTracerEffect(service.getDataset(dataset.id)))
      await expectNotFound(
        runTracerEffect(
          service.createDatasetItem(dataset.id, {
            input: { source: "foreign" },
          })
        )
      )
      await expectNotFound(runTracerEffect(service.getEvalRun(run.id)))
      await expectNotFound(runTracerEffect(service.getSavedView(view.id)))
      const metrics = await runTracerEffect(
        service.querySemanticMetrics({
          measures: [
            "scores.meanScore",
            "scores.scoredCount",
            "scores.explicitPassRate",
          ],
          filters: [
            {
              member: "scores.evalRunId",
              operator: "equals",
              values: [run.id],
            },
          ],
          timeDimensions: [
            {
              dimension: "scores.completedAt",
              dateRange: [
                run.createdAt,
                new Date(Date.now() + 1000).toISOString(),
              ],
            },
          ],
        })
      )
      expect(metrics.data[0]?.["scores.scoredCount"]).toBe(0)
      expect(
        (await runTracerEffect(service.listTraces({ includeTotal: true })))
          .total
      ).toBe(0)
    }
  })
})
