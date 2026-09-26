import { expect, test } from "bun:test"
import {
  closeTracerFixture,
  createTracerFixture,
  scopeRows,
} from "./helpers/tracer-fixture"
import { traces, spans } from "@/src/server/tracer/schema"
import { semanticCatalog } from "@/src/server/metrics/registry"
import { executeSemanticQuery } from "@/src/server/semantic/executor"
import { createSemanticSnapshotRunner } from "@/src/server/semantic/snapshot"
import { semanticQuerySchema } from "@/src/lib/semantic/query"
import { dashboardWidgetSchema } from "@/src/lib/tracer/dashboards"
import { dashboardQueryPlan } from "@/src/lib/tracer/dashboard-query-plan"

const from = "2026-09-07T00:00:00Z"
const to = "2026-09-08T00:00:00Z"
const base = {
  measures: [
    "logs.costUsd",
    "logs.llmCount",
    "logs.pricedLlmCount",
    "logs.unpricedLlmCount",
    "logs.costCoverage",
    "logs.meanLlmCostUsd",
  ],
  timeDimensions: [{ dimension: "logs.startedAt", dateRange: [from, to] }],
  having: [{ member: "logs.llmCount", operator: "gt", values: [0] }],
  total: true,
}

test("semantic cost ownership reconciles nested groups, old parents, reused SDK spans, and missing prices", async () => {
  const db = await createTracerFixture()
  try {
    await db.insert(traces).values(
      scopeRows(
        db,
        [
          {
            id: "batch",
            name: "Batch",
            groupType: "workflow",
            groupName: "batch-workflow",
          },
          {
            id: "other",
            name: "Other",
            groupType: "agent",
            groupName: "fallback-agent",
          },
          { id: "orphan", name: "Orphan" },
        ].map((row) => ({
          ...row,
          operation: "workflow",
          status: "completed",
          startedAt: from,
        }))
      )
    )
    const span = (id: string, parentId: string | null, extra = {}) => ({
      id,
      traceId: "batch",
      parentId,
      name: id,
      kind: "function",
      status: "completed",
      startedAt: from,
      ...extra,
    })
    const llm = (
      id: string,
      parentId: string | null,
      cost: number | null,
      extra = {}
    ) =>
      span(id, parentId, {
        name: "ai.generateObject.doGenerate",
        kind: "llm",
        attributesJson: JSON.stringify(
          cost === null ? { "cost.status": "missing" } : { "cost.usd": cost }
        ),
        ...extra,
      })
    await db.insert(spans).values(
      scopeRows(db, [
        // Attribution follows ancestors even when they started outside the cost window.
        span("outer", null, {
          kind: "workflow",
          groupType: "workflow",
          groupName: "outer-workflow",
          startedAt: "2026-09-06T23:00:00Z",
        }),
        span("enrich", "outer", {
          kind: "workflow",
          groupType: "workflow",
          groupName: "enrich-workflow",
        }),
        span("step", "enrich", { kind: "task", name: "enrichPromptRun" }),
        span("agent", "step", {
          kind: "agent",
          groupType: "agent",
          groupName: "brand-agent",
        }),
        span("fn", "agent", {
          name: "extract-mentioned-brands",
          attributesJson: '{"cost.usd":900}',
        }),
        span("sdk", "fn", { name: "ai.generateObject" }),
        llm("paid", "sdk", 2),
        llm("free", "sdk", 0),
        llm("missing", "sdk", null),
        llm("partial", "sdk", null, {
          attributesJson: '{"cost.usd":200,"cost.status":"partial"}',
        }),
        llm("explicit", "sdk", 3, {
          attributesJson:
            '{"cost.usd":3,"ai.telemetry.functionId":"find-brand-domains"}',
        }),
        llm("fallback", null, 1, { traceId: "other" }),
        // Missing context remains a visible, additive unattributed bucket.
        llm("unattributed", null, 4, { traceId: "orphan" }),
        // Cycles terminate and an older legacy function ID is still recognized.
        span("cycle", "cycle", {
          traceId: "orphan",
          attributesJson: '{"ai.functionId":"legacy-function"}',
        }),
        llm("cycle-llm", "cycle", null, { traceId: "orphan" }),
        llm("outside", "sdk", 100, { startedAt: to }),
      ])
    )
    const execute = (input: unknown) =>
      executeSemanticQuery(input, {
        catalog: semanticCatalog,
        requestId: "attribution-test",
        snapshotRunner: createSemanticSnapshotRunner(db),
      })
    const functions = await execute({
      ...base,
      dimensions: ["logs.functionName"],
      order: [
        ["logs.costUsd", "desc"],
        ["logs.functionName", "asc"],
      ],
    })
    expect(
      functions.data.find(
        (row) => row["logs.functionName"] === "extract-mentioned-brands"
      )
    ).toMatchObject({
      "logs.costUsd": 2,
      "logs.llmCount": 4,
      "logs.pricedLlmCount": 2,
      "logs.unpricedLlmCount": 2,
      "logs.costCoverage": 0.5,
      "logs.meanLlmCostUsd": 1,
    })
    expect(
      functions.data.find(
        (row) => row["logs.functionName"] === "legacy-function"
      )
    ).toMatchObject({
      "logs.costUsd": null,
      "logs.costCoverage": 0,
      "logs.meanLlmCostUsd": null,
    })
    expect(functions.data.map((row) => row["logs.functionName"])).toContain(
      "fallback-agent"
    )
    expect(
      functions.data.find((row) => row["logs.functionName"] === null)?.[
        "logs.costUsd"
      ]
    ).toBe(4)
    expect(functions.data.map((row) => row["logs.functionName"])).not.toContain(
      "ai.generateObject"
    )
    for (const dimension of [
      "logs.functionName",
      "logs.agentName",
      "logs.workflowName",
      "logs.stepName",
    ]) {
      const result = await execute({ ...base, dimensions: [dimension] })
      expect(
        result.data.reduce((sum, row) => sum + Number(row["logs.costUsd"]), 0)
      ).toBe(10)
      expect(
        result.data.reduce((sum, row) => sum + Number(row["logs.llmCount"]), 0)
      ).toBe(8)
    }
    const workflows = await execute({
      ...base,
      dimensions: ["logs.workflowName"],
    })
    expect(workflows.data.map((row) => row["logs.workflowName"])).not.toContain(
      "outer-workflow"
    )
    const filtered = await execute({
      ...base,
      dimensions: ["logs.functionName"],
      filters: [
        {
          and: [
            {
              member: "logs.workflowName",
              operator: "equals",
              values: ["enrich-workflow"],
            },
            {
              member: "logs.agentName",
              operator: "equals",
              values: ["brand-agent"],
            },
            {
              member: "logs.stepName",
              operator: "equals",
              values: ["enrichPromptRun"],
            },
          ],
        },
      ],
    })
    expect(filtered.data).toHaveLength(2)
    const scalar = await execute({
      ...base,
      filters: [
        {
          member: "logs.functionName",
          operator: "equals",
          values: ["extract-mentioned-brands"],
        },
      ],
    })
    expect(scalar.data[0]["logs.costUsd"]).toBe(2)
    const page = await execute({
      ...base,
      dimensions: ["logs.functionName"],
      order: [["logs.costUsd", "desc"]],
      limit: 1,
      offset: 1,
    })
    expect(page.meta.page.total).toBe(5)
    expect(page.data[0]["logs.functionName"]).toBe("find-brand-domains")
    // LLM-only pruning must not remove non-LLM contributions to mixed metrics,
    // or zero-call groups when HAVING does not rule those groups out.
    const mixed = await execute({
      ...base,
      measures: ["logs.spanCount", "logs.llmCount"],
      dimensions: ["logs.functionName"],
    })
    expect(
      mixed.data.find(
        (row) => row["logs.functionName"] === "extract-mentioned-brands"
      )
    ).toMatchObject({ "logs.spanCount": 6, "logs.llmCount": 4 })
    for (const having of [
      [],
      [{ member: "logs.llmCount", operator: "gt", values: [-1] }],
    ]) {
      const allGroups = await execute({
        ...base,
        measures: ["logs.llmCount"],
        dimensions: ["logs.functionName"],
        having,
      })
      expect(
        allGroups.data.find((row) => row["logs.functionName"] === "brand-agent")
      ).toMatchObject({ "logs.llmCount": 0 })
    }
    const latencyError = await execute({
      ...base,
      measures: ["logs.meanLatencyMs"],
      dimensions: ["logs.functionName"],
      having: [],
    }).then(
      () => null,
      (error: Error) => error.message
    )
    expect(latencyError).toContain("Span-level grouping")
  } finally {
    await closeTracerFixture(db)
  }
})

test("chart configuration preserves explicit slicing and measures; icons are opt-in", () => {
  const widget = dashboardWidgetSchema.parse({
    id: "cost",
    title: "Cost by LLM call",
    type: "bar",
    width: 2,
    query: {
      ...base,
      measures: ["logs.costUsd"],
      dimensions: ["logs.functionName"],
      filters: [
        { member: "logs.workflowName", operator: "equals", values: ["enrich"] },
      ],
    },
  })
  expect(widget.showGroupIcons ?? false).toBe(false)
  const enabled = dashboardWidgetSchema.parse({
    ...widget,
    showGroupIcons: true,
  })
  expect(enabled.showGroupIcons).toBe(true)
  const query = dashboardQueryPlan([enabled], {}).batches[0][0]
  expect(query.dimensions).toEqual(widget.query.dimensions)
  expect(query.filters).toEqual(widget.query.filters)
  expect(query.measures).toEqual(["logs.costUsd"])
  expect(semanticQuerySchema.safeParse(query).success).toBe(true)
})
