import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { collectEvalAttributions } from "../src/server/tracer/eval-attribution"
import { TracerService } from "../src/server/tracer/service"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import { defaultScorer } from "../src/lib/tracer/scorers"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"
import { executeSemanticBatch } from "../src/server/semantic/executor"
import { semanticCatalog } from "../src/server/metrics/registry"
import { createSemanticSnapshotRunner } from "../src/server/semantic/snapshot"
import { findAgentOperation } from "../src/server/mcp/operations"
import type { Span, TraceForEvaluation } from "../src/lib/tracer/contracts"

const time = new Date().toISOString()
const trace: TraceForEvaluation = {
  id: "trace",
  name: "test",
  operation: "workflow",
  group: { type: "workflow", name: "Answer", version: "1" },
  startedAt: time,
  endedAt: time,
  status: "completed",
  sessionId: null,
  attributes: {},
  input: {},
  output: {},
  spans: [],
}
const span = (id: string, change: Partial<Span>): Span => ({
  id,
  traceId: "trace",
  parentId: null,
  name: id,
  kind: "llm",
  startedAt: time,
  endedAt: time,
  durationMs: 0,
  status: "completed",
  input: {},
  output: {},
  attributes: {},
  ...change,
})

test("prompt provenance deduplicates workload versions and excludes scorer subtrees", () => {
  const prompt = {
    "datool.prompt.id": "answer",
    "datool.prompt.slug": "answer",
    "datool.prompt.version": 2,
  }
  const values = collectEvalAttributions({
    ...trace,
    attributes: prompt,
    spans: [
      span("work", { attributes: prompt }),
      span("other-version", {
        attributes: { ...prompt, "datool.prompt.version": 3 },
      }),
      span("judge", {
        kind: "score",
        attributes: { ...prompt, "datool.prompt.id": "judge" },
      }),
      span("judge-child", {
        parentId: "judge",
        attributes: { ...prompt, "datool.prompt.id": "judge-child" },
      }),
      span("invalid", {
        attributes: { ...prompt, "datool.prompt.version": "4" },
      }),
    ],
  })
  expect(values[0].promptVersions).toEqual([
    { id: "answer", slug: "answer", version: 2 },
    { id: "answer", slug: "answer", version: 3 },
  ])
  expect(collectEvalAttributions(trace)[0].promptVersions).toBeUndefined()
})

test("attribution respects explicit subtrees, deduplicates models and excludes judges and their descendants", () => {
  const values = collectEvalAttributions({
    ...trace,
    spans: [
      span("a", { kind: "agent", group: { type: "agent", name: "Writer" } }),
      span("b", {
        parentId: "a",
        attributes: { "gen_ai.request.model": "alpha" },
      }),
      span("c", {
        parentId: "a",
        attributes: { "gen_ai.response.model": "alpha" },
      }),
      span("d", { attributes: { "ai.model.id": "beta" } }),
      span("judge", { kind: "score", group: { type: "agent", name: "Judge" } }),
      span("judge-llm", {
        parentId: "judge",
        attributes: { "gen_ai.request.model": "judge-model" },
      }),
    ],
    linkedTraces: [
      {
        ...trace,
        id: "judge-trace",
        group: { type: "agent", name: "Linked judge" },
        attributes: {
          "datool.scorer.execution": true,
          "gen_ai.request.model": "judge-model",
        },
      },
    ],
  })
  expect(values).toHaveLength(2)
  expect(
    values.find((value) => value.group?.name === "Answer")?.models
  ).toEqual(["alpha", "beta"])
  expect(
    values.find((value) => value.group?.name === "Writer")?.models
  ).toEqual(["alpha"])
  expect(collectEvalAttributions({ ...trace, group: null })[0]).toMatchObject({
    group: null,
    models: [],
  })
})

