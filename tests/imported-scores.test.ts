import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { routeScopes } from "@/src/server/auth/request"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect as run } from "@/src/server/tracer/effect"
import {
  closeTracerDatabase,
  getTracerProjectId,
  registerTracerProjectId,
} from "@/src/server/tracer/db"
import {
  closeTracerFixture,
  createTracerFixture,
  reopenTracerFixture,
} from "./helpers/tracer-fixture"

const source = {
  provider: "external-evaluator",
  instance: "https://scores.example.com",
  projectId: "original-project",
  id: "original-score",
}
const record = {
  name: "Quality",
  timestamp: "2025-05-01T12:00:00Z",
  target: { type: "trace", id: "trace" },
  data: { type: "numeric", value: 8.5 },
  comment: "Original assessment",
  author: { id: "reviewer", name: "Reviewer" },
  metadata: { environment: "production" },
  raw: { untouched: [false, 0, null] },
}

test("score import permissions require eval access", async () => {
  expect(
    await routeScopes(new Request("https://datool.test/api/imported-scores"))
  ).toEqual(["evals:read"])
  expect(
    await routeScopes(
      new Request("https://datool.test/api/imported-scores", { method: "POST" })
    )
  ).toEqual(["evals:write"])
})

test("external values and provenance survive persistence, pagination and trace hydration without fabricated evals", async () => {
  const db = await createTracerFixture()
  const readerDb = reopenTracerFixture(db)
  try {
    const service = new TracerService(db),
      reader = new TracerService(readerDb)
    await run(service.createTrace({ id: "trace", name: "Trace" }))
    const values = [
      { type: "numeric", value: 8.5 },
      { type: "numeric", value: 0 },
      { type: "numeric", value: -2 },
      { type: "boolean", value: false },
      { type: "categorical", value: "acceptable" },
      { type: "text", value: "Detailed feedback" },
    ]
    for (const [i, data] of values.entries()) {
      const payload = {
        source: { ...source, id: String(i) },
        record: { ...record, data },
      }
      const saved = await run(service.importedScores.import(payload))
      expect(saved).toMatchObject({ status: "imported", reason: null })
      expect(await run(reader.importedScores.get(saved.id))).toMatchObject({
        payload,
        scoreId: saved.scoreId,
      })
    }
    const page = await run(reader.listTraceScores("trace", { limit: 2 }))
    expect(page.items).toHaveLength(2)
    expect(page.nextCursor).not.toBeNull()
    const second = await run(
      reader.listTraceScores("trace", { limit: 10, cursor: page.nextCursor })
    )
    expect(second.items).toHaveLength(4)
    const trace = await run(reader.getTrace("trace"))
    expect(trace.scores).toHaveLength(6)
    for (const data of values) {
      expect(
        trace.scores.find((s) => s.external?.data.value === data.value)
      ).toMatchObject({
        evaluatorId: null,
        evaluatorName: null,
        evalResultId: null,
        evalRunId: null,
        name: "Quality",
        valueLabel: String(data.value),
        score: data.type === "numeric" ? data.value : null,
        external: {
          source: { ...source, id: String(values.indexOf(data)) },
          data,
          author: record.author,
          timestamp: record.timestamp,
          target: record.target,
        },
      })
    }
    expect(
      (await db.execute(sql`select count(*)::int as count from eval_results`))
        .rows[0].count
    ).toBe(0)
    expect(
      (await db.execute(sql`select count(*)::int as count from evaluators`))
        .rows[0].count
    ).toBe(0)
    const metrics = await run(
      reader.querySemanticMetrics({
        measures: ["scores.scoredCount", "scores.executionCount"],
        timeDimensions: [
          {
            dimension: "scores.completedAt",
            dateRange: ["2025-05-01T00:00:00Z", "2025-05-02T00:00:00Z"],
          },
        ],
      })
    )
    expect(metrics.data[0]).toMatchObject({
      "scores.scoredCount": 0,
      "scores.executionCount": 0,
    })
  } finally {
    await closeTracerDatabase(readerDb)
    await closeTracerFixture(db)
  }
})

