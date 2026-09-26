import { expect, test } from "bun:test"
import { sql, type SQL } from "drizzle-orm"
import { writeFile } from "node:fs/promises"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"
import { seedEvalAttributionFacts } from "./helpers/eval-attribution-fixture"
import { executeSemanticQuery } from "@/src/server/semantic/executor"
import {
  createSemanticSnapshotRunner,
  type SemanticReadTransaction,
} from "@/src/server/semantic/snapshot"
import { semanticCatalog } from "@/src/server/metrics/registry"

// Migrations, bulk seeding and EXPLAIN ANALYZE share this integration-test
// budget. Query deadlines still apply; latency is measured by the benchmark.
test("new sources use bounded pages, match raw-fact oracles and isolate tenants at scale", async () => {
  const db = await createTracerFixture()
  try {
    const { project, trace, now } = await seedEvalAttributionFacts(db, 1000, 5)
    const timestamp = now.toISOString()
    await db.execute(
      sql`insert into project(id,organization_id,name,slug,created_at,updated_at) select 'foreign-source-project',organization_id,'Foreign','foreign',now(),now() from project where id=${project}`
    )
    await db.execute(
      sql`insert into traces(id,project_id,name,operation,status,started_at) values ('foreign-source-trace','foreign-source-project','Foreign','request','completed',${timestamp})`
    )
    await db.execute(
      sql`insert into spans(id,project_id,trace_id,name,kind,status,started_at,ended_at,attributes_json) select 'large-span-'||i,${project},${trace.id},'Generate','llm','completed',${timestamp},${timestamp},jsonb_build_object('cost.usd',i%7,'gen_ai.response.model','model-'||(i%11)) from generate_series(1,20000) i`
    )
    await db.execute(
      sql`insert into spans(id,project_id,trace_id,name,kind,status,started_at,attributes_json) values ('foreign-span','foreign-source-project','foreign-source-trace','Foreign','llm','completed',${timestamp},'{"cost.usd":9999999}')`
    )
    await db.execute(sql`analyze spans`)
    await db.execute(sql`analyze scores`)
    await db.execute(sql`analyze eval_results`)
    await db.execute(sql`analyze eval_target_attributions`)
    const statements: SQL[] = []
    const runner = createSemanticSnapshotRunner(db)
    const options = {
      catalog: semanticCatalog,
      requestId: "scale",
      snapshotRunner: <T>(
        callback: (snapshot: SemanticReadTransaction, asOf: Date) => Promise<T>
      ) =>
        runner((snapshot, asOf) =>
          callback(
            {
              ...snapshot,
              execute: ((statement: SQL) => {
                statements.push(statement)
                return snapshot.execute(statement)
              }) as typeof snapshot.execute,
            },
            asOf
          )
        ),
    }
    const window = [
      new Date(now.getTime() - 86400000).toISOString(),
      new Date(now.getTime() + 1000).toISOString(),
    ]
    const input = (
      model: string,
      measures: string[],
      dimensions: string[] = []
    ) => ({
      measures: measures.map((m) => `${model}.${m}`),
      dimensions: dimensions.map((d) => `${model}.${d}`),
      timeDimensions: [
        {
          dimension: `${model}.${model === "scoreValues" ? "recordedAt" : model === "evalResults" ? "completedAt" : "startedAt"}`,
          dateRange: window,
        },
      ],
      limit: 3,
      total: true,
    })
    const span = await executeSemanticQuery(
      input("spans", ["costUsd", "spanCount"]),
      options
    )
    const raw = await db.execute(
      sql`select sum(cost_usd) as cost,count(*) as count from spans where project_id=${project} and kind='llm'`
    )
    expect(span.data[0]["spans.costUsd"]).toBe(Number(raw.rows[0].cost))
    expect(span.data[0]["spans.spanCount"]).toBe(20000)
    const results = await executeSemanticQuery(
      input("evalResults", ["executionCount", "meanScore"], ["model"]),
      options
    )
    const rawResults = await db.execute(
      sql`select count(*) as count,avg(s.value) as mean from eval_results r join scores s on s.project_id=r.project_id and s.eval_result_id=r.id where r.project_id=${project}`
    )
    expect(results.meta.page.total).toBe(3)
    expect(
      results.data.reduce(
        (n, r) => n + Number(r["evalResults.executionCount"]),
        0
      )
    ).toBe(Number(rawResults.rows[0].count))
    const ungrouped = await executeSemanticQuery(
      input("evalResults", ["meanScore"]),
      options
    )
    expect(
      Math.abs(
        Number(ungrouped.data[0]["evalResults.meanScore"]) -
          Number(rawResults.rows[0].mean)
      ) < 1e-10
    ).toBe(true)
    const ratings = await executeSemanticQuery(
      input("scoreValues", ["count", "meanValue"]),
      options
    )
    expect(ratings.data[0]["scoreValues.count"]).toBe(5000)
    const page = await executeSemanticQuery(
      {
        ...input("spans", ["costUsd"], ["model"]),
        offset: 3,
        order: [["spans.costUsd", "desc"]],
      },
      options
    )
    expect(page.data).toHaveLength(3)
    expect(page.meta.page.total).toBe(11)
    const plans = []
    for (const statement of statements) {
      const result = await db.execute(
        sql`explain (analyze,buffers,format json) ${statement}`
      )
      plans.push(result.rows[0]["QUERY PLAN"])
    }
    await writeFile(
      "/tmp/datool-five-source-query-plans.json",
      JSON.stringify(plans, null, 2)
    )
    expect(plans.length).toBeGreaterThan(4)
  } finally {
    await closeTracerFixture(db)
  }
}, 60_000)
