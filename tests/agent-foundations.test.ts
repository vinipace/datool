import { rejects } from "node:assert/strict"
import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"
import {
  getTracerProjectId,
  registerTracerProjectId,
} from "../src/server/tracer/db"
import { TracerService } from "../src/server/tracer/service"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import {
  agentOperations,
  findAgentOperation,
} from "../src/server/mcp/operations"
import { createMcpServer } from "../src/server/mcp/server"
import { mcpScopes } from "../src/lib/auth/permissions"
import { defaultScorer } from "../src/lib/tracer/scorers"
import { waitForEval } from "../bin/agent"
import { routeScopes } from "../src/server/auth/request"
import { newDashboardWidget } from "../src/lib/tracer/dashboards"
import { semanticCatalog } from "../src/server/metrics/registry"
import { serveWebhook } from "../src/server/apps/webhook"
import type { ResolvedApp } from "../src/server/apps/invoke"

test("snapshot-backed connected evaluations execute frozen inputs once and re-score without invoking the app", async () => {
  const db = await createTracerFixture()
  const received: unknown[] = []
  const webhook = await serveWebhook(async (request) => {
    const { input } = await request.json()
    received.push(input)
    return Response.json(input)
  })
  const app: ResolvedApp = {
    connection: {
      id: "echo",
      name: "Echo",
      mode: "input",
      url: `http://127.0.0.1:${webhook.port}/call`,
    },
    definition: {
      id: "echo",
      name: "Echo",
      mode: "input",
      revision: 1,
      evaluatorIds: [],
      internalTracing: false,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    },
  }
  const service = new TracerService(db, { resolveApp: async () => app })
  const call = (name: string, input: Record<string, unknown>) =>
    run(findAgentOperation(name)!.execute(service, input))
  try {
    const ds = await run(service.createDataset({ name: "connected/snapshots" }))
    const item = await run(
      service.createDatasetItem(ds.id, {
        input: { value: 1 },
        expectedOutput: { value: 1 },
      })
    )
    const snapshot = await run(service.agent.createSnapshot(ds.id))
    await run(service.deleteDatasetItem(item.id))
    const scorer = await run(
      service.scorers.save({
        ...defaultScorer,
        type: "javascript",
        name: "Echo",
        slug: "echo",
        threshold: 0.5,
        code: "function evaluate({trace,datasetItem}) { return {score: trace.output.value === datasetItem.expectedOutput.value ? 1 : 0}; }",
      })
    )
    const input = {
      mode: "connected" as const,
      appId: "echo",
      datasetId: ds.id,
      datasetVersionId: snapshot.id,
      evaluatorIds: [scorer.id],
      requestKey: "connected-snapshot",
    }
    const started = await run(service.agent.startEval(input))
    await waitForEval(call, started.id, 30, 0.1)
    expect(received).toEqual([{ value: 1 }])
    expect((await run(service.agent.startEval(input))).id).toBe(started.id)
    const rescored = await run(
      service.agent.startEval({
        sourceRunId: started.id,
        evaluatorIds: [scorer.id],
        requestKey: "connected-rescore",
      })
    )
    await waitForEval(call, rescored.id, 30, 0.1)
    expect(received).toHaveLength(1)
    expect(
      (
        (await call("gate_eval_run", { id: rescored.id, minScore: 1 })) as {
          passed: boolean
        }
      ).passed
    ).toBe(true)
  } finally {
    webhook.stop()
    await closeTracerFixture(db)
  }
}, 60000)

