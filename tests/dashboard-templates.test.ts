import { expect, test } from "bun:test"
import { semanticQuerySchema } from "@/src/lib/semantic/query"
import {
  blankDashboard,
  dashboardTemplates,
} from "@/src/lib/tracer/dashboard-templates"
import { dashboardInputSchema } from "@/src/lib/tracer/dashboards"
import { semanticCatalog } from "@/src/server/metrics/registry"
import {
  executeSemanticBatch,
  validateSemanticQuery,
} from "@/src/server/semantic/executor"
import { createSemanticSnapshotRunner } from "@/src/server/semantic/snapshot"
import { dashboardQueryPlan } from "@/src/lib/tracer/dashboard-query-plan"
import {
  dashboardFilterScope,
  scopedWidget,
} from "@/src/lib/tracer/dashboard-queries"
import {
  evalRuns,
  evalResults,
  evaluators,
  evaluatorVersions,
  scores,
  traces,
  spans,
} from "@/src/server/tracer/schema"
import { createDashboardService } from "@/src/server/tracer/dashboards"
import { runTracerEffect } from "@/src/server/tracer/effect"
import {
  closeTracerFixture,
  createTracerFixture,
  scopeRows,
} from "./helpers/tracer-fixture"

const now = new Date("2026-09-13T12:00:00Z")

test("every library template is renderable with registered metrics and a fresh seven-day window", () => {
  expect(new Set(dashboardTemplates.map((template) => template.id)).size).toBe(
    dashboardTemplates.length
  )
  for (const template of dashboardTemplates) {
    const config = dashboardInputSchema.parse(template.create(now))
    expect(config.name).toBe(template.name)
    expect(config.description).toBe(template.description)
    expect(config.widgets.length).toBeGreaterThan(0)
    expect(config.defaultWindowDays).toBe(7)
    for (const widget of config.widgets) {
      validateSemanticQuery(widget.query, semanticCatalog)
      expect(widget.query.timeDimensions[0].dateRange).toEqual([
        "2026-09-06T12:00:00.000Z",
        "2026-09-13T12:00:00.000Z",
      ])
      const layout = widget.layout!
      expect(layout).toBeDefined()
      for (const other of config.widgets.filter(
        (item) => item.id !== widget.id
      )) {
        const b = other.layout!
        expect(
          layout.x + layout.w <= b.x ||
            b.x + b.w <= layout.x ||
            layout.y + layout.h <= b.y ||
            b.y + b.h <= layout.y
        ).toBe(true)
      }
    }
  }
})

test("editing a template copy never changes another copy or its future dates", () => {
  for (const template of dashboardTemplates) {
    const first = template.create(now)
    first.name = "My custom dashboard"
    first.widgets[0].title = "Changed widget"
    first.widgets[0].query.measures[0] = "unknown.measure"
    first.widgets[0].query.timeDimensions[0].dateRange[0] =
      "2000-01-01T00:00:00Z"
    const next = template.create(new Date("2026-10-01T12:00:00Z"))
    expect(next.name).toBe(template.name)
    expect(next.widgets[0].title).not.toBe("Changed widget")
    for (const widget of next.widgets) {
      validateSemanticQuery(widget.query, semanticCatalog)
      expect(widget.query.timeDimensions[0].dateRange).toEqual([
        "2026-09-24T12:00:00.000Z",
        "2026-10-01T12:00:00.000Z",
      ])
    }
  }
})

test("blank dashboards have no widgets or inherited template settings", () => {
  expect(dashboardInputSchema.parse(blankDashboard())).toEqual({
    schemaVersion: 1,
    name: "Untitled dashboard",
    description: "",
    widgets: [],
  })
})

test("blank and template configurations persist through the existing dashboard service", async () => {
  const db = await createTracerFixture()
  try {
    const service = createDashboardService(db)
    for (const config of [
      blankDashboard(),
      ...dashboardTemplates.map((template) => template.create(now)),
    ]) {
      const saved = await runTracerEffect(
        service.create({ ...config, name: `Custom ${config.name}` })
      )
      expect(saved.widgets).toEqual(config.widgets)
      expect(saved.defaultWindowDays).toBe(config.defaultWindowDays)
      expect(saved.name).toBe(`Custom ${config.name}`)
      const read = await runTracerEffect(service.get(saved.id))
      expect(read).toEqual(saved)
      // Exercise the actual SQL for summaries, histories, comparisons, and rankings.
      const scope = dashboardFilterScope(
        "startedAt >= -7d",
        now.getTime(),
        "America/Sao_Paulo"
      )
      const plan = dashboardQueryPlan(
        saved.widgets.map((widget) => scopedWidget(widget, scope)),
        {}
      )
      for (const queries of plan.batches) {
        const results = await executeSemanticBatch(
          { queries },
          {
            catalog: semanticCatalog,
            requestId: `template-${saved.id}`,
            snapshotRunner: createSemanticSnapshotRunner(db),
          }
        )
        expect(results).toHaveLength(queries.length)
      }
    }
  } finally {
    await closeTracerFixture(db)
  }
})

