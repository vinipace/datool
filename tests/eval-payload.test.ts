import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import type {
  EvalRunDetail,
  EvalRunComparison,
} from "../src/lib/tracer/contracts"
import { eq } from "drizzle-orm"
import { registerTracerProjectId } from "../src/server/tracer/db"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import { TracerService } from "../src/server/tracer/service"
import {
  evalRuns,
  evalRunTargets,
  spans,
  traces,
} from "../src/server/tracer/schema"
import {
  closeTracerFixture,
  createTracerFixture,
  scopeRows,
} from "./helpers/tracer-fixture"
import {
  ReadBudgetError,
  READ_MAX_BYTES,
} from "../src/server/semantic/read-budget"
import { fitEvalPage } from "../src/server/tracer/eval-read-page"

const time = "2026-09-18T00:00:00Z"
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

test("eval tables exclude frozen and scorer spans, while a scoped target read preserves them", async () => {
  const db = await createTracerFixture()
  const service = new TracerService(db)
  try {
    await db.insert(evalRuns).values(
      scopeRows(
        db,
        ["run", "other"].map((id) => ({
          id,
          status: "completed",
          createdAt: time,
        }))
      )
    )
    const trace = await run(
      service.createTrace({
        name: "Live trace",
        input: "Original input",
        output: "Original output",
        status: "completed",
      })
    )
    const frozenSpan = {
      id: "frozen-span",
      traceId: trace.id,
      parentId: null,
      name: "Frozen evidence",
      kind: "llm",
      status: "completed",
      startedAt: time,
      endedAt: time,
      durationMs: 0,
      input: "x".repeat(220_000),
      output: "Frozen span output",
      attributes: {},
    }
    const snapshot = JSON.stringify({
      trace: { ...trace, spans: [frozenSpan] },
      datasetItem: null,
    })
    expect(Buffer.byteLength(snapshot) * 50).toBeGreaterThan(READ_MAX_BYTES)
    await db.insert(evalRunTargets).values(
      scopeRows(
        db,
        Array.from({ length: 60 }, (_, ordinal) => ({
          id: `target-${ordinal}`,
          runId: "run",
          traceId: trace.id,
          ordinal,
          createdAt: time,
          snapshotJson: snapshot,
        }))
      )
    )
    await db
      .insert(spans)
      .values(
        scopeRows(db, {
          id: "scorer-span",
          traceId: trace.id,
          name: "Scorer execution",
          kind: "llm",
          status: "completed",
          startedAt: time,
          inputJson: JSON.stringify("y".repeat(220_000)),
          attributesJson: JSON.stringify({
            "eval.run_id": "run",
            "eval.target_id": "target-0",
          }),
        })
      )
    await db
      .update(traces)
      .set({
        inputJson: '"Changed live input"',
        outputJson: '"Changed live output"',
      })
      .where(eq(traces.id, trace.id))

    const first = await run(
      service.getEvalRun("run", { includeEvidence: false })
    )
    expect(first.rows).toHaveLength(50)
    expect(first.targetCount).toBe(60)
    expect(bytes(first)).toBeLessThan(100_000)
    expect(first.rows![0].scoringTrace).toBeUndefined()
    expect("spans" in first.rows![0].trace).toBe(false)
    expect(first.rows![0].trace.input).toBe("Original input")
    expect(first.rows![0].trace.output).toBe("Original output")
    const last = await run(
      service.getEvalRun("run", {
        includeEvidence: false,
        cursor: first.nextCursor,
      })
    )
    expect(last.rows).toHaveLength(10)
    expect(last.nextCursor).toBeNull()
    const detail = await run(service.getEvalRunTarget("run", "target-0"))
    expect(detail.scoringTrace?.input).toBe("Original input")
    expect(detail.scoringTrace?.spans.map((span) => span.id)).toEqual([
      "frozen-span",
      "scorer-span",
    ])
    expect(detail.scoringTrace?.spans[0].input).toBe(frozenSpan.input)
    await rejects(run(service.getEvalRunTarget("other", "target-0")), {
      code: "NOT_FOUND",
    })
    await rejects(run(service.getEvalRunTarget("run", "missing")), {
      code: "NOT_FOUND",
    })
    // A target from another project must not be visible, even with a known id.
    registerTracerProjectId(db, crypto.randomUUID())
    await rejects(
      run(new TracerService(db).getEvalRunTarget("run", "target-0")),
      { code: "NOT_FOUND" }
    )
  } finally {
    await closeTracerFixture(db)
  }
}, 30_000)

test("large eval values shrink batches without losing cases or comparison matches", async () => {
  const db = await createTracerFixture()
  const service = new TracerService(db)
  try {
    await db.insert(evalRuns).values(
      scopeRows(
        db,
        ["left", "right"].map((id) => ({
          id,
          status: "completed",
          createdAt: time,
        }))
      )
    )
    const output = "完整内容".repeat(25_000)
    const trace = await run(
      service.createTrace({
        name: "Large result",
        input: "Question",
        output,
        status: "completed",
      })
    )
    for (const side of ["left", "right"]) {
      await db.insert(evalRunTargets).values(
        scopeRows(
          db,
          Array.from({ length: 60 }, (_, ordinal) => ({
            id: `${side}-${ordinal}`,
            runId: side,
            traceId: trace.id,
            ordinal,
            createdAt: time,
            snapshotJson: JSON.stringify({
              trace: { ...trace, input: { ordinal } },
              datasetItem: null,
            }),
          }))
        )
      )
    }
    const ids = new Set<string>()
    let cursor: string | null = null
    do {
      const page: EvalRunDetail = await run(
        service.getEvalRun("left", { includeEvidence: false, cursor })
      )
      expect(bytes(page)).toBeLessThanOrEqual(READ_MAX_BYTES)
      expect(page.rows!.length).toBeLessThan(50)
      for (const row of page.rows!) {
        expect(ids.has(row.id)).toBe(false)
        expect(row.trace.output).toBe(output)
        ids.add(row.id)
      }
      cursor = page.nextCursor ?? null
    } while (cursor)
    expect(ids.size).toBe(60)
    let offset: number | null = 0
    const compared = new Set<string>()
    do {
      const page: EvalRunComparison = await run(
        service.compareEvalRuns("left", "right", offset, false)
      )
      expect(bytes(page)).toBeLessThanOrEqual(READ_MAX_BYTES)
      expect(page.total).toBe(60)
      for (const pair of page.pairs) {
        expect(compared.has(pair.id)).toBe(false)
        expect(pair.left?.trace.input).toEqual(pair.right?.trace.input)
        expect(pair.left?.trace.output).toBe(output)
        compared.add(pair.id)
      }
      offset = page.nextOffset
    } while (offset !== null)
    expect(compared.size).toBe(60)
  } finally {
    await closeTracerFixture(db)
  }
}, 60_000)

test("batch reduction stops at one and never retries unrelated errors", async () => {
  const attempts: number[] = []
  const tooLarge = new ReadBudgetError("READ_RESULT_TOO_LARGE", "Too large")
  await rejects(
    fitEvalPage(4, async (limit) => {
      attempts.push(limit)
      throw tooLarge
    }),
    (error) => error === tooLarge
  )
  expect(attempts).toEqual([4, 2, 1])
  const failed: number[] = []
  const timeout = new ReadBudgetError("READ_TIMEOUT", "Timed out")
  await rejects(
    fitEvalPage(50, async (limit) => {
      failed.push(limit)
      throw timeout
    }),
    (error) => error === timeout
  )
  expect(failed).toEqual([50])
})
