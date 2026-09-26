import { evalExecution } from "../src/server/tracer/eval-execution"
import { defaultPrompt } from "../src/lib/tracer/prompts"
import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"
import { TracerService } from "../src/server/tracer/service"
import { getTracerProjectId } from "../src/server/tracer/db"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import { defaultScorer } from "../src/lib/tracer/scorers"
import { serveWebhook } from "../src/server/apps/webhook"
import type { ResolvedApp } from "../src/server/apps/invoke"
async function wait(service: TracerService, id: string) {
  const deadline = Date.now() + 30000
  let detail = await run(service.getEvalRun(id, { includeEvidence: false }))
  while (detail.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    detail = await run(service.getEvalRun(id, { includeEvidence: false }))
  }
  expect(detail.status).not.toBe("running")
  return detail
}
async function fixture() {
  const db = await createTracerFixture()
  let failJudge = false
  let appCalls = 0,
    judgeCalls = 0
  const appServer = await serveWebhook(async (request) => {
    appCalls++
    const body = await request.json()
    return Response.json(body.input)
  })
  const judgeServer = await serveWebhook(async (request) => {
    judgeCalls++
    if (failJudge)
      return Response.json(
        { error: { message: "Local judge unavailable" } },
        { status: 500 }
      )
    const body = await request.json()
    const value = JSON.parse(body.messages.at(-1).content)
    const choice = value.bad ? "fail" : "pass"
    return Response.json({
      model: "test",
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              choice,
              reason:
                choice === "fail"
                  ? "Declared negative control"
                  : "Matches evidence",
            }),
          },
        },
      ],
    })
  })
  const oldUrl = process.env.OPENAI_BASE_URL,
    oldKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${judgeServer.port}`
  process.env.OPENAI_API_KEY = "local-test-only"
  const app: ResolvedApp = {
    connection: {
      id: "app",
      name: "App",
      mode: "input",
      url: `http://127.0.0.1:${appServer.port}`,
    },
    definition: {
      id: "app",
      name: "App",
      mode: "input",
      revision: 1,
      evaluatorIds: [],
      internalTracing: false,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      codeProvenance: {
        source: "local-git",
        revision: "abc",
        dirty: true,
        fingerprint: "local-tree",
      },
    },
  }
  const service = new TracerService(db, { resolveApp: async () => app })
  const scorer = await run(
    service.scorers.save({
      ...defaultScorer,
      name: "Judge",
      slug: "judge",
      type: "llm",
      provider: undefined,
      model: "test",
      messages: [{ role: "user", content: "{{output}}" }],
      choices: [
        { label: "pass", score: 1 },
        { label: "fail", score: 0 },
      ],
      threshold: 0.5,
    })
  )
  const dataset = await run(service.createDataset({ name: "Cases" }))
  const items = []
  for (const bad of [false, true])
    items.push(
      await run(
        service.createDatasetItem(dataset.id, {
          input: { bad },
          expectedOutput: { bad: false },
        })
      )
    )
  return {
    db,
    service,
    scorer,
    dataset,
    items,
    app,
    failJudge: (value: boolean) => {
      failJudge = value
    },
    calls: () => ({ appCalls, judgeCalls }),
    close: async () => {
      appServer.stop()
      judgeServer.stop()
      if (oldUrl === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = oldUrl
      if (oldKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = oldKey
      await closeTracerFixture(db)
    },
  }
}

test("recovery keeps successful judgments and reuses a completed scorer span after a persistence interruption", async () => {
  const f = await fixture()
  try {
    const started = await run(
      f.service.createEvalRun({
        mode: "connected",
        appId: "app",
        datasetId: f.dataset.id,
        evaluatorIds: [f.scorer.id],
      })
    )
    const result = await wait(f.service, started.id)
    const original = result.results[0],
      missing = result.results[1]
    await f.db.execute(sql`delete from eval_results where id=${missing.id}`)
    await f.db.execute(
      sql`update eval_runs set status='failed' where id=${result.id}`
    )
    await f.db.execute(
      sql`update eval_run_targets set stage='scoring' where id=${missing.metadata.evalTargetId}`
    )
    await run(f.service.recoverEvalRun(result.id))
    const recovered = await wait(f.service, result.id)
    expect(recovered.results).toHaveLength(2)
    expect(recovered.results.find((r) => r.id === original.id)).toBeDefined()
    expect(
      recovered.results.find(
        (r) => r.metadata.evalTargetId === missing.metadata.evalTargetId
      )?.passed
    ).toBe(missing.passed)
    expect(f.calls()).toEqual({ appCalls: 2, judgeCalls: 2 })
    await run(f.service.recoverEvalRun(result.id))
    expect(f.calls()).toEqual({ appCalls: 2, judgeCalls: 2 })
  } finally {
    await f.close()
  }
}, 30000)

test("stale invocation recovery uses durable root or bridge output, and blocks uncertain calls without re-dispatch", async () => {
  const f = await fixture()
  try {
    const started = await run(
      f.service.createEvalRun({
        mode: "connected",
        appId: "app",
        datasetId: f.dataset.id,
        evaluatorIds: [],
      })
    )
    const completed = await wait(f.service, started.id)
    await f.db.execute(
      sql`update eval_runs set status='failed' where id=${completed.id}`
    )
    await f.db.execute(
      sql`update eval_run_targets set stage='invoking',snapshot_json=jsonb_set(snapshot_json::jsonb,'{trace,status}','"running"'::jsonb)::text where run_id=${completed.id}`
    )
    await run(f.service.recoverEvalRun(completed.id))
    expect((await wait(f.service, completed.id)).status).toBe("completed")
    expect(f.calls().appCalls).toBe(2)
    const row = completed.rows![0],
      live = await run(f.service.getTraceArtifact(row.trace.id))
    await f.db.execute(
      sql`update eval_runs set status='failed' where id=${completed.id}`
    )
    await f.db.execute(
      sql`update eval_run_targets set stage='invoking' where id=${row.id}`
    )
    await run(
      f.service.patchTrace(row.trace.id, { status: "running", output: null })
    )
    await run(f.service.recoverEvalRun(completed.id))
    const blocked = await wait(f.service, completed.id)
    expect(blocked.execution?.stages.blocked).toBe(1)
    expect(f.calls().appCalls).toBe(2)
    await f.db.execute(
      sql`insert into app_bridge_job(project_id,id,bridge_id,app_id,call_id,job,result,deadline) values (${getTracerProjectId(f.db)},${crypto.randomUUID()},${crypto.randomUUID()},'app',${String(live.attributes["datool.call.id"])},'{}',${JSON.stringify({ ok: true, output: { bad: false }, telemetryComplete: true })}::jsonb,now())`
    )
    await run(f.service.recoverEvalRun(completed.id))
    expect((await wait(f.service, completed.id)).status).toBe("completed")
    expect(f.calls().appCalls).toBe(2)
  } finally {
    await f.close()
  }
}, 30000)

test("cancellation fences active results; live ownership rejects concurrent recovery", async () => {
  const f = await fixture()
  let release!: () => void, entered!: () => void
  const entry = new Promise<void>((resolve) => (entered = resolve)),
    block = new Promise<void>((resolve) => (release = resolve))
  const slow = await serveWebhook(async () => {
    entered()
    await block
    return Response.json({ bad: false })
  })
  f.app.connection.url = `http://127.0.0.1:${slow.port}`
  try {
    const started = await run(
      f.service.createEvalRun({
        mode: "connected",
        appId: "app",
        datasetId: f.dataset.id,
        evaluatorIds: [f.scorer.id],
        concurrency: 1,
      })
    )
    await entry
    await assert.rejects(
      run(f.service.recoverEvalRun(started.id)),
      /live worker/
    )
    expect((await run(f.service.cancelEvalRun(started.id))).status).toBe(
      "cancelled"
    )
    release()
    await new Promise((resolve) => setTimeout(resolve, 150))
    const cancelled = await run(f.service.getEvalRun(started.id))
    expect(cancelled.status).toBe("cancelled")
    expect(cancelled.results).toHaveLength(0)
    await assert.rejects(run(f.service.recoverEvalRun(started.id)), /Cancelled/)
    expect((await run(f.service.cancelEvalRun(started.id))).status).toBe(
      "cancelled"
    )
  } finally {
    release()
    slow.stop()
    await f.close()
  }
}, 30000)

test("expired ownership can only be claimed once; queued work remains recoverable across an app fingerprint change", async () => {
  const f = await fixture()
  try {
    const started = await run(
      f.service.createEvalRun({
        mode: "connected",
        appId: "app",
        datasetId: f.dataset.id,
        evaluatorIds: [],
      })
    )
    const done = await wait(f.service, started.id)
    await f.db.execute(
      sql`update eval_runs set status='failed' where id=${done.id}`
    )
    await f.db.execute(
      sql`insert into eval_run_lease(run_id,owner,expires_at) values (${done.id},'expired',now()-interval '1 second')`
    )
    const engine = evalExecution(f.db, f.service, {
      resolveApp: async () => f.app,
      persist: async () => {},
    })
    const claims = await Promise.allSettled([
      engine.claim(done.id, true),
      engine.claim(done.id, true),
    ])
    expect(claims.filter((c) => c.status === "fulfilled")).toHaveLength(1)
    expect(claims.filter((c) => c.status === "rejected")).toHaveLength(1)
    await f.db.execute(sql`delete from eval_run_lease where run_id=${done.id}`)
    const row = done.rows![0]
    await run(
      f.service.patchTrace(row.trace.id, { status: "running", output: null })
    )
    await f.db.execute(
      sql`update eval_run_targets set stage='queued',snapshot_json=jsonb_set(snapshot_json::jsonb,'{trace,status}','"running"'::jsonb)::text where id=${row.id}`
    )
    f.app.definition.codeProvenance!.fingerprint = "changed-tree"
    await run(f.service.recoverEvalRun(done.id))
    expect((await wait(f.service, done.id)).execution?.stages.queued).toBe(1)
    expect(f.calls().appCalls).toBe(2)
    f.app.definition.codeProvenance!.fingerprint = "local-tree"
    await run(f.service.recoverEvalRun(done.id))
    expect((await wait(f.service, done.id)).status).toBe("completed")
    expect(f.calls().appCalls).toBe(3)
  } finally {
    await f.close()
  }
}, 30000)

test("iteration uses latest automatically, preserves frozen cases and distinguishes judge changes from application changes", async () => {
  const f = await fixture()
  try {
    const prompt = await run(
      f.service.prompts.save({
        ...defaultPrompt,
        name: "Extractor",
        slug: "extractor",
        model: "openai/original",
        messages: [{ role: "user", content: "Original" }],
      })
    )
    const published = await run(
      f.service.prompts.publish(prompt.id, {
        expectedRevision: prompt.revision,
      })
    )
    const baseline = await wait(
      f.service,
      (
        await run(
          f.service.createEvalRun({
            mode: "connected",
            appId: "app",
            datasetId: f.dataset.id,
            evaluatorIds: [f.scorer.id],
          })
        )
      ).id
    )
    const revised = await run(
      f.service.prompts.save(
        {
          ...prompt,
          messages: [{ role: "user", content: "Revised" }],
          expectedRevision: published.revision,
        },
        prompt.id
      )
    )
    await run(
      f.service.prompts.publish(prompt.id, {
        expectedRevision: revised.revision,
      })
    )
    await run(
      f.service.scorers.save(
        {
          ...f.scorer,
          expectedRevision: f.scorer.revision,
          messages: [{ role: "user", content: "{{output}} " }],
        },
        f.scorer.id
      )
    )
    await run(
      f.service.patchDatasetItem(f.items[0].id, {
        expectedVersionId: f.items[0].versionId,
        input: { changedLive: true },
        expectedOutput: { changedReference: true },
      })
    )
    const latest = await wait(
      f.service,
      (await run(f.service.createEvalRun({ parentRunId: baseline.id }))).id
    )
    expect(latest.status).toBe("completed")
    expect(latest.rows!.map((r) => r.expectedOutput)).toEqual(
      baseline.rows!.map((r) => r.expectedOutput)
    )
    expect(latest.rows!.map((r) => r.trace.input)).toEqual(
      baseline.rows!.map((r) => r.trace.input)
    )
    expect(latest.metadata.promptConfig).toMatchObject({
      prompts: { extractor: { version: 2 } },
    })
    expect(latest.evaluatorVersionIds).not.toEqual(baseline.evaluatorVersionIds)
    const comparison = await run(
      f.service.compareEvalRuns(baseline.id, latest.id, 0, false)
    )
    expect(comparison.configurationChanges.map((c) => c.kind)).toContain(
      "judge"
    )
    expect(comparison.configurationChanges.map((c) => c.field)).toContain(
      "prompt:extractor"
    )
    const gate = await run(
      f.service.agent.gateEval({
        id: latest.id,
        baselineId: baseline.id,
        minScore: 0,
        minPassRate: 0,
        maxErrors: 0,
        allowUnscored: false,
        maxRegression: 1,
      })
    )
    expect(gate.passed).toBe(false)
    expect(gate.reasons).toContain(
      "Baseline must use the same scorer versions, inputs and expected outputs."
    )
    const controlled = await wait(
      f.service,
      (
        await run(
          f.service.createEvalRun({
            parentRunId: baseline.id,
            useRecordedVersions: true,
            promptOverrides: { extractor: { model: "openai/candidate" } },
          })
        )
      ).id
    )
    expect(controlled.evaluatorVersionIds).toEqual(baseline.evaluatorVersionIds)
    expect(controlled.metadata.promptConfig).toMatchObject({
      prompts: { extractor: { version: 1, model: "openai/candidate" } },
    })
    const changes = controlled.metadata.configurationChanges as {
      kind: string
      field: string
    }[]
    expect(changes.some((c) => c.kind === "judge")).toBe(false)
    expect(changes.some((c) => c.field === "prompt:extractor")).toBe(true)
    const latestWithHeldJudges = await wait(
      f.service,
      (
        await run(
          f.service.createEvalRun({
            parentRunId: baseline.id,
            evaluatorVersionIds: baseline.evaluatorVersionIds,
          })
        )
      ).id
    )
    expect(latestWithHeldJudges.evaluatorVersionIds).toEqual(
      baseline.evaluatorVersionIds
    )
    expect(latestWithHeldJudges.metadata.promptConfig).toMatchObject({
      prompts: { extractor: { version: 2 } },
    })
    const calls = f.calls().appCalls
    const rescore = await wait(
      f.service,
      (
        await run(
          f.service.createEvalRun({
            sourceRunId: baseline.id,
            useRecordedVersions: true,
          })
        )
      ).id
    )
    expect(f.calls().appCalls).toBe(calls)
    expect(rescore.evaluatorVersionIds).toEqual(baseline.evaluatorVersionIds)
    expect(rescore.rows!.map((r) => r.trace.output)).toEqual(
      baseline.rows!.map((r) => r.trace.output)
    )
  } finally {
    await f.close()
  }
}, 30000)

test("runtime-error recovery retries judges on frozen output without calling the app", async () => {
  const f = await fixture()
  try {
    f.failJudge(true)
    const failed = await wait(
      f.service,
      (
        await run(
          f.service.createEvalRun({
            mode: "connected",
            appId: "app",
            datasetId: f.dataset.id,
            evaluatorIds: [f.scorer.id],
          })
        )
      ).id
    )
    expect(failed.status).toBe("failed")
    expect(failed.results.every((r) => r.status === "error")).toBe(true)
    f.failJudge(false)
    await run(f.service.recoverEvalRun(failed.id))
    const recovered = await wait(f.service, failed.id)
    expect(recovered.status).toBe("completed")
    expect(recovered.results).toHaveLength(2)
    expect(f.calls().appCalls).toBe(2)
  } finally {
    await f.close()
  }
}, 30000)

test("incomplete trace delivery terminates with an explanation and recovers without another application call", async () => {
  const f = await fixture()
  try {
    f.app.definition.internalTracing = true
    const started = await run(
      f.service.createEvalRun({
        mode: "connected",
        appId: "app",
        datasetId: f.dataset.id,
        datasetItemIds: [f.items[0].id],
        evaluatorIds: [f.scorer.id],
      })
    )
    const incomplete = await wait(f.service, started.id)
    expect(incomplete.status).toBe("failed")
    expect(incomplete.rows![0].stage).toBe("awaiting_delivery")
    expect(incomplete.rows![0].executionError).toContain(
      "trace delivery is incomplete"
    )
    expect(incomplete.results).toHaveLength(0)
    const trace = await run(
      f.service.getTraceArtifact(incomplete.rows![0].trace.id)
    )
    await run(f.service.createSpan(trace.id, {
      name: "Late workload evidence", kind: "llm", status: "completed",
      group: { type: "agent", name: "Recovered agent", version: "1" },
      attributes: { "gen_ai.request.model": "workload-model" },
      startedAt: trace.startedAt, endedAt: new Date().toISOString(),
    }))
    await run(
      f.service.patchTrace(trace.id, {
        attributes: { ...trace.attributes, "datool.telemetry.flushed": true },
      })
    )
    await run(f.service.recoverEvalRun(incomplete.id))
    const recovered = await wait(f.service, incomplete.id)
    expect(recovered.status).toBe("completed")
    expect(recovered.results).toHaveLength(1)
    expect(f.calls().appCalls).toBe(1)
    expect(recovered.groups?.find(group => group.name === "Recovered agent")).toEqual({ type: "agent", name: "Recovered agent", version: "1" })
    const saved = await f.db.execute(sql`select models_json from eval_target_attributions where run_id=${recovered.id} and group_name='Recovered agent'`)
    expect(saved.rows).toEqual([{ models_json: ["workload-model"] }])
  } finally {
    await f.close()
  }
}, 45000)