test("concurrent retries deduplicate by full source identity and conflicting payloads cannot overwrite evidence", async () => {
  const db = await createTracerFixture()
  try {
    const service = new TracerService(db)
    await run(service.createTrace({ id: "trace", name: "Trace" }))
    const payload = { source, record }
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        run(service.importedScores.import(payload))
      )
    )
    expect(new Set(attempts.map((a) => a.scoreId)).size).toBe(1)
    expect((await run(service.listTraceScores("trace"))).items).toHaveLength(1)
    // JSON key order is not part of record identity.
    expect(
      await run(
        service.importedScores.import({
          record,
          source: {
            id: source.id,
            projectId: source.projectId,
            instance: source.instance,
            provider: source.provider,
          },
        })
      )
    ).toEqual(attempts[0])
    await assert.rejects(
      run(
        service.importedScores.import({
          source,
          record: { ...record, data: { type: "numeric", value: 1 } },
        })
      ),
      /different payload/
    )
    expect(
      (await run(service.importedScores.get(attempts[0].id))).payload
    ).toEqual(payload)
    for (const changedSource of [
      { ...source, instance: "https://other.example" },
      { ...source, projectId: "other" },
      { ...source, provider: "other" },
    ])
      expect(
        (
          await run(
            service.importedScores.import({ source: changedSource, record })
          )
        ).scoreId
      ).not.toBe(attempts[0].scoreId)
    expect((await run(service.listTraceScores("trace"))).items).toHaveLength(4)
  } finally {
    await closeTracerFixture(db)
  }
})

test("unsupported and unresolved records remain readable and missing targets can be retried", async () => {
  const db = await createTracerFixture()
  try {
    const service = new TracerService(db)
    const pending = await run(service.importedScores.import({ source, record }))
    expect(pending).toMatchObject({ status: "unresolved", scoreId: null })
    const unsupportedPayload = {
      source: { ...source, id: "unsupported" },
      record: {
        ...record,
        data: { type: "correction", value: { expected: "new answer" } },
      },
    }
    const unsupported = await run(
      service.importedScores.import(unsupportedPayload)
    )
    expect(unsupported).toMatchObject({ status: "unsupported", scoreId: null })
    expect(unsupported.reason).toContain("data.type")
    expect(await run(service.importedScores.get(unsupported.id))).toMatchObject(
      { payload: unsupportedPayload }
    )
    await run(service.createTrace({ id: "trace", name: "Late trace" }))
    const retry = await run(service.importedScores.import({ source, record }))
    expect(retry).toMatchObject({ id: pending.id, status: "imported" })
    expect((await run(service.importedScores.list())).items).toHaveLength(2)
    expect((await run(service.listTraceScores("trace"))).items).toHaveLength(1)
    await assert.rejects(
      run(service.importedScores.import({ record })),
      /source identity/
    )
  } finally {
    await closeTracerFixture(db)
  }
})