test("all five foundations: version replay, full-run gates, trace evidence, bulk atomicity, analytics and project isolation", async () => {
  const db = await createTracerFixture()
  const service = new TracerService(db)
  const call = (name: string, input: Record<string, unknown> = {}) =>
    run(findAgentOperation(name)!.execute(service, input))
  try {
    const session = await run(
      service.createSession({ name: "agent investigation" })
    )
    const trace = await run(
      service.createTrace({
        name: "agent trace",
        sessionId: session.id,
        input: "hello",
        output: "world",
        status: "completed",
        spans: [{ name: "evidence", kind: "custom", status: "completed" }],
      })
    )
    const dataset = await run(service.createDataset({ name: "agent/cases" }))
    await call("bulk_dataset_items", {
      datasetId: dataset.id,
      create: [
        {
          id: "case-a",
          input: "hello",
          expectedOutput: "world",
          sourceTraceId: trace.id,
        },
        {
          id: "case-b",
          input: "different",
          expectedOutput: "wrong",
          sourceTraceId: trace.id,
        },
      ],
    })
    const v1 = await run(service.agent.createSnapshot(dataset.id, "baseline"))
    expect((await run(service.agent.createSnapshot(dataset.id))).id).toBe(v1.id)
    await rejects(
      call("bulk_dataset_items", {
        datasetId: dataset.id,
        create: [
          { id: "rolled-back", input: "new" },
          { id: "case-a", input: "duplicate" },
        ],
      })
    )
    expect(
      (await run(service.listDatasetItems(dataset.id))).items
    ).toHaveLength(2)
    await rejects(
      call("bulk_dataset_items", {
        datasetId: dataset.id,
        update: [{ id: "foreign", patch: { input: 1 } }],
      })
    )
    await call("bulk_dataset_items", {
      datasetId: dataset.id,
      expectedHash: v1.contentHash,
      update: [{ id: "case-a", patch: { expectedOutput: "changed" } }],
      delete: ["case-b"],
    })
    await rejects(
      call("bulk_dataset_items", {
        datasetId: dataset.id,
        expectedHash: v1.contentHash,
        create: [{ input: "stale" }],
      })
    )
    const frozen = await run(
      service.agent.getSnapshot(dataset.id, v1.id, { limit: 1 })
    )
    expect(frozen.items[0].expectedOutput).toBe("world")
    expect(frozen.nextCursor).toBe("case-a")
    expect(
      (
        await run(
          service.agent.getSnapshot(dataset.id, v1.id, {
            cursor: frozen.nextCursor!,
            limit: 1,
          })
        )
      ).items[0].id
    ).toBe("case-b")
    const scorerInput = {
      ...defaultScorer,
      type: "javascript" as const,
      name: "Evidence scorer",
      slug: "evidence",
      threshold: 0.5,
      code: "function evaluate({trace, datasetItem}) { return {score: trace.spans.length > 0 && trace.output === datasetItem.expectedOutput ? 1 : 0}; }",
    }
    const scorer = await run(service.scorers.save(scorerInput))
    const version = (await run(service.getEvaluator(scorer.id))).activeVersion
    expect(
      (await run(service.agent.listVersions(scorer.id, { limit: 1 }))).items
    ).toHaveLength(1)
    const preview = await run(
      service.agent.testScorer({
        scorerId: scorer.id,
        versionId: version.id,
        traceId: trace.id,
        datasetId: dataset.id,
        datasetItemId: "case-a",
        datasetVersionId: v1.id,
      })
    )
    expect(preview.result.score).toBe(1)
    expect(preview.persisted).toBe(false)
    expect((await run(service.listTraceScores(trace.id))).items).toHaveLength(0)
    await call("update_scorer", {
      id: scorer.id,
      expectedRevision: 1,
      scorer: {
        ...scorerInput,
        code: "function evaluate() { return {score: 1}; }",
      },
    })
    await rejects(
      call("update_scorer", {
        id: scorer.id,
        expectedRevision: 1,
        scorer: scorerInput,
      })
    )
    const startInput = {
      datasetId: dataset.id,
      datasetVersionId: v1.id,
      evaluatorIds: [scorer.id],
      evaluatorVersionIds: { [scorer.id]: version.id },
      requestKey: "frozen-run",
    }
    const initial = await run(service.agent.startEval(startInput))
    await waitForEval(call, initial.id, 30, 0.1)
    expect((await run(service.agent.startEval(startInput))).id).toBe(initial.id)
    await rejects(
      run(service.agent.startEval({ ...startInput, name: "changed" }))
    )
    const detail = await run(service.getEvalRun(initial.id, { limit: 1 }))
    expect(detail.resultCount).toBe(2)
    expect(detail.rows![0].results).toHaveLength(1)
    const next = await run(
      service.getEvalRun(initial.id, { cursor: detail.nextCursor!, limit: 1 })
    )
    expect(next.rows![0].results).toHaveLength(1)
    expect([detail.results[0].score, next.results[0].score].sort()).toEqual([
      0, 1,
    ])
    const gate = (await call("gate_eval_run", { id: initial.id })) as {
      passed: boolean
      run: { actual: number; score: number }
    }
    expect(gate.passed).toBe(false)
    expect(gate.run.actual).toBe(2)
    expect(gate.run.score).toBe(0.5)
    const otherCohort = await run(
      service.agent.startEval({
        ...startInput,
        datasetItemIds: ["case-a"],
        requestKey: "different-cohort",
      })
    )
    await waitForEval(call, otherCohort.id, 30, 0.1)
    expect(
      (
        (await call("gate_eval_run", {
          id: otherCohort.id,
          baselineId: initial.id,
        })) as { passed: boolean }
      ).passed
    ).toBe(false)
    const rescored = await run(
      service.agent.startEval({
        sourceRunId: initial.id,
        evaluatorIds: [scorer.id],
        requestKey: "rescore",
      })
    )
    await waitForEval(call, rescored.id, 30, 0.1)
    expect(
      (
        (await call("gate_eval_run", {
          id: rescored.id,
          minScore: 1,
          baselineId: initial.id,
        })) as { passed: boolean }
      ).passed
    ).toBe(false) // Changing the judge version makes an automatic quality-regression gate invalid.
    const comparison = await run(
      service.compareEvalRuns(initial.id, rescored.id)
    )
    expect(comparison.pairs).toHaveLength(2)
    expect(
      comparison.pairs.every((pair) => pair.matchedBy === "dataset item")
    ).toBe(true)
    const listed = await run(
      service.listTraces({ filter: 'name : "agent"', limit: 1 })
    )
    expect(listed.items[0].id).toBe(trace.id)
    expect((await run(service.listTraceSpans(trace.id))).items[0].name).toBe(
      "evidence"
    )
    expect((await run(service.getSession(session.id))).traces[0].id).toBe(
      trace.id
    )
    const link = await run(
      service.agent.resolveObject("dataset", "agent/cases")
    )
    expect(link.path).toBe(`/p/test-project/datasets/${dataset.id}`)
    const dashboard = await run(
      service.dashboards.create({
        schemaVersion: 1,
        name: "Agent dashboard",
        description: "",
        widgets: [
          newDashboardWidget(
            semanticCatalog.metadata().models.find((m) => m.name === "traces")!
          ),
        ],
      })
    )
    expect(
      (await run(service.agent.previewDashboard(dashboard.id))).results
    ).toHaveLength(1)
    const saved = await run(
      service.createSavedView({
        name: "Trace names",
        resource: "traces",
        columns: [
          { id: "name", label: "Name", selector: "trace.name", format: "text" },
        ],
      })
    )
    expect((await run(service.getSavedViewData(saved.id))).rows).toHaveLength(1)
    // Same physical database, different trusted project: no cross-project IDs leak.
    const originalProject = getTracerProjectId(db)
    registerTracerProjectId(db, "unrelated-project")
    const stranger = new TracerService(db)
    try {
      await rejects(run(stranger.getTraceArtifact(trace.id)))
      await rejects(run(stranger.agent.getSnapshot(dataset.id, v1.id, {})))
      await rejects(run(stranger.agent.getVersion(scorer.id, version.id)))
      await rejects(run(stranger.agent.resolveObject("dataset", dataset.id)))
    } finally {
      registerTracerProjectId(db, originalProject)
    }
    // A run-level status alone must never turn missing results into a passing gate.
    await db.execute(
      sql`delete from scores where project_id=${originalProject} and eval_result_id in (select id from eval_results where run_id=${rescored.id})`
    )
    await db.execute(
      sql`delete from eval_results where project_id=${originalProject} and run_id=${rescored.id}`
    )
    expect(
      (
        (await call("gate_eval_run", { id: rescored.id })) as {
          passed: boolean
        }
      ).passed
    ).toBe(false)
  } finally {
    await closeTracerFixture(db)
  }
}, 60000)

