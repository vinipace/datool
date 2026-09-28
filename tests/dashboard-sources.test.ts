import { afterAll, beforeAll, expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { sql, eq } from "drizzle-orm"
import {
  createTracerFixture,
  closeTracerFixture,
  scopeRows,
} from "./helpers/tracer-fixture"
import { getTracerProjectId, type TracerDatabase } from "@/src/server/tracer/db"
import {
  traces,
  spans,
  evaluators,
  evaluatorVersions,
  evalRuns,
  evalRunTargets,
  evalRunEvaluators,
  evalResults,
  scores,
  scoreImports,
  humanScores,
  reviewSessions,
  reviewItems,
  reviewScores,
} from "@/src/server/tracer/schema"
import { semanticCatalog } from "@/src/server/metrics/registry"
import { executeSemanticQuery } from "@/src/server/semantic/executor"
import { createSemanticSnapshotRunner } from "@/src/server/semantic/snapshot"
import { calendarBuckets } from "@/src/server/metrics/logs-sql"
import { metricWindow } from "@/src/server/metrics/common"
import { semanticQuerySchema } from "@/src/lib/semantic/query"
import { dashboardTemplates } from "@/src/lib/tracer/dashboard-templates"
import { previewDashboardSourceMigration } from "@/src/lib/tracer/dashboard-source-migration"

const from = "2026-03-08T00:00:00Z",
  to = "2026-03-10T00:00:00Z"
let db: TracerDatabase
const query = (
  model: string,
  measures: string[],
  extra: Record<string, unknown> = {}
) =>
  executeSemanticQuery(
    {
      measures: measures.map((m) => `${model}.${m}`),
      timeDimensions: [
        {
          dimension: `${model}.${model === "evalRuns" ? "createdAt" : model === "evalResults" ? "completedAt" : model === "scoreValues" ? "recordedAt" : "startedAt"}`,
          dateRange: [from, to],
        },
      ],
      ...extra,
    },
    {
      catalog: semanticCatalog,
      requestId: "five-sources",
      snapshotRunner: createSemanticSnapshotRunner(db),
    }
  )
beforeAll(async () => {
  db = await createTracerFixture()
  await db.insert(traces).values(
    scopeRows(db, [
      {
        id: "t1",
        name: "Request",
        operation: "workflow",
        status: "completed",
        startedAt: from,
        endedAt: "2026-03-08T00:00:10Z",
        attributesJson: JSON.stringify({ "user.id": "u1", "cost.usd": 999 }),
      },
      {
        id: "t2",
        name: "Other",
        operation: "workflow",
        status: "completed",
        startedAt: from,
      },
    ])
  )
  await db.insert(spans).values(
    scopeRows(db, [
      {
        id: "root",
        traceId: "t1",
        name: "Agent",
        kind: "agent",
        groupType: "agent",
        groupName: "Agent",
        groupVersion: "v2",
        status: "completed",
        startedAt: from,
        endedAt: "2026-03-08T00:00:05Z",
      },
      ...[2, 0, 3, null].map((cost, i) => ({
        id: `s${i}`,
        parentId: "root",
        traceId: "t1",
        name: "Generate",
        kind: "llm",
        status: i === 3 ? "errored" : "completed",
        startedAt: i === 2 ? "2026-03-10T00:00:01Z" : "2026-03-08T00:00:01Z",
        endedAt: i === 2 ? "2026-03-10T00:00:02Z" : "2026-03-08T00:00:02Z",
        attributesJson: JSON.stringify({
          "gen_ai.response.model": i % 2 ? "Beta" : "Alpha",
          "cost.usd": cost,
          "gen_ai.usage.input_tokens": 10,
          "gen_ai.usage.output_tokens": 2,
          "datool.execution.role": i === 0 ? "workload" : undefined,
        }),
      })),
      {
        id: "judge",
        traceId: "t2",
        name: "Judge",
        kind: "score",
        status: "completed",
        startedAt: from,
      },
      {
        id: "judge-call",
        parentId: "judge",
        traceId: "t2",
        name: "Generate",
        kind: "llm",
        status: "completed",
        startedAt: from,
        attributesJson: JSON.stringify({ "cost.usd": 0 }),
      },
    ])
  )
  await db.insert(evaluators).values(
    scopeRows(
      db,
      ["a", "b"].map((id) => ({
        id,
        name: `Scorer ${id}`,
        createdAt: from,
        updatedAt: from,
      }))
    )
  )
  await db.insert(evaluatorVersions).values(
    scopeRows(
      db,
      ["a", "b"].map((id) => ({
        id: `${id}-v1`,
        evaluatorId: id,
        version: 1,
        language: "javascript",
        code: "return {score:1}",
        createdAt: from,
      }))
    )
  )
  await db.insert(evalRuns).values(
    scopeRows(db, [
      {
        id: "r",
        name: "Batch",
        status: "partial",
        createdAt: from,
        completedAt: "2026-03-08T00:00:10Z",
      },
      { id: "old", status: "completed", createdAt: from },
    ])
  )
  await db.insert(evalRunEvaluators).values(
    scopeRows(
      db,
      ["a", "b"].map((id) => ({
        id: `selected-${id}`,
        runId: "r",
        evaluatorId: id,
        evaluatorVersionId: `${id}-v1`,
      }))
    )
  )
  await db.insert(evalRunTargets).values(
    scopeRows(
      db,
      ["c1", "c2"].map((id, i) => ({
        id,
        runId: "r",
        traceId: "t1",
        ordinal: i,
        createdAt: from,
        snapshotJson: JSON.stringify({ metadata: { region: "br" } }),
      }))
    )
  )
  const results = [
    {
      id: "r1",
      targetId: "c1",
      evaluatorId: "a",
      score: 0,
      passed: false,
      status: "failed",
    },
    {
      id: "r2",
      targetId: "c1",
      evaluatorId: "b",
      score: null,
      passed: null,
      status: "error",
    },
    {
      id: "r3",
      targetId: "c2",
      evaluatorId: "a",
      score: 1,
      passed: true,
      status: "passed",
    },
    {
      id: "r4",
      targetId: null,
      evaluatorId: "a",
      score: 0.5,
      passed: null,
      status: "completed",
    },
  ]
  await db.insert(evalResults).values(
    scopeRows(
      db,
      results.map((r) => ({
        ...r,
        runId: r.id === "r4" ? "old" : "r",
        traceId: "t1",
        evaluatorVersionId: `${r.evaluatorId}-v1`,
        createdAt: from,
        completedAt: from,
      }))
    )
  )
  await db.insert(scores).values(
    scopeRows(
      db,
      results
        .filter((r) => r.score !== null)
        .map((r) => ({
          id: `score-${r.id}`,
          traceId: "t1",
          evalResultId: r.id,
          evaluatorId: r.evaluatorId,
          name: "score",
          value: r.score,
          status: "ok",
          createdAt: from,
        }))
    )
  )
  const project = getTracerProjectId(db)
  await db.execute(
    sql`insert into eval_target_attributions(id,project_id,run_id,target_id,group_type,group_name,group_version,models_json,source_trace_id) values ('attr1',${project},'r','c1','agent','Agent','v1','["Alpha","Beta"]','t1'),('attr2',${project},'r','c1','workflow','Workflow','v1','["Alpha","Beta"]','t1'),('attr3',${project},'r','c2','agent','Agent','v2','["Alpha"]','t1')`
  )
  for (const [id, type, value] of [
    ["numeric", "numeric", 80],
    ["boolean", "boolean", true],
    ["categorical", "categorical", "good"],
    ["text", "text", "External comment"],
  ] as const) {
    await db.insert(scoreImports).values(
      scopeRows(db, {
        id,
        payload: {},
        status: "imported",
        createdAt: from,
        updatedAt: from,
      })
    )
    await db.insert(scores).values(
      scopeRows(db, {
        id: `import-${id}`,
        traceId: "t1",
        importId: id,
        name: "Imported",
        value: type === "numeric" ? 80 : null,
        status: "ok",
        createdAt: from,
        external: {
          name: "Imported",
          timestamp: from,
          target: { type: "trace", id: "t1" },
          data: { type, value },
          source: { provider: "test", instance: "test", projectId: "p", id },
        } as never,
      })
    )
  }
  await db
    .insert(reviewSessions)
    .values(scopeRows(db, { id: "review", createdAt: from, updatedAt: from }))
  await db.insert(reviewItems).values(
    scopeRows(db, {
      id: "item",
      sessionId: "review",
      traceId: "t1",
      ordinal: 0,
    })
  )
  for (const [id, definition, value, source] of [
    [
      "category",
      {
        type: "categorical",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
        multiple: true,
      },
      ["a", "b"],
      "human",
    ],
    ["text", { type: "text", maxLength: 4000 }, "Useful comment", "api"],
    ["rating", { type: "numeric", min: 1, max: 5, step: 1 }, 4, "mcp"],
  ] as const) {
    await db.insert(humanScores).values(
      scopeRows(db, {
        id,
        name: id,
        configJson: JSON.stringify(definition),
        createdAt: from,
        updatedAt: from,
      })
    )
    await db.insert(reviewScores).values(
      scopeRows(db, {
        id: `review-${id}`,
        itemId: "item",
        traceId: "t1",
        criterionKey: id,
        humanScoreId: id,
        name: id,
        definitionJson: JSON.stringify(definition),
        humanValue: JSON.stringify(value),
        source,
        updatedAt: from,
      })
    )
  }
})
afterAll(async () => {
  if (db) await closeTracerFixture(db)
})

test("catalog includes classification and paired sources and keeps every legacy identity", () => {
  const models = semanticCatalog.metadata().models
  expect(
    models
      .filter((m) => m.source?.visibility === "primary")
      .sort((a, b) => a.source!.order! - b.source!.order!)
      .map((m) => m.source!.title)
  ).toEqual([
    "Traces",
    "Spans",
    "Evaluation Runs",
    "Evaluation Results",
    "Scores",
    "Classification",
    "Paired evaluations",
  ])
  for (const legacy of ["logs", "scores", "evalQuality", "agents", "workflows"])
    expect(semanticCatalog.getModel(legacy)).toBeDefined()
  for (const template of dashboardTemplates)
    for (const w of template.create().widgets)
      for (const m of [...w.query.measures, ...w.query.dimensions])
        expect(semanticCatalog.getMember(m)).toBeDefined()
})
test("span/request populations, costs, duration and recovered failures use independent facts", async () => {
  const s = await query(
    "spans",
    [
      "spanCount",
      "llmCount",
      "pricedLlmCount",
      "unpricedLlmCount",
      "costUsd",
      "erroredCount",
      "meanDurationMs",
    ],
    {
      filters: [
        { member: "spans.traceId", operator: "equals", values: ["t1"] },
      ],
    }
  )
  expect(s.data[0]).toMatchObject({
    "spans.spanCount": 4,
    "spans.llmCount": 3,
    "spans.pricedLlmCount": 2,
    "spans.unpricedLlmCount": 1,
    "spans.costUsd": 2,
    "spans.erroredCount": 1,
    "spans.meanDurationMs": 2000,
  })
  const t = await query(
    "traces",
    [
      "count",
      "llmCount",
      "costUsd",
      "costCoverage",
      "reportedCostUsd",
      "erroredCount",
      "meanDurationMs",
      "uniqueUserCount",
    ],
    {
      filters: [
        { member: "traces.parent.id", operator: "equals", values: ["t1"] },
      ],
    }
  )
  expect(t.data[0]).toMatchObject({
    "traces.count": 1,
    "traces.llmCount": 4,
    "traces.costUsd": 5,
    "traces.costCoverage": 0.75,
    "traces.reportedCostUsd": 999,
    "traces.erroredCount": 0,
    "traces.meanDurationMs": 10000,
    "traces.uniqueUserCount": 1,
  })
  const roles = await query("spans", ["llmCount"], {
    dimensions: ["spans.executionRole"],
  })
  expect(
    roles.data.find((r) => r["spans.executionRole"] === "scorer")?.[
      "spans.llmCount"
    ]
  ).toBe(1)
  const owner = await query("spans", ["costUsd"], {
    dimensions: ["spans.agentName", "spans.agentVersion"],
  })
  expect(
    owner.data.find((r) => r["spans.agentName"] === "Agent")
  ).toMatchObject({ "spans.agentVersion": "v2", "spans.costUsd": 2 })
})
test("result totals include unattributed history without duplicating nested memberships", async () => {
  const r = await query("evalResults", [
    "executionCount",
    "scoredCount",
    "meanScore",
    "errorCount",
    "explicitFailCount",
    "explicitPassRate",
    "attributionCoverage",
  ])
  expect(r.data[0]).toMatchObject({
    "evalResults.executionCount": 4,
    "evalResults.scoredCount": 3,
    "evalResults.meanScore": 0.5,
    "evalResults.errorCount": 1,
    "evalResults.explicitFailCount": 1,
    "evalResults.explicitPassRate": 0.5,
    "evalResults.attributionCoverage": 0.75,
  })
  const grouped = await query("evalResults", ["executionCount"], {
    dimensions: ["evalResults.model"],
  })
  expect(
    grouped.data.reduce(
      (n, r) => n + Number(r["evalResults.executionCount"]),
      0
    )
  ).toBe(4)
  expect(
    grouped.data.find((r) => r["evalResults.model"] === "Multiple models")?.[
      "evalResults.executionCount"
    ]
  ).toBe(2)
  expect(
    grouped.data.find((r) => r["evalResults.model"] === null)?.[
      "evalResults.executionCount"
    ]
  ).toBe(1)
  const filtered = await query("evalResults", ["executionCount"], {
    filters: [
      { member: "evalResults.agent", operator: "equals", values: ["Agent"] },
    ],
  })
  expect(filtered.data[0]["evalResults.executionCount"]).toBe(3)
})
test("run coverage counts targets once and excludes incomplete historical linkage", async () => {
  const r = await query("evalRuns", [
    "count",
    "resultCount",
    "selectedTargetCount",
    "executedCaseCount",
    "completedCaseCount",
    "executionCoverage",
    "completionCoverage",
    "coverageEligibleRunCount",
    "meanDurationMs",
  ])
  expect(r.data[0]).toMatchObject({
    "evalRuns.count": 2,
    "evalRuns.resultCount": 4,
    "evalRuns.selectedTargetCount": 2,
    "evalRuns.executedCaseCount": 2,
    "evalRuns.completedCaseCount": 1,
    "evalRuns.executionCoverage": 1,
    "evalRuns.completionCoverage": 0.5,
    "evalRuns.coverageEligibleRunCount": 1,
    "evalRuns.meanDurationMs": 10000,
  })
  const old = await query(
    "evalRuns",
    ["executionCoverage", "completedCaseCount"],
    {
      filters: [{ member: "evalRuns.id", operator: "equals", values: ["old"] }],
    }
  )
  expect(old.data[0]["evalRuns.executionCoverage"]).toBeNull()
  expect(old.data[0]["evalRuns.completedCaseCount"]).toBeNull()
})
test("ratings union preserves types, provenance, scales and current review state", async () => {
  const r = await query("scoreValues", [
    "count",
    "numericCount",
    "booleanCount",
    "categoricalCount",
    "textCount",
    "trueRate",
  ])
  expect(r.data[0]).toMatchObject({
    "scoreValues.count": 10,
    "scoreValues.numericCount": 5,
    "scoreValues.booleanCount": 1,
    "scoreValues.categoricalCount": 2,
    "scoreValues.textCount": 2,
    "scoreValues.trueRate": 1,
  })
  await rejects(
    query("scoreValues", ["meanValue"]),
    /different definitions or scales/
  )
  const grouped = await query("scoreValues", ["meanValue"], {
    dimensions: ["scoreValues.definitionId"],
  })
  expect(grouped.data.some((r) => r["scoreValues.meanValue"] === 80)).toBe(true)
  expect(grouped.data.some((r) => r["scoreValues.meanValue"] === 4)).toBe(true)
  const categories = await query("scoreValues", ["count"], {
    dimensions: ["scoreValues.category"],
    filters: [
      {
        member: "scoreValues.type",
        operator: "equals",
        values: ["categorical"],
      },
    ],
  })
  expect(
    categories.data.reduce((n, r) => n + Number(r["scoreValues.count"]), 0)
  ).toBe(3)
  const author = await query("scoreValues", ["count"], {
    dimensions: ["scoreValues.authorType"],
  })
  expect(
    author.data.find((r) => r["scoreValues.authorType"] === "mcp")?.[
      "scoreValues.count"
    ]
  ).toBe(1)
  await db
    .update(reviewScores)
    .set({ humanValue: "5", updatedAt: "2026-03-09T00:00:00Z" })
    .where(eq(reviewScores.id, "review-rating"))
  const after = await query("scoreValues", ["count", "meanValue"], {
    filters: [
      {
        member: "scoreValues.id",
        operator: "equals",
        values: ["review:review-rating"],
      },
    ],
  })
  expect(after.data[0]).toMatchObject({
    "scoreValues.count": 1,
    "scoreValues.meanValue": 5,
  })
})
test("calendar grains respect DST and ISO Monday boundaries", () => {
  const buckets = (grain: string, range: string[]) =>
    calendarBuckets(
      metricWindow(
        semanticQuerySchema.parse({
          measures: ["spans.spanCount"],
          timeDimensions: [
            {
              dimension: "spans.startedAt",
              dateRange: range,
              granularity: grain,
            },
          ],
          timezone: "America/New_York",
        }),
        "spans.startedAt"
      )
    )
  const days = buckets("day", ["2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"])
  expect(days).toHaveLength(1)
  expect(days[0].to - days[0].from).toBe(23 * 3600000)
  expect(
    buckets("week", ["2026-03-08T05:00:00Z", "2026-03-10T04:00:00Z"]).map(
      (b) => b.day
    )
  ).toEqual(["2026-03-02", "2026-03-09"])
  expect(
    buckets("month", ["2026-03-31T04:00:00Z", "2026-04-02T04:00:00Z"]).map(
      (b) => b.day
    )
  ).toEqual(["2026-03-01", "2026-04-01"])
})
test("migration is an explicit proposal and mixed latency cannot silently change population", () => {
  const w = dashboardTemplates
    .find((t) => t.id === "cost-and-usage")!
    .create()
    .widgets.find((w) => w.id === "cost-by-model")!
  const old = JSON.parse(JSON.stringify(w).replaceAll("spans.", "logs."))
  const preview = previewDashboardSourceMigration(
    old,
    semanticCatalog.metadata().models
  )!
  expect(preview.unsupported).toEqual([])
  expect(old.query.measures).toEqual(["logs.costUsd"])
  expect(preview.after.measures).toEqual(["spans.costUsd"])
  old.query.measures.push("logs.meanLatencyMs")
  expect(
    previewDashboardSourceMigration(old, semanticCatalog.metadata().models)!
      .unsupported.length
  ).toBeGreaterThan(0)
})

test("related filters and typed metadata narrow facts without multiplying them", async () => {
  const related = await query("traces", ["count"], {
    filters: [{ member: "traces.scorerId", operator: "equals", values: ["a"] }],
  })
  expect(related.data[0]["traces.count"]).toBe(1)
  const sample = (value: string | number) =>
    query("spans", ["spanCount"], {
      filters: [
        {
          member: "spans.metadata",
          path: ["gen_ai.usage.input_tokens"],
          operator: "equals",
          values: [value],
        },
      ],
    })
  expect((await sample(10)).data[0]["spans.spanCount"]).toBe(3)
  expect((await sample("10")).data[0]["spans.spanCount"]).toBe(0)
  const frozen = await query("evalResults", ["executionCount"], {
    filters: [
      {
        member: "evalResults.caseMetadata",
        path: ["metadata", "region"],
        operator: "equals",
        values: ["br"],
      },
    ],
  })
  expect(frozen.data[0]["evalResults.executionCount"]).toBe(3)
  const empty = await query("scoreValues", ["count", "meanValue", "trueRate"], {
    filters: [
      { member: "scoreValues.id", operator: "equals", values: ["missing"] },
    ],
  })
  expect(empty.data[0]).toMatchObject({
    "scoreValues.count": 0,
    "scoreValues.meanValue": null,
    "scoreValues.trueRate": null,
  })
})

test("rated span identities include the trace even when span IDs are reused", async () => {
  for (const [id, traceId] of [
    ["span-rating-1", "t1"],
    ["span-rating-2", "t2"],
    ["span-rating-3", "t1"],
  ]) {
    await db.insert(scoreImports).values(
      scopeRows(db, {
        id,
        payload: {},
        status: "imported",
        createdAt: from,
        updatedAt: from,
      })
    )
    await db.insert(scores).values(
      scopeRows(db, {
        id,
        traceId,
        importId: id,
        name: "Span rating",
        status: "ok",
        createdAt: from,
        external: {
          target: { type: "span", id: "reused-span", traceId },
          data: { type: "text", value: "Reviewed" },
        } as never,
      })
    )
  }
  const result = await query("scoreValues", ["count", "uniqueTargetCount"], {
    filters: [
      {
        member: "scoreValues.name",
        operator: "equals",
        values: ["Span rating"],
      },
    ],
  })
  expect(result.data[0]).toMatchObject({
    "scoreValues.count": 3,
    "scoreValues.uniqueTargetCount": 2,
  })
})