test("span, session and run scores keep their targets; tenant boundaries are enforced for reads and writes", async () => {
  const db = await createTracerFixture(),
    otherDb = reopenTracerFixture(db)
  try {
    const projectId = getTracerProjectId(db),
      otherId = crypto.randomUUID()
    await db.execute(
      sql`insert into project(id,organization_id,name,slug,created_at,updated_at) select ${otherId},organization_id,'Other','other',created_at,updated_at from project where id=${projectId}`
    )
    registerTracerProjectId(otherDb, otherId)
    const service = new TracerService(db),
      other = new TracerService(otherDb)
    const session = await run(service.createSession({ id: "session" }))
    await run(
      service.createTrace({
        id: "trace",
        name: "Trace",
        sessionId: session.id,
        spans: [{ id: "span", name: "Span" }],
      })
    )
    await db.execute(
      sql`insert into eval_runs(id,project_id,status,created_at) values('run',${projectId},'completed',${record.timestamp})`
    )
    for (const target of [
      { type: "span", id: "span" },
      { type: "session", id: "session" },
      { type: "evalRun", id: "run" },
    ]) {
      const payload = {
        source: { ...source, id: target.type },
        record: { ...record, target },
      }
      const result = await run(service.importedScores.import(payload))
      expect(result.status).toBe("imported")
      const row = (
        await db.execute(
          sql`select trace_id,span_id,session_id,eval_run_id,external_json from scores where id=${result.scoreId}`
        )
      ).rows[0]
      expect(row.external_json).toMatchObject({ target })
      if (target.type === "span")
        expect(row).toMatchObject({
          trace_id: "trace",
          span_id: "span",
          session_id: null,
          eval_run_id: null,
        })
      if (target.type === "session")
        expect(row).toMatchObject({
          trace_id: null,
          span_id: null,
          session_id: "session",
          eval_run_id: null,
        })
      if (target.type === "evalRun")
        expect(row).toMatchObject({
          trace_id: null,
          span_id: null,
          session_id: null,
          eval_run_id: "run",
        })
      await assert.rejects(
        run(other.importedScores.get(result.id)),
        /was not found/
      )
      const foreign = await run(other.importedScores.import(payload))
      expect(foreign).toMatchObject({ status: "unresolved", scoreId: null })
      expect(foreign.id).not.toBe(result.id)
    }
    expect((await run(service.listTraceScores("trace"))).items).toHaveLength(1)
    const imported = (await run(service.importedScores.list())).items[0]
    await assert.rejects(
      Promise.resolve(
        db.execute(
          sql`update scores set project_id=${otherId} where import_id=${imported.id}`
        )
      )
    )
    await assert.rejects(
      Promise.resolve(
        db.execute(
          sql`insert into scores(id,project_id,trace_id,name,value,status,created_at) values('invalid',${projectId},'trace','No provenance',1,'ok',${record.timestamp})`
        )
      )
    )
    await db.execute(sql`delete from project where id=${projectId}`)
    expect(
      (
        await db.execute(
          sql`select count(*)::int as count from score_imports where project_id=${projectId}`
        )
      ).rows[0].count
    ).toBe(0)
    expect((await run(other.importedScores.list())).items).toHaveLength(3)
  } finally {
    await closeTracerDatabase(otherDb)
    await closeTracerFixture(db)
  }
})

test("deleting an imported target keeps its source record and reports the missing score", async () => {
  const db = await createTracerFixture()
  try {
    const service = new TracerService(db)
    await run(service.createTrace({ id: "trace", name: "Trace" }))
    const saved = await run(service.importedScores.import({ source, record }))
    await db.execute(sql`delete from traces where id='trace'`)
    expect(await run(service.importedScores.get(saved.id))).toMatchObject({
      status: "unresolved",
      scoreId: null,
      payload: { source, record },
    })
    expect((await run(service.importedScores.list())).items[0]).toMatchObject({
      status: "unresolved",
      scoreId: null,
    })
    expect(
      await run(service.importedScores.import({ source, record }))
    ).toMatchObject({ status: "unresolved", scoreId: null })
    await run(service.createTrace({ id: "trace", name: "Reimported" }))
    expect(
      await run(service.importedScores.import({ source, record }))
    ).toEqual(saved)
  } finally {
    await closeTracerFixture(db)
  }
})

test("a database write failure rolls back the import receipt and can be retried", async () => {
  const db = await createTracerFixture()
  try {
    const service = new TracerService(db)
    await run(service.createTrace({ id: "trace", name: "Trace" }))
    await db.execute(
      sql`create function reject_imported_score() returns trigger language plpgsql as $$ begin raise exception 'injected write failure'; end $$`
    )
    await db.execute(
      sql`create trigger reject_imported_score before insert on scores for each row execute function reject_imported_score()`
    )
    await assert.rejects(run(service.importedScores.import({ source, record })))
    expect((await run(service.importedScores.list())).items).toHaveLength(0)
    expect((await run(service.listTraceScores("trace"))).items).toHaveLength(0)
    await db.execute(sql`drop trigger reject_imported_score on scores`)
    expect(
      (await run(service.importedScores.import({ source, record }))).status
    ).toBe("imported")
  } finally {
    await closeTracerFixture(db)
  }
})
