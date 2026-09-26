import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"
import { seedEvalAttributionFacts } from "./helpers/eval-attribution-fixture"
import { saveEvalAttributions } from "../src/server/tracer/eval-attribution"
import { TracerService } from "../src/server/tracer/service"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import { readTelemetry } from "../src/server/semantic/telemetry"
import { createSemanticSnapshotRunner } from "../src/server/semantic/snapshot"
import {
  executeSemanticBatch,
  executeSemanticQuery,
} from "../src/server/semantic/executor"
import { semanticCatalog } from "../src/server/metrics/registry"
import { dashboardTemplates } from "../src/lib/tracer/dashboard-templates"
import { dashboardQueryPlan } from "../src/lib/tracer/dashboard-query-plan"

// A real database fixture verifies counts, pagination, constraints and planner
// equivalence; timing is deliberately measured separately, never asserted here.
test("full-history grouping, bulk attribution and fused dashboard queries preserve results", async () => {
  const db = await createTracerFixture()
  try {
    const { project, trace, now } = await seedEvalAttributionFacts(db, 300)
    const service = new TracerService(db)
    expect(
      (await run(service.listEvalRuns({ limit: 50 }))).items.some(
        (r) => r.id === "run-1"
      )
    ).toBe(false)
    const groups = await run(
      service.listEvalRunGroups({
        groupBy: "workflow",
        includeTotal: true,
        limit: 2,
      })
    )
    expect(groups.total).toBe(9)
    const all = [...groups.items]
    let cursor = groups.nextCursor
    while (cursor) {
      const page = await run(
        service.listEvalRunGroups({ groupBy: "workflow", cursor, limit: 2 })
      )
      all.push(...page.items)
      cursor = page.nextCursor
    }
    expect(all).toHaveLength(9)
    expect(new Set(all.map((g) => g.id)).size).toBe(9)
    const rare = all.find((g) => g.name === "Rare workflow")!
    expect(rare.runCount).toBe(1)
    expect(
      (await run(service.listEvalRuns({ filter: rare.filter }))).items.map(
        (r) => r.id
      )
    ).toEqual(["run-1"])
    // Versions never duplicate a run's count, and group names don't collide with missing buckets.
    await db.execute(sql`insert into eval_run_groups(id,project_id,run_id,group_type,group_name,group_version)
      values('extra-version',${project},'run-1','workflow','Rare workflow','2'),('named-unassigned',${project},'run-1','workflow','Unassigned',null)`)
    await db.execute(
      sql`delete from eval_run_groups where project_id=${project} and run_id in ('run-2','run-3')`
    )
    await db.execute(
      sql`update eval_runs set groups_resolved_at=null where project_id=${project} and id='run-2'`
    )
    const filtered = await run(
      service.listEvalRunGroups({
        groupBy: "workflow",
        filter: 'id : "run-"',
        limit: 50,
      })
    )
    expect(
      filtered.items.find((g) => g.name === "Rare workflow")?.runCount
    ).toBe(1)
    expect(
      filtered.items.filter(
        (g) => g.name === "Unassigned" || g.state !== "assigned"
      )
    ).toHaveLength(3)
    for (const group of filtered.items) {
      expect(
        (
          await run(
            service.listEvalRuns({
              filter: group.filter,
              includeTotal: true,
              limit: 1,
            })
          )
        ).total
      ).toBe(group.runCount)
    }
    let rejected = false
    try {
      await db.execute(
        sql`update eval_results set target_id='target-2-1' where project_id=${project} and id='result-target-1-1'`
      )
    } catch (error) {
      expect(
        (error as { cause: { constraint: string } }).cause.constraint
      ).toBe("eval_results_project_run_target_fk")
      rejected = true
    }
    expect(rejected).toBe(true)

    await db.execute(sql`insert into eval_run_targets(id,project_id,run_id,trace_id,ordinal,created_at)
      select 'bulk-' || i,${project},'run-1',${trace.id},100+i,${now.toISOString()} from generate_series(1,1001) i`)
    const original = db.execute.bind(db)
    let writes = 0
    db.execute = ((...args: Parameters<typeof db.execute>) => {
      writes++
      return original(...args)
    }) as typeof db.execute
    try {
      await saveEvalAttributions(
        db,
        "run-1",
        Array.from({ length: 1001 }, (_, i) => ({
          targetId: `bulk-${i + 1}`,
          attributions: [
            {
              group: { type: "workflow", name: "Bulk workflow" },
              models: ["Model X"],
              sourceTraceId: trace.id,
              sourceSpanId: null,
            },
            {
              group: { type: "agent", name: "Bulk agent" },
              models: ["Model X"],
              sourceTraceId: trace.id,
              sourceSpanId: null,
            },
          ],
        }))
      )
      expect(writes).toBe(4) // one group batch + three bounded attribution batches
    } finally {
      db.execute = original
    }
    expect(
      (
        await db.execute(
          sql`select count(*)::integer as n from eval_target_attributions where project_id=${project} and target_id like 'bulk-%'`
        )
      ).rows[0].n
    ).toBe(2002)

    const widgets = dashboardTemplates
      .find((t) => t.id === "eval-quality-by-model")!
      .create(new Date(now.getTime() + 1000)).widgets
    const queries = dashboardQueryPlan(widgets, {}).batches.flat()
    expect(queries).toHaveLength(16)
    const options = {
      catalog: semanticCatalog,
      requestId: "fusion-test",
      snapshotRunner: createSemanticSnapshotRunner(db),
    }
    let statements = 0
    const count = () => statements++
    readTelemetry.subscribe(count)
    let fused
    try {
      fused = await executeSemanticBatch({ queries }, options)
    } finally {
      readTelemetry.unsubscribe(count)
    }
    expect(statements).toBe(7)
    for (const [index, query] of queries.entries()) {
      const [single] = await executeSemanticBatch({ queries: [query] }, options)
      expect(fused[index].data).toEqual(single.data)
      expect(fused[index].meta.page).toEqual(single.meta.page)
      expect(fused[index].meta.quality).toEqual(single.meta.quality)
    }
    // Differing order, limits, offsets and thresholds cannot share a time-series page.
    const daily = queries[2]
    const variants = [
      daily,
      { ...daily, order: [["evalResults.completedAt", "desc"]], limit: 1 },
      { ...daily, offset: 1, limit: 1 },
      {
        ...daily,
        having: [{ member: daily.measures[0], operator: "gt", values: [0.2] }],
      },
    ]
    const variantResults = await executeSemanticBatch(
      { queries: variants },
      options
    )
    for (const [i, query] of variants.entries())
      expect(variantResults[i].data).toEqual(
        (await executeSemanticBatch({ queries: [query] }, options))[0].data
      )
  } finally {
    await closeTracerFixture(db)
  }
}, 60_000)