test("shared discovery and POST permissions fail closed", async () => {
  expect(new Set(agentOperations.map((op) => op.name)).size).toBe(
    agentOperations.length
  )
  for (const op of agentOperations) {
    expect(
      await routeScopes(
        new Request(`http://localhost/api/agent/${op.name}`, { method: "POST" })
      )
    ).toEqual(op.scopes)
    expect(
      op.scopes.every((scope) =>
        mcpScopes.includes(scope as (typeof mcpScopes)[number])
      )
    ).toBe(true)
  }
  await rejects(
    routeScopes(
      new Request("http://localhost/api/agent/unknown", { method: "POST" })
    )
  )
  await rejects(
    routeScopes(new Request("http://localhost/api/agent/create_dataset"))
  )
  const db = await createTracerFixture()
  const server = createMcpServer(new TracerService(db), ["evals:read"])
  const client = new Client({ name: "foundations", version: "1" })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(a)
    await client.connect(b)
    expect(
      (await client.listTools()).tools.some(
        (tool) => tool.name === "gate_eval_run"
      )
    ).toBe(true)
    expect(
      (await client.callTool({ name: "start_eval_run", arguments: {} })).isError
    ).toBe(true)
    const schema = await client.callTool({
      name: "describe_agent_operations",
      arguments: { name: "start_eval_run" },
    })
    expect(schema.isError).not.toBe(true)
  } finally {
    await client.close()
    await server.close()
    await closeTracerFixture(db)
  }
})
