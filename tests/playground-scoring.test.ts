import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  selectedScorers,
  prepareAppScoring,
  runAppExperiment,
} from "../src/server/apps/scoring"
import { defaultScorer } from "../src/lib/tracer/scorers"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import { TracerService } from "../src/server/tracer/service"
import { withWorkspace } from "../src/server/auth/context"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"
import { getTracerProjectId } from "../src/server/tracer/db"
import type { ResolvedApp } from "../src/server/apps/invoke"
import { serveWebhook } from "../src/server/apps/webhook"

test("scorer defaults, explicit opt-out, deduplication and limits", () => {
  expect(selectedScorers(null, ["default"])).toEqual(["default"])
  expect(selectedScorers("", ["default"])).toEqual([])
  expect(selectedScorers("one,two,one", [])).toEqual(["one", "two"])
  expect(() => selectedScorers("one,", [])).toThrow()
  expect(() => selectedScorers(Array(11).fill("one").join(","), [])).toThrow()
})

test("playground saves an experiment before execution, pins scoring, and records unscored and failed runs", async () => {
  const db = await createTracerFixture()
  const previousKey = process.env.OPENAI_API_KEY
  const previousUrl = process.env.OPENAI_BASE_URL
  const judge = await serveWebhook(async (request) => {
    const body = await request.json()
    expect(body.messages[1].content).toBe("Original rubric")
    return Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              choice: "Pass",
              reason: "Image present",
            }),
          },
        },
      ],
    })
  })
  process.env.OPENAI_API_KEY = "local-test-key"
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${judge.port}/v1`
  let service: TracerService
  const listener = await serveWebhook(async (request) => {
    const { input } = await request.json()
    // The experiment is durable before any handler executes.
    const runs = await run(service.listEvalRuns({}))
    expect(runs.items[0].status).toBe("running")
    if (input.fail) return new Response("Generation failed", { status: 500 })
    const callId = request.headers.get("x-datool-call-id")
    expect(callId).toBeTruthy()
    for (const name of ["Generate image", "Inspect image"]) {
      const timestamp = new Date().toISOString()
      await run(
        service.createTrace({
          name,
          operation: "image.step",
          status: "completed",
          startedAt: timestamp,
          endedAt: timestamp,
          attributes: { "datool.call.id": callId! },
          spans: [
            {
              id: randomUUID(),
              name,
              kind: "function",
              status: "completed",
              startedAt: timestamp,
              endedAt: timestamp,
            },
          ],
        })
      )
    }
    return Response.json({ image: { url: "https://example.com/image.jpg" } })
  })
  const app: ResolvedApp = {
    connection: {
      id: "images",
      name: "Images",
      mode: "input",
      url: `http://127.0.0.1:${listener.port}`,
    },
    definition: {
      id: "images",
      name: "Images",
      mode: "input",
      revision: 2,
      inputSchema: {},
      outputSchema: {},
      evaluatorIds: [],
      internalTracing: false,
    },
  }
  try {
    service = new TracerService(db, { resolveApp: async () => app })
    const projectId = getTracerProjectId(db)
    const scorer = await run(
      service.scorers.save({
        ...defaultScorer,
        type: "llm",
        model: "gpt-4.1-mini",
        name: "Image present",
        slug: "image-present",
        messages: [{ role: "user", content: "Original rubric" }],
      })
    )
    const identity = {
      organizationId: "test",
      projectId,
      kind: "api-key" as const,
      scopes: ["apps:write"],
    }
    await rejects(
      withWorkspace(identity, () => prepareAppScoring(service, [scorer.id]))
    )
    const versions = await withWorkspace(
      { ...identity, scopes: ["evals:write", "scorers:read"] },
      () => prepareAppScoring(service, [scorer.id])
    )
    await run(
      service.scorers.save(
        {
          ...scorer,
          expectedRevision: scorer.revision,
          messages: [{ role: "user", content: "Changed rubric" }],
        },
        scorer.id
      )
    )
    const { experiment: evaluation, trace: saved } = await runAppExperiment(
      service,
      app,
      { prompt: "Robot" },
      versions
    )
    const id = evaluation.id
    expect(evaluation.status).toBe("completed")
    expect(evaluation.results[0].score).toBe(1)
    expect(evaluation.results[0].evaluatorVersion).toBe(1)
    expect(saved.attributes["datool.eval.run.id"]).toBe(id)
    expect(saved.output).toEqual({
      image: { url: "https://example.com/image.jpg" },
    })
    expect(saved.group).toEqual({
      type: "workflow",
      name: "Images",
      version: "2",
    })
    expect(evaluation.rows?.[0].scoringTrace?.input).toEqual({
      prompt: "Robot",
    })
    expect(evaluation.metadata.mode).toBe("connected")
    const captured = evaluation.rows?.[0].scoringTrace?.linkedTraces ?? []
    expect(captured.map((trace) => trace.name).sort()).toEqual([
      "Generate image",
      "Inspect image",
    ])
    expect(captured.every((trace) => trace.spans.length === 1)).toBe(true)
    // Exported trees stay in the trace collection as well as the frozen experiment.
    for (const trace of captured)
      expect(
        (await run(service.getTraceArtifact(trace.id))).spans
      ).toHaveLength(1)
    expect(saved.spans.some((span) => span.kind === "score")).toBe(true)
    const unscored = await runAppExperiment(
      service,
      app,
      { prompt: "Unscored" },
      {}
    )
    expect(unscored.experiment.status).toBe("completed")
    expect(unscored.experiment.evaluatorIds).toEqual([])
    expect(unscored.experiment.rows).toHaveLength(1)
    expect(unscored.trace.attributes["datool.eval.run.id"]).toBe(
      unscored.experiment.id
    )
    const failed = await runAppExperiment(service, app, { fail: true }, {})
    expect(failed.experiment.status).toBe("failed")
    expect(failed.trace.status).toBe("errored")
    expect(failed.experiment.rows?.[0].scoringTrace?.status).toBe("errored")
    expect((await run(service.listEvalRuns({}))).items).toHaveLength(3)
    await rejects(withWorkspace(identity, () => prepareAppScoring(service, [])))
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    if (previousUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = previousUrl
    judge.stop()
    listener.stop()
    await closeTracerFixture(db)
  }
}, 30_000)
