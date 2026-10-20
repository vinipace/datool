import { isDashboardDataWidget } from "@/src/lib/tracer/dashboards"
import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { semanticQuerySchema } from "@/src/lib/semantic/query"
import {
  blankDashboard,
  dashboardTemplates,
  agentOverviewWidgets,
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
import { getTracerProjectId } from "@/src/server/tracer/db"
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
    for (const widget of config.widgets.filter(isDashboardDataWidget)) {
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

test("customer experience template scopes real facts, distinct activity, cohort averages and calendar buckets", async () => {
  const db = await createTracerFixture()
  const projectId = getTracerProjectId(db)
  const from = "2026-09-06T12:00:00Z"
  const to = now.toISOString()
  try {
    await db.execute(sql`insert into project(id, organization_id, name, slug, created_at, updated_at)
      select 'other-project', organization_id, 'Other', 'other', created_at, updated_at
      from project where id = ${projectId}`)
    await db.execute(sql`insert into build_agents(id, project_id, slug, name, status, current_revision, applied_revision, current_config_json, applied_config_json, created_at, updated_at)
      values ('agent', ${projectId}, 'support', 'Support', 'active', 1, 1, '{}', '{}', ${from}, ${from})`)
    await db.execute(sql`insert into build_conversations(id, project_id, agent_id, channel, created_at)
      values ('web', ${projectId}, 'agent', 'web', '2026-09-01'), ('telegram', ${projectId}, 'agent', 'telegram', '2026-09-01')`)
    await db.execute(sql`insert into build_operation_events(id, project_id, event_type, conversation_id, contact_id, channel, occurred_at) values
      ('received', ${projectId}, 'message_received', 'web', 'a', 'web', ${from}),
      ('sent', ${projectId}, 'message_sent', 'web', 'a', 'web', '2026-09-07T01:00:00Z'),
      ('handoff', ${projectId}, 'handoff', 'web', 'a', 'web', '2026-09-07T04:00:00Z'),
      ('legacy-handoff', ${projectId}, 'human_handoff', 'telegram', 'a', 'telegram', '2026-09-07T05:00:00Z'),
      ('telegram-message', ${projectId}, 'message_received', 'telegram', 'b', 'telegram', '2026-09-07T06:00:00Z'),
      ('claim', ${projectId}, 'inbox_claimed', 'telegram', 'b', 'telegram', '2026-09-07T07:00:00Z'),
      ('before', ${projectId}, 'message_received', null, 'excluded', 'web', '2026-09-06T11:59:59.999Z'),
      ('end', ${projectId}, 'message_received', null, 'excluded', 'web', ${to}),
      ('foreign', 'other-project', 'message_received', null, 'excluded', 'web', ${from})`)
    await db.execute(sql`insert into build_inbox_tickets(id, project_id, conversation_id, channel, status, created_at, first_response_at) values
      ('solved', ${projectId}, 'web', 'web', 'solved', ${from}, '2026-09-06T12:01:00Z'),
      ('closed', ${projectId}, 'telegram', 'telegram', 'closed', ${from}, '2026-09-06T12:03:00Z'),
      ('open', ${projectId}, 'pending', 'web', 'open', ${from}, null),
      ('old-ticket', ${projectId}, 'old', 'web', 'solved', '2026-09-01', ${from}),
      ('future-ticket', ${projectId}, 'future', 'web', 'solved', ${to}, null),
      ('foreign-ticket', 'other-project', 'foreign', 'web', 'solved', ${from}, ${to})`)
    await db.execute(sql`insert into build_csat_surveys(id, project_id, channel, status, rating, requested_at, responded_at) values
      ('positive', ${projectId}, 'web', 'answered', 5, ${from}, ${from}),
      ('neutral', ${projectId}, 'telegram', 'answered', 3, ${from}, ${from}),
      ('pending', ${projectId}, 'web', 'pending', null, ${from}, null),
      ('old-survey', ${projectId}, 'web', 'answered', 1, '2026-09-01', ${from}),
      ('future-survey', ${projectId}, 'web', 'answered', 1, ${to}, ${to}),
      ('foreign-survey', 'other-project', 'web', 'answered', 1, ${from}, ${from})`)
    const config = dashboardTemplates
      .find((item) => item.id === "customer-experience")!
      .create(now)
    const scope = dashboardFilterScope(
      "startedAt >= -7d",
      now.getTime(),
      "America/Sao_Paulo"
    )
    const queries = config.widgets.map(
      (widget) => scopedWidget(widget, scope).query
    )
    const execute = (queries: unknown[]) =>
      executeSemanticBatch(
        { queries },
        {
          catalog: semanticCatalog,
          requestId: "customer-experience-template",
          snapshotRunner: createSemanticSnapshotRunner(db),
        }
      )
    const results = await execute(queries)
    const result = (id: string) =>
      results[config.widgets.findIndex((widget) => widget.id === id)].data
    expect(result("conversations")[0]["buildEvents.conversationCount"]).toBe(2)
    expect(result("contacts")[0]["buildEvents.contactCount"]).toBe(2)
    expect(result("messages")[0]["buildEvents.messageCount"]).toBe(3)
    expect(result("handoffs")[0]["buildEvents.handoffCount"]).toBe(2)
    expect(result("resolved")[0]["buildTickets.resolvedCount"]).toBe(2)
    expect(
      result("first-response")[0]["buildTickets.meanFirstResponseMs"]
    ).toBe(120000)
    expect(result("csat")[0]["buildCsat.meanRating"]).toBe(4)
    expect(result("csat-responses")[0]["buildCsat.responseCount"]).toBe(2)
    expect(
      result("chats-by-channel").map((row) => [
        row["buildEvents.channel"],
        row["buildEvents.conversationCount"],
      ])
    ).toEqual([
      ["telegram", 1],
      ["web", 1],
    ])
    expect(
      result("channel-activity").map((row) => row["buildEvents.count"])
    ).toEqual([3, 3])
    expect(
      result("message-trend")
        .filter((row) => row["buildEvents.messageCount"])
        .sort((a, b) =>
          String(a["buildEvents.occurredAt"]).localeCompare(
            String(b["buildEvents.occurredAt"])
          )
        )
    ).toEqual([
      { "buildEvents.occurredAt": "2026-09-06", "buildEvents.messageCount": 2 },
      { "buildEvents.occurredAt": "2026-09-07", "buildEvents.messageCount": 1 },
    ])
    expect(
      result("csat-trend").filter((row) => row["buildCsat.meanRating"] !== null)
    ).toHaveLength(1)
    const base = queries.find(
      (query) => query.measures[0] === "buildEvents.contactCount"
    )!
    const [filtered, page, missingCsat] = await execute([
      {
        ...base,
        filters: [
          {
            member: "buildEvents.channel",
            operator: "equals",
            values: ["web"],
          },
        ],
      },
      {
        ...base,
        dimensions: ["buildEvents.channel"],
        order: [["buildEvents.channel", "asc"]],
        limit: 1,
        offset: 1,
        total: true,
      },
      {
        ...queries.find(
          (query) => query.measures[0] === "buildCsat.meanRating"
        )!,
        filters: [
          {
            member: "buildCsat.status",
            operator: "equals",
            values: ["pending"],
          },
        ],
      },
    ])
    expect(filtered.data[0]["buildEvents.contactCount"]).toBe(1)
    expect(page.meta.page.total).toBe(2)
    expect(page.data).toEqual([
      {
        "buildEvents.channel": "web",
        "buildEvents.contactCount": 1,
        "buildEvents.occurredAt": null,
      },
    ])
    expect(missingCsat.data[0]["buildCsat.meanRating"]).toBeNull()

    // An agent overview must keep sibling agents and unlinked project activity out
    // of every metric family, while preserving the shared date window.
    await db.execute(sql`insert into build_agents(id, project_id, slug, name, status, current_revision, applied_revision, current_config_json, applied_config_json, created_at, updated_at)
      values ('sibling', ${projectId}, 'sibling', 'Sibling', 'active', 1, 1, '{}', '{}', ${from}, ${from})`)
    await db.execute(sql`insert into build_conversations(id, project_id, agent_id, channel, created_at)
      values ('sibling-conversation', ${projectId}, 'sibling', 'web', ${from})`)
    await db.execute(sql`insert into build_operation_events(id, project_id, event_type, conversation_id, contact_id, channel, occurred_at) values
      ('sibling-message', ${projectId}, 'message_received', 'sibling-conversation', 'sibling-contact', 'web', ${from}),
      ('sibling-handoff', ${projectId}, 'handoff', 'sibling-conversation', 'sibling-contact', 'web', ${from}),
      ('unlinked-message', ${projectId}, 'message_received', null, 'unlinked-contact', 'web', ${from})`)
    await db.execute(sql`insert into build_inbox_tickets(id, project_id, conversation_id, channel, status, created_at, first_response_at)
      values ('sibling-ticket', ${projectId}, 'sibling-conversation', 'web', 'solved', ${from}, '2026-09-06T12:30:00Z')`)
    await db.execute(sql`update build_csat_surveys set conversation_id = case when channel = 'web' then 'web' else 'telegram' end
      where project_id = ${projectId} and id in ('positive', 'neutral', 'old-survey', 'future-survey')`)
    await db.execute(sql`insert into build_csat_surveys(id, project_id, conversation_id, channel, status, rating, requested_at, responded_at)
      values ('sibling-survey', ${projectId}, 'sibling-conversation', 'web', 'answered', 1, ${from}, ${from})`)
    const widgets = agentOverviewWidgets("agent", now)
    const overview = await execute(
      widgets.map((widget) => scopedWidget(widget, scope).query)
    )
    const value = (id: string, member: string) =>
      overview[widgets.findIndex((widget) => widget.id === id)].data[0][member]
    expect(value("conversations", "buildEvents.conversationCount")).toBe(2)
    expect(value("contacts", "buildEvents.contactCount")).toBe(2)
    expect(value("messages", "buildEvents.messageCount")).toBe(3)
    expect(value("handoffs", "buildEvents.handoffCount")).toBe(2)
    expect(value("resolved", "buildTickets.resolvedCount")).toBe(2)
    expect(value("first-response", "buildTickets.meanFirstResponseMs")).toBe(
      120000
    )
    expect(value("csat", "buildCsat.meanRating")).toBe(4)
    expect(value("csat-responses", "buildCsat.responseCount")).toBe(2)
    for (const [index, widget] of widgets.entries()) {
      if (widget.type === "line" || widget.type === "bar") {
        expect(overview[index].data).toEqual(result(widget.id))
      }
    }
    const emptyWidgets = agentOverviewWidgets("no-conversations", now).filter(
      (widget) => widget.type === "metric"
    )
    const emptyOverview = await execute(
      emptyWidgets.map((widget) => scopedWidget(widget, scope).query)
    )
    expect(
      emptyOverview.map(
        (item, index) => item.data[0][emptyWidgets[index].query.measures[0]]
      )
    ).toEqual([0, 0, 0, 0, 0, null, 0, null])
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
      {
        queries: config.widgets
          .filter(isDashboardDataWidget)
          .map((widget) => widget.query),
      },
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
      timeDimensions: config.widgets.filter(isDashboardDataWidget)[1].query
        .timeDimensions,
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