test("saved memberships, mixed-run charts, frozen re-scoring, pagination and project isolation work together", async () => {
  const db = await createTracerFixture()
  const other = await createTracerFixture()
  try {
    const service = new TracerService(db)
    const scorer = await run(
      service.scorers.save({
        ...defaultScorer,
        name: "Demo quality",
        slug: "demo-quality",
        type: "javascript",
        code: "function evaluate({trace}) { return {score:trace.output.score,passed:trace.output.score>=0.5}; }",
      })
    )
    async function create(name: string, model: string, score: number) {
      const created = await run(
        service.createTrace({
          name,
          operation: "workflow",
          group: { type: "workflow", name },
          input: {},
          output: { score },
          status: "completed",
          startedAt: time,
          endedAt: time,
        })
      )
      const agent = await run(
        service.createSpan(created.id, {
          name: `${name} agent`,
          kind: "agent",
          group: { type: "agent", name: `${name} agent` },
          input: {},
          output: { score },
          status: "completed",
          startedAt: time,
          endedAt: time,
        })
      )
      await run(
        service.createSpan(created.id, {
          name: "Generate",
          kind: "llm",
          parentId: agent.id,
          attributes: { "gen_ai.request.model": model },
          status: "completed",
          startedAt: time,
          endedAt: time,
        })
      )
      return created
    }
    const a = await create("Answer", "alpha", 1)
    const b = await create("Extract", "beta", 0)
    const mixed = await run(
      service.createEvalRun({
        name: "Mixed",
        traceIds: [a.id, b.id],
        evaluatorIds: [scorer.id],
      })
    )
    expect(mixed.results.map((result) => result.error)).toEqual([null, null])
    expect(mixed.groups?.map((group) => group.name).sort()).toEqual([
      "Answer",
      "Answer agent",
      "Extract",
      "Extract agent",
    ])
    expect(mixed.groupsResolvedAt).toBeTruthy()
    const groupOperation = findAgentOperation("list_eval_run_groups")!
    const grouped = (await run(
      groupOperation.execute(service, {
        groupBy: "workflow",
        limit: 1,
        includeTotal: true,
      })
    )) as { items: { name: string; runCount: number }[]; total: number }
    expect(grouped.total).toBe(2)
    expect(grouped.items[0]).toMatchObject({ name: "Answer", runCount: 1 })
    expect(
      (
        await run(
          new TracerService(other).listEvalRunGroups({ groupBy: "workflow" })
        )
      ).items
    ).toEqual([])
    const list = findAgentOperation("list_eval_runs")!
    const listed = (await run(
      list.execute(service, {
        filter: 'workflow = "Answer" agent = "Answer agent"',
        limit: 1,
      })
    )) as { items: (typeof mixed)[] }
    expect(listed.items.map((item) => item.id)).toEqual([mixed.id])
    expect(
      (await run(service.listEvalRuns({ filter: 'workflow != "Answer"' })))
        .items
    ).toHaveLength(0)
    expect(
      (await run(service.listEvalRuns({ filter: 'workflow = "Missing"' })))
        .items
    ).toHaveLength(0)
    const query = async (dimensions: string[], filters: unknown[] = []) =>
      (
        await executeSemanticBatch(
          {
            queries: [
              {
                measures: ["evalQuality.meanScore", "evalQuality.scoredCount"],
                dimensions,
                filters,
                timeDimensions: [
                  {
                    dimension: "evalQuality.completedAt",
                    dateRange: [
                      new Date(Date.now() - 3600000).toISOString(),
                      new Date(Date.now() + 3600000).toISOString(),
                    ],
                  },
                ],
                order: dimensions.map((dimension) => [dimension, "asc"]),
                limit: 100,
                total: true,
              },
            ],
          },
          {
            catalog: semanticCatalog,
            requestId: "attribution-test",
            snapshotRunner: createSemanticSnapshotRunner(db),
          }
        )
      )[0]
    const perModel = await query(
      ["evalQuality.groupName", "evalQuality.model"],
      [
        {
          member: "evalQuality.groupType",
          operator: "equals",
          values: ["workflow"],
        },
      ]
    )
    expect(perModel.data).toEqual([
      {
        "evalQuality.completedAt": null,
        "evalQuality.groupName": "Answer",
        "evalQuality.model": "alpha",
        "evalQuality.meanScore": 1,
        "evalQuality.scoredCount": 1,
      },
      {
        "evalQuality.completedAt": null,
        "evalQuality.groupName": "Extract",
        "evalQuality.model": "beta",
        "evalQuality.meanScore": 0,
        "evalQuality.scoredCount": 1,
      },
    ])
    expect((await query([])).data[0]).toMatchObject({
      "evalQuality.meanScore": 0.5,
      "evalQuality.scoredCount": 2,
    })
    // Selecting a workflow narrows a mixed run at case level and retains only
    // agents participating in those cases, without duplicating the top-line score.
    const workflowFilter = {
      member: "evalQuality.workflow",
      operator: "equals",
      values: ["Answer"],
    }
    expect((await query([], [workflowFilter])).data[0]).toMatchObject({
      "evalQuality.meanScore": 1,
      "evalQuality.scoredCount": 1,
    })
    expect(
      (
        await query(
          ["evalQuality.groupName"],
          [
            workflowFilter,
            {
              member: "evalQuality.groupType",
              operator: "equals",
              values: ["agent"],
            },
          ]
        )
      ).data.map((row) => row["evalQuality.groupName"])
    ).toEqual(["Answer agent"])
    expect(
      (await query([], [{ ...workflowFilter, operator: "notEquals" }])).data[0]
    ).toMatchObject({
      "evalQuality.meanScore": 0,
      "evalQuality.scoredCount": 1,
    })
    expect(
      (
        await query(
          [],
          [{ ...workflowFilter, operator: "contains", values: ["NSW"] }]
        )
      ).data[0]["evalQuality.scoredCount"]
    ).toBe(1)
    expect(
      (
        await query(
          [],
          [
            {
              member: "evalQuality.groupName",
              operator: "contains",
              values: ["ANSWER"],
            },
          ]
        )
      ).data[0]["evalQuality.scoredCount"]
    ).toBe(1)
    expect(
      (
        await query(
          [],
          [
            {
              member: "evalQuality.agent",
              operator: "equals",
              values: ["Extract agent"],
            },
          ]
        )
      ).data[0]
    ).toMatchObject({
      "evalQuality.meanScore": 0,
      "evalQuality.scoredCount": 1,
    })
    expect(
      (await query([], [{ ...workflowFilter, values: ["Missing"] }])).data[0][
        "evalQuality.scoredCount"
      ]
    ).toBe(0)
    // Mutating current telemetry must not alter saved attribution or a re-score.
    await db.execute(
      sql`update spans set attributes_json='{"gen_ai.request.model":"changed"}'::jsonb`
    )
    const rescored = await run(
      service.createEvalRun({
        sourceRunId: mixed.id,
        evaluatorIds: [scorer.id],
      })
    )
    expect(rescored.groups).toEqual(mixed.groups)
    expect(
      (await query(["evalQuality.model"])).data.map(
        (row) => row["evalQuality.model"]
      )
    ).toEqual(["alpha", "beta"])
    const page1 = await run(
      service.listEvalRuns({
        filter: 'workflow = "Answer"',
        limit: 1,
        includeTotal: true,
      })
    )
    expect(page1.total).toBe(2)
    const page2 = await run(
      service.listEvalRuns({
        filter: 'workflow = "Answer"',
        limit: 1,
        cursor: page1.nextCursor,
      })
    )
    expect(
      new Set([...page1.items, ...page2.items].map((item) => item.id)).size
    ).toBe(2)
    expect(
      (
        await run(
          new TracerService(other).listEvalRuns({
            filter: 'workflow = "Answer"',
          })
        )
      ).items
    ).toHaveLength(0)
    const dataset = await run(
      service.createDataset({ name: "Selected subtree" })
    )
    const selected = (await run(service.getTraceArtifact(a.id))).spans.find(
      (item) => item.kind === "agent"
    )!
    await run(
      service.createDatasetItem(dataset.id, {
        input: {},
        sourceTraceId: a.id,
        sourceSpanId: selected.id,
      })
    )
    const scoped = await run(
      service.createEvalRun({ datasetId: dataset.id, evaluatorIds: [] })
    )
    expect(scoped.groups?.map((group) => group.name)).toEqual(["Answer agent"])
    // Old snapshots remain visibly unresolved: a re-score must not silently
    // reconstruct history from telemetry that has since changed.
    await db.execute(
      sql`delete from eval_target_attributions where run_id=${mixed.id}`
    )
    await db.execute(sql`delete from eval_run_groups where run_id=${mixed.id}`)
    await db.execute(
      sql`update eval_runs set groups_resolved_at=null where id=${mixed.id}`
    )
    await db.execute(
      sql`update eval_run_targets set snapshot_json=(snapshot_json::jsonb-'attributions')::text where run_id=${mixed.id}`
    )
    const legacyRescore = await run(
      service.createEvalRun({
        sourceRunId: mixed.id,
        evaluatorIds: [scorer.id],
      })
    )
    expect(legacyRescore.groups).toEqual([])
    expect(legacyRescore.groupsResolvedAt).toBeNull()
  } finally {
    await closeTracerFixture(db)
    await closeTracerFixture(other)
  }
}, 60000)

test("deep, unordered and cyclic span graphs resolve without repeated subtree scans", () => {
  const spans = Array.from({ length: 10_000 }, (_, i) =>
    span(String(i), {
      parentId: i ? String(i - 1) : null,
      kind: i === 0 ? "agent" : "llm",
      group: i === 0 ? { type: "agent", name: "Root agent" } : null,
      attributes: i === 9999 ? { model: "deep-model" } : {},
    })
  ).reverse()
  expect(
    collectEvalAttributions({ ...trace, spans }).map((a) => a.models)
  ).toEqual([["deep-model"], ["deep-model"]])
  expect(
    collectEvalAttributions({
      ...trace,
      group: null,
      spans: [
        span("a", { parentId: "b", group: { type: "agent", name: "Cycle" } }),
        span("b", { parentId: "a" }),
        span("c", { parentId: "a", attributes: { model: "cycle-model" } }),
        span("judge", { parentId: "b", kind: "score" }),
        span("judge-child", {
          parentId: "judge",
          attributes: { model: "judge" },
        }),
      ],
    })[0].models
  ).toEqual(["cycle-model"])
})
