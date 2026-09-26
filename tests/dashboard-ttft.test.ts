import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { Pool } from "pg"
import {
  closeTracerDatabase,
  createTracerDatabase,
} from "../src/server/tracer/db"
import { semanticCatalog } from "../src/server/metrics/registry"
import { executeSemanticQuery } from "../src/server/semantic/executor"
import { createSemanticSnapshotRunner } from "../src/server/semantic/snapshot"
import { createIsolatedPostgres, seedTestWorkspace } from "./helpers/postgres"

test("AI SDK TTFT migration recovers recorded timings and keeps SQL aggregates sample-based", async () => {
  const target = await createIsolatedPostgres()
  const pool = new Pool({ connectionString: target.databaseUrl })
  const db = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  const migrationName = "0010_ai_sdk_ttft.sql"
  const cases = [
    {
      id: "explicit",
      attributes: {
        "ttft.ms": 100,
        "latency.ttft_ms": 999,
        "gen_ai.latency.time_to_first_token": 9,
        "ai.response.msToFirstChunk": 999,
      },
      before: 100,
      after: 100,
    },
    {
      id: "latency",
      attributes: { "latency.ttft_ms": 150 },
      before: 150,
      after: 150,
    },
    {
      id: "seconds",
      attributes: { "gen_ai.latency.time_to_first_token": 0.2 },
      before: 200,
      after: 200,
    },
    {
      id: "current",
      attributes: { "ai.response.msToFirstChunk": 250 },
      before: null,
      after: 250,
    },
    {
      id: "legacy",
      attributes: { "ai.stream.msToFirstChunk": 300 },
      before: null,
      after: 300,
    },
    {
      id: "both",
      attributes: {
        "ai.response.msToFirstChunk": 350,
        "ai.stream.msToFirstChunk": 999,
      },
      before: null,
      after: 350,
    },
    {
      id: "fallback",
      attributes: {
        "ttft.ms": -1,
        "ai.response.msToFirstChunk": "invalid",
        "ai.stream.msToFirstChunk": 400,
      },
      before: null,
      after: 400,
    },
    {
      id: "zero",
      attributes: {
        "ai.response.msToFirstChunk": 0,
        "ai.stream.msToFirstChunk": 999,
      },
      before: null,
      after: 0,
    },
    {
      id: "null-fallback",
      attributes: {
        "ai.response.msToFirstChunk": null,
        "ai.stream.msToFirstChunk": 500,
      },
      before: null,
      after: 500,
    },
    { id: "missing", attributes: {}, before: null, after: null },
    {
      id: "negative",
      attributes: { "ai.response.msToFirstChunk": -10 },
      before: null,
      after: null,
    },
    {
      id: "string",
      attributes: { "ai.response.msToFirstChunk": "250" },
      before: null,
      after: null,
    },
    {
      id: "object",
      attributes: { "ai.response.msToFirstChunk": {} },
      before: null,
      after: null,
    },
    {
      id: "boolean",
      attributes: { "ai.response.msToFirstChunk": true },
      before: null,
      after: null,
    },
  ]
  try {
    // Seed an installation before the forward migration, including raw timing
    // fields that the old generated column could not recognize.
    for (const file of (await readdir("migrations"))
      .filter((file) => file.endsWith(".sql") && file < migrationName)
      .sort()) {
      await pool.query(await readFile(`migrations/${file}`, "utf8"))
    }
    await seedTestWorkspace(target)
    await pool.query(
      `insert into traces(project_id,id,name,operation,status,started_at,ended_at,attributes_json)
       values($1,'root','Streaming test','test','completed','2026-09-11T00:00:00Z','2026-09-11T00:00:10Z','{"ai.response.msToFirstChunk":9000}')`,
      [target.projectId]
    )
    const insert = (id: string, kind: string, attributes: object) =>
      pool.query(
        `insert into spans(project_id,id,trace_id,name,kind,status,started_at,ended_at,attributes_json)
       values($1,$2,'root',$2,$3,'completed','2026-09-11T00:00:00Z','2026-09-11T00:00:05Z',$4)`,
        [target.projectId, id, kind, JSON.stringify(attributes)]
      )
    for (const entry of cases) await insert(entry.id, "llm", entry.attributes)
    // Inclusive wrappers must never be counted as additional LLM samples.
    await insert("wrapper", "function", { "ai.response.msToFirstChunk": 9999 })
    const rows = async () =>
      (await pool.query("select id, ttft_ms, attributes_json from spans")).rows
    const before = new Map((await rows()).map((row) => [row.id, row.ttft_ms]))
    for (const entry of cases) expect(before.get(entry.id)).toBe(entry.before)

    const migration = await readFile(`migrations/${migrationName}`, "utf8")
    await pool.query(migration)
    const after = new Map((await rows()).map((row) => [row.id, row]))
    for (const entry of cases) {
      expect(after.get(entry.id)?.ttft_ms).toBe(entry.after)
      expect(after.get(entry.id)?.attributes_json).toEqual(entry.attributes)
    }
    expect(
      (await pool.query("select ttft_ms from traces where id='root'")).rows[0]
        .ttft_ms
    ).toBe(9000)

    const execute = (filters: unknown[] = [], daily = false) =>
      executeSemanticQuery(
        {
          measures: ["logs.meanTtftMs", "logs.p95TtftMs"],
          timeDimensions: [
            {
              dimension: "logs.startedAt",
              dateRange: ["2026-09-11T00:00:00Z", "2026-09-12T00:00:00Z"],
              ...(daily ? { granularity: "day" } : {}),
            },
          ],
          filters,
        },
        {
          catalog: semanticCatalog,
          requestId: "ttft-test",
          snapshotRunner: createSemanticSnapshotRunner(db),
        }
      )
    const expected = { "logs.meanTtftMs": 250, "logs.p95TtftMs": 500 }
    expect((await execute()).data[0]).toMatchObject(expected)
    expect((await execute([], true)).data[0]).toMatchObject(expected)
    expect(
      (
        await execute([
          { member: "logs.spanName", operator: "equals", values: ["missing"] },
        ])
      ).data[0]
    ).toMatchObject({ "logs.meanTtftMs": null, "logs.p95TtftMs": null })

    await insert("new-stream", "llm", { "ai.response.msToFirstChunk": 600 })
    await pool.query("update spans set attributes_json=$1 where id='missing'", [
      JSON.stringify({ "ai.response.msToFirstChunk": 700 }),
    ])
    const updated = new Map((await rows()).map((row) => [row.id, row.ttft_ms]))
    expect(updated.get("new-stream")).toBe(600)
    expect(updated.get("missing")).toBe(700)
  } finally {
    await closeTracerDatabase(db)
    await pool.end()
    await target.close()
  }
})