test("evaluations dashboard separates failed checks from technical errors and uses result event time", async () => {
  const db = await createTracerFixture()
  const old = "2026-08-01T00:00:00Z"
  const completedAt = "2026-09-12T12:00:00Z"
  try {
    await db.insert(traces).values(
      scopeRows(db, {
        id: "trace",
        name: "Old trace",
        operation: "test",
        status: "completed",
        startedAt: old,
        groupType: "workflow",
        groupName: "Review",
        groupVersion: "v1",
      })
    )
    await db.insert(spans).values(
      scopeRows(
        db,
        [
          {
            id: "agent-1",
            groupType: "agent",
            groupName: "Review",
            groupVersion: "v1",
          },
          {
            id: "agent-repeat",
            groupType: "agent",
            groupName: "Review",
            groupVersion: "v1",
          },
          {
            id: "agent-2",
            groupType: "agent",
            groupName: "Review",
            groupVersion: "v2",
          },
          {
            id: "agent-other",
            groupType: "agent",
            groupName: "Critic",
            groupVersion: null,
          },
          {
            id: "workflow-repeat",
            groupType: "workflow",
            groupName: "Review",
            groupVersion: "v1",
          },
        ].map((membership) => ({
          ...membership,
          traceId: "trace",
          name: "Invocation",
          kind: "custom",
          status: "completed",
          startedAt: old,
        }))
      )
    )
    await db.insert(evaluators).values(
      scopeRows(db, {
        id: "evaluator",
        name: "Correctness",
        createdAt: old,
        updatedAt: old,
      })
    )
    await db.insert(evaluatorVersions).values(
      scopeRows(db, {
        id: "version",
        evaluatorId: "evaluator",
        version: 1,
        language: "javascript",
        code: "return { score: 1 }",
        createdAt: old,
      })
    )
    await db.insert(evalRuns).values(
      scopeRows(db, [
        {
          id: "old-run",
          name: "Old run, new results",
          status: "partial",
          createdAt: old,
          completedAt,
        },
        {
          id: "new-run",
          name: "Recent run",
          status: "completed",
          createdAt: completedAt,
          completedAt,
        },
      ])
    )
    await db.insert(evalResults).values(
      scopeRows(
        db,
        [
          { id: "pass", passed: true, status: "passed", score: 1 },
          { id: "fail", passed: false, status: "failed", score: 0 },
          { id: "error", passed: null, status: "error", score: null },
        ].map((result) => ({
          ...result,
          runId: "old-run",
          traceId: "trace",
          evaluatorId: "evaluator",
          evaluatorVersionId: "version",
          createdAt: old,
          completedAt,
        }))
      )
    )
    await db.insert(scores).values(
      scopeRows(
        db,
        [
          { id: "score-pass", evalResultId: "pass", value: 1 },
          { id: "score-fail", evalResultId: "fail", value: 0 },
        ].map((score) => ({
          ...score,
          traceId: "trace",
          evaluatorId: "evaluator",
          name: "score",
          status: "ok",
          createdAt: completedAt,
        }))
      )
    )
    // Existing saved dashboards keep their original current-membership semantics.
    const config = dashboardInputSchema.parse(
      JSON.parse(
        JSON.stringify(
          dashboardTemplates
            .find((template) => template.id === "evals")!
            .create(now)
        )
          .replaceAll("evalResults.runId", "scores.evalRunId")
          .replaceAll("evalResults.", "scores.")
      )
    )
    const results = await executeSemanticBatch(
      { queries: config.widgets.map((widget) => widget.query) },
      {
        catalog: semanticCatalog,
        requestId: "eval-template",
        snapshotRunner: createSemanticSnapshotRunner(db),
      }
    )
    const result = (id: string) =>
      results[config.widgets.findIndex((widget) => widget.id === id)].data
    expect(result("eval-runs")[0]["evalRuns.count"]).toBe(1)
    expect(result("eval-executions")[0]["scores.executionCount"]).toBe(3)
    expect(result("eval-pass-rate")[0]["scores.explicitPassRate"]).toBe(0.5)
    expect(result("eval-errors")[0]["scores.errorCount"]).toBe(1)
    expect(
      result("eval-fails-by-evaluator")[0]["scores.explicitFailCount"]
    ).toBe(1)
    expect(result("eval-evaluator-results")[0]["scores.meanScore"]).toBe(0.5)
    expect(result("eval-run-results")[0]["scores.evalRunName"]).toBe(
      "Old run, new results"
    )
    const agents = result("eval-results-by-agent")
    expect(
      agents.map((row) => [
        row["scores.groupName"],
        row["scores.groupVersion"],
        row["scores.executionCount"],
        row["scores.explicitPassRate"],
        row["scores.meanScore"],
        row["scores.errorCount"],
      ])
    ).toEqual([
      ["Critic", null, 3, 0.5, 0.5, 1],
      ["Review", "v1", 3, 0.5, 0.5, 1],
      ["Review", "v2", 3, 0.5, 0.5, 1],
    ])
    expect(result("eval-results-by-workflow")).toHaveLength(1)
    expect(result("eval-results-by-workflow")[0]["scores.executionCount"]).toBe(
      3
    )
    expect(
      result("eval-pass-by-agent").map((row) => row["scores.explicitPassRate"])
    ).toEqual([0.5, 0.5])

    // The same execution may match several groups, but totals and names collapsed
    // across versions must still count it only once. Nested filters bind to one membership.
    const base = semanticQuerySchema.parse({
      measures: ["scores.executionCount", "scores.errorCount"],
      timeDimensions: config.widgets[1].query.timeDimensions,
      filters: [
        {
          and: [
            {
              member: "scores.groupType",
              operator: "equals",
              values: ["agent"],
            },
            {
              or: [
                {
                  member: "scores.groupName",
                  operator: "equals",
                  values: ["Review"],
                },
                {
                  member: "scores.groupName",
                  operator: "equals",
                  values: ["Critic"],
                },
              ],
            },
          ],
        },
      ],
    })
    const grouped = semanticQuerySchema.parse({
      ...base,
      dimensions: ["scores.groupName"],
      having: [
        { member: "scores.executionCount", operator: "gt", values: [2] },
      ],
      order: [["scores.groupName", "asc"]],
      limit: 1,
      offset: 1,
      total: true,
    })
    const [total, page, missing] = await executeSemanticBatch(
      {
        queries: [
          base,
          grouped,
          {
            ...base,
            filters: [{ member: "scores.groupVersion", operator: "notSet" }],
            dimensions: ["scores.groupName"],
          },
        ],
      },
      {
        catalog: semanticCatalog,
        requestId: "eval-groups",
        snapshotRunner: createSemanticSnapshotRunner(db),
      }
    )
    expect(total.data[0]["scores.executionCount"]).toBe(3)
    expect(total.data[0]["scores.errorCount"]).toBe(1)
    expect(page.meta.page.total).toBe(2)
    expect(page.data[0]["scores.groupName"]).toBe("Review")
    expect(page.data[0]["scores.executionCount"]).toBe(3)
    expect(missing.data[0]["scores.groupName"]).toBe("Critic")

    await db.insert(traces).values(
      scopeRows(db, {
        id: "ungrouped",
        name: "No membership",
        operation: "test",
        status: "completed",
        startedAt: old,
      })
    )
    await db.insert(evalResults).values(
      scopeRows(db, {
        id: "ungrouped-result",
        traceId: "ungrouped",
        runId: "old-run",
        evaluatorId: "evaluator",
        evaluatorVersionId: "version",
        status: "passed",
        passed: true,
        createdAt: completedAt,
      })
    )
    const [unattributed] = await executeSemanticBatch(
      {
        queries: [
          {
            ...base,
            filters: [{ member: "scores.groupName", operator: "notSet" }],
            dimensions: ["scores.groupType", "scores.groupName"],
          },
        ],
      },
      {
        catalog: semanticCatalog,
        requestId: "eval-ungrouped",
        snapshotRunner: createSemanticSnapshotRunner(db),
      }
    )
    expect(unattributed.data[0]["scores.executionCount"]).toBe(1)
    expect(unattributed.data[0]["scores.groupName"]).toBeNull()
    expect(unattributed.data[0]["scores.groupType"]).toBeNull()
  } finally {
    await closeTracerFixture(db)
  }
})