test("equal evaluation averages keep the same ranking and pages across aggregate plans", async () => {
  const db = await createTracerFixture()
  try {
    const { now } = await seedEvalAttributionFacts(db, 300)
    const runner = createSemanticSnapshotRunner(db)
    const input = {
      measures: ["evalResults.meanScore"],
      dimensions: ["evalResults.groupName"],
      filters: [
        {
          member: "evalResults.groupType",
          operator: "equals",
          values: ["workflow"],
        },
        {
          member: "evalResults.model",
          operator: "equals",
          values: ["Model 2"],
        },
      ],
      timeDimensions: [
        {
          dimension: "evalResults.completedAt",
          dateRange: [
            new Date(now.getTime() - 86400000).toISOString(),
            new Date(now.getTime() + 1000).toISOString(),
          ],
        },
      ],
      order: [["evalResults.meanScore", "desc"]],
      limit: 3,
      total: true,
    }
    // Every workflow has equal numbers of 0.2 and 0.5 scores, but different
    // sample counts. Float accumulation must not decide their rank or page.
    for (const hashAggregate of [true, false]) {
      const groups = []
      for (const offset of [0, 3, 6]) {
        const result = await executeSemanticQuery(
          { ...input, offset },
          {
            catalog: semanticCatalog,
            requestId: `stable-rank-${hashAggregate}-${offset}`,
            snapshotRunner: (callback) =>
              runner(async (snapshot, asOf) => {
                await snapshot.execute(
                  hashAggregate
                    ? sql`set local enable_hashagg = on`
                    : sql`set local enable_hashagg = off`
                )
                return callback(snapshot, asOf)
              }),
          }
        )
        expect(result.meta.page.total).toBe(9)
        expect(result.data).toHaveLength(3)
        for (const row of result.data) {
          expect(row["evalResults.meanScore"]).toBe(0.35)
          groups.push(row["evalResults.groupName"])
        }
      }
      expect(groups).toEqual([
        "Rare workflow",
        ...Array.from({ length: 8 }, (_, index) => `Workflow ${index}`),
      ])
    }
  } finally {
    await closeTracerFixture(db)
  }
}, 60_000)
