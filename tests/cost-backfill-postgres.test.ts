import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Pool } from "pg"
import { runCostBackfill } from "../scripts/backfill-missing-costs"
import { PricingCatalog } from "../src/lib/tracer/pricing-catalog"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"

test("backfill dry-run is read-only; apply updates stored cost facts and backups, and rerun is a no-op", async () => {
  const target = await createIsolatedPostgres()
  const backupDir = await mkdtemp(join(tmpdir(), "datool-cost-backfill-"))
  const previousUrl = process.env.DATABASE_URL
  const pool = new Pool({ connectionString: target.databaseUrl })
  try {
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    const attrs = {
      provider: "openai",
      model: "gpt-5.1",
      "usage.input_tokens": 1000,
      "usage.output_tokens": 100,
      "cost.status": "missing",
      "cost.reason": "Model rates unavailable in TokenLens",
    }
    await pool.query(
      `insert into traces(project_id,id,name,operation,status,started_at,ended_at,attributes_json)
      values($1,'trace','test','test','completed','2026-09-12T00:00:00Z','2026-09-12T00:01:00Z','{"cost.status":"missing"}')`,
      [target.projectId]
    )
    await pool.query(
      `insert into spans(project_id,id,trace_id,name,kind,status,started_at,ended_at,attributes_json)
      values($1,'llm','trace','model','llm','completed','2026-09-12T00:00:00Z','2026-09-12T00:01:00Z',$2)`,
      [target.projectId, JSON.stringify(attrs)]
    )
    process.env.DATABASE_URL = target.databaseUrl
    const pricing = new PricingCatalog({
      fetch: async () =>
        Response.json({
          openai: {
            id: "openai",
            models: {
              "gpt-5.1": { id: "gpt-5.1", cost: { input: 1.25, output: 10 } },
            },
          },
        }),
    })
    const options = {
      projectId: target.projectId,
      model: "gpt-5.1",
      after: "2026-09-11T00:00:00Z",
      before: "2026-09-13T00:00:00Z",
    }
    expect((await runCostBackfill(options, pricing)).pricedSpans).toBe(1)
    expect(
      (await pool.query("select cost_usd from spans where id='llm'")).rows[0]
        .cost_usd
    ).toBeNull()
    const backup = join(backupDir, "before.jsonl")
    expect(
      (await runCostBackfill({ ...options, apply: true, backup }, pricing))
        .pricedSpans
    ).toBe(1)
    for (const table of ["spans", "traces"]) {
      const result = await pool.query(
        `select cost_usd,cost_status from ${table}`
      )
      expect(result.rows[0].cost_status).toBe("estimated")
      expect(Math.abs(result.rows[0].cost_usd - 0.00225) < 1e-12).toBe(true)
    }
    const record = JSON.parse((await readFile(backup, "utf8")).trim())
    expect(record.spansBefore[0].attributes).toEqual(attrs)
    expect(
      (
        await runCostBackfill(
          { ...options, apply: true, backup: join(backupDir, "again.jsonl") },
          pricing
        )
      ).pricedSpans
    ).toBe(0)
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousUrl
    await pool.end()
    await target.close()
    await rm(backupDir, { recursive: true, force: true })
  }
})
