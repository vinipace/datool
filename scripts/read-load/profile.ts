import type { Pool, PoolClient } from "pg"
import type { IsolatedPostgres } from "../../tests/helpers/postgres"
import { readWorkloads } from "./workloads"

/** Only called with the harness's disposable schema, after the timed HTTP run. */
export async function profileReads(target: IsolatedPostgres, pool: Pool) {
  const { createTracerDatabase, closeTracerDatabase } =
    await import("../../src/server/tracer/db")
  const { TracerService } = await import("../../src/server/tracer/service")
  const { runTracerEffect } = await import("../../src/server/tracer/effect")
  const { executeSemanticBatch } =
    await import("../../src/server/semantic/executor")
  const { semanticCatalog } = await import("../../src/server/metrics/registry")
  const { createSemanticSnapshotRunner } =
    await import("../../src/server/semantic/snapshot")
  const database = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  const captured: { text: string; values: unknown[] }[] = []
  const ownedPool = (database as unknown as { $client: Pool }).$client
  ownedPool.on("connect", (client: PoolClient) => {
    const original = client.query
    client.query = function (...args: unknown[]) {
      const input = args[0] as string | { text: string; values?: unknown[] }
      const text = typeof input === "string" ? input : input.text
      const values = ((typeof input === "object" ? input.values : undefined) ??
        args[1]) as unknown[] | undefined
      if (
        /^\s*(select|with)\b/i.test(text) &&
        /\b(traces|spans|trace_group_memberships|invocation_hourly_stats)\b/.test(
          text
        )
      )
        captured.push({ text, values: values ?? [] })
      return (original as (...args: unknown[]) => unknown).apply(client, args)
    } as typeof client.query
  })
  const profiles: unknown[] = []
  try {
    const service = new TracerService(database)
    const pages = ["agents", "workflows"].map((model) => ({
      kind: `${model}-page`,
      path: "/api/metrics/batch",
      body: {
        queries: [
          {
            measures: [
              "count",
              "completedCount",
              "erroredCount",
              "runningCount",
              "cancelledCount",
              "errorRate",
              "meanDurationMs",
              "p95DurationMs",
              "durationSampleCount",
              "reportedCostUsd",
              "completeCostCount",
            ].map((key) => `${model}.${key}`),
            dimensions: [`${model}.name`, `${model}.version`],
            timeDimensions: [
              {
                dimension: `${model}.startedAt`,
                dateRange: ["2026-09-01T00:10:00Z", "2026-09-30T23:50:00Z"],
              },
            ],
            order: [
              [`${model}.count`, "desc"],
              [`${model}.name`, "asc"],
            ],
            limit: 50,
            offset: 0,
            total: true,
          },
        ],
      },
    }))
    const rolling = {
      kind: "rolling-counts",
      path: "/api/metrics/batch",
      body: {
        queries: ["agents", "workflows"].map((model) => ({
          measures: [`${model}.count`, `${model}.meanDurationMs`],
          timeDimensions: [
            {
              dimension: `${model}.startedAt`,
              dateRange: ["2026-08-31T23:50:00Z", "2026-09-30T00:10:00Z"],
            },
          ],
          limit: 50,
        })),
      },
    }
    for (const workload of [...readWorkloads, ...pages, rolling]) {
      captured.length = 0
      const started = performance.now()
      let readResult: unknown
      let readError: string | undefined
      try {
        if (workload.body)
          readResult = await executeSemanticBatch(workload.body, {
            catalog: semanticCatalog,
            requestId: "local-query-profile",
            snapshotRunner: createSemanticSnapshotRunner(database),
          })
        else {
          const params = new URL(workload.path, "http://localhost").searchParams
          await runTracerEffect(
            service.listTraces({
              limit: 50,
              filter: params.get("filter"),
              includeTotal: params.get("includeTotal") === "true",
            })
          )
        }
      } catch (error) {
        readError = error instanceof Error ? error.message : "Read failed"
      }
      const readMs = performance.now() - started
      const statements = []
      for (const query of captured) {
        try {
          await pool.query("set statement_timeout='10s'")
          const result = await pool.query(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`,
            query.values
          )
          statements.push({ ...query, plan: result.rows[0]["QUERY PLAN"] })
        } catch (error) {
          statements.push({
            ...query,
            error: error instanceof Error ? error.message : "EXPLAIN failed",
          })
        }
      }
      profiles.push({
        kind: workload.kind,
        readMs,
        readResult,
        readError,
        statements,
      })
      console.info(
        JSON.stringify({
          event: "profile",
          kind: workload.kind,
          statements: statements.length,
          readMs,
          readError,
        })
      )
    }
    return profiles
  } finally {
    await pool.query("set statement_timeout=0")
    await closeTracerDatabase(database)
  }
}
