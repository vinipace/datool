import { expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { defaultScorer } from "../src/lib/tracer/scorers"
import { serveWebhook } from "../src/server/apps/webhook"
import { closeTracerDatabase } from "../src/server/tracer/db"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import { evalRuns } from "../src/server/tracer/schema"
import { TracerService } from "../src/server/tracer/service"
import {
  closeTracerFixture,
  createTracerFixture,
  reopenTracerFixture,
} from "./helpers/tracer-fixture"

test("scorer progress persists queued and running attempts across pages, readers and interrupted runs", async () => {
  const db = await createTracerFixture()
  const readerDb = reopenTracerFixture(db)
  const service = new TracerService(db)
  const reader = new TracerService(readerDb)
  const previousKey = process.env.OPENAI_API_KEY
  const previousUrl = process.env.OPENAI_BASE_URL
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const judge = await serveWebhook(async () => {
    entered.resolve()
    await release.promise
    return Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({ choice: "Pass", reason: "Matches" }),
          },
        },
      ],
    })
  })
  process.env.OPENAI_API_KEY = "local-test-key"
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${judge.port}/v1`
  let runId: string | undefined
  try {
    const traces = await Promise.all(
      ["First", "Second"].map((name) =>
        run(
          service.createTrace({ name, status: "completed", output: "Evidence" })
        )
      )
    )
    const scorers = await Promise.all(
      ["Quality", "Relevance"].map((name) =>
        run(
          service.scorers.save({
            ...defaultScorer,
            type: "llm",
            name,
            slug: name.toLowerCase(),
            model: "gpt-4.1-mini",
            messages: [{ role: "user", content: "Grade this" }],
          })
        )
      )
    )
    const started = await run(
      service.createEvalRun({
        traceIds: traces.map((trace) => trace.id),
        evaluatorIds: scorers.map((scorer) => scorer.id),
        background: true,
      })
    )
    runId = started.id
    expect(started.scorerProgress?.map((scorer) => scorer.queued)).toEqual([
      2, 2,
    ])
    await entered.promise
    const page = await run(reader.getEvalRun(started.id, { limit: 1 }))
    expect(page.rows).toHaveLength(1)
    // SQL does not promise scorer execution order. Assert the persisted active
    // attempt, independently of which scorer was supplied first.
    const activeScorer = page.scorerProgress!.find(
      (scorer) => scorer.running === 1
    )!
    expect(Boolean(activeScorer)).toBe(true)
    const pendingScorer = scorers.find(
      (scorer) => scorer.id !== activeScorer.evaluatorId
    )!

    expect(
      page.scorerProgress?.find(
        (scorer) => scorer.evaluatorId === activeScorer.evaluatorId
      )
    ).toMatchObject({ queued: 1, running: 1, completed: 0, total: 2 })
    expect(
      page.scorerProgress?.find(
        (scorer) => scorer.evaluatorId === pendingScorer.id
      )
    ).toMatchObject({ queued: 2, running: 0, total: 2 })
    expect(page.rows?.[0].scorerStatuses).toEqual({
      [activeScorer.evaluatorId]: "running",
      [pendingScorer.id]: "queued",
    })
    const next = await run(
      reader.getEvalRun(started.id, { limit: 1, cursor: page.nextCursor })
    )
    expect(Object.values(next.rows![0].scorerStatuses!)).toEqual([
      "queued",
      "queued",
    ])
    expect(next.scorerProgress).toEqual(page.scorerProgress)

    // A stopped worker must never remain "running" or "queued" in a terminal experiment.
    await db
      .update(evalRuns)
      .set({ status: "failed" })
      .where(eq(evalRuns.id, started.id))
    const interrupted = await run(reader.getEvalRun(started.id))
    expect(
      interrupted.scorerProgress?.find(
        (scorer) => scorer.evaluatorId === activeScorer.evaluatorId
      )
    ).toMatchObject({ queued: 0, running: 0, error: 1, skipped: 1 })
    expect(
      interrupted.scorerProgress?.find(
        (scorer) => scorer.evaluatorId === pendingScorer.id
      )
    ).toMatchObject({ queued: 0, running: 0, skipped: 2 })
    await db
      .update(evalRuns)
      .set({ status: "running" })
      .where(eq(evalRuns.id, started.id))
    release.resolve()
    let finished = await run(reader.getEvalRun(started.id))
    const deadline = Date.now() + 10_000
    while (finished.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      finished = await run(reader.getEvalRun(started.id))
    }
    expect(finished.status).toBe("completed")
    expect(
      finished.scorerProgress?.map((scorer) => ({
        completed: scorer.completed,
        queued: scorer.queued,
        running: scorer.running,
        score: scorer.score,
      }))
    ).toEqual([
      { completed: 2, queued: 0, running: 0, score: 1 },
      { completed: 2, queued: 0, running: 0, score: 1 },
    ])
  } finally {
    release.resolve()
    if (runId) {
      const deadline = Date.now() + 10_000
      while (
        (await run(reader.getEvalRun(runId))).status === "running" &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    if (previousUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = previousUrl
    judge.stop()
    await closeTracerDatabase(readerDb)
    await closeTracerFixture(db)
  }
}, 30_000)
