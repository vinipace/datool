import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { Pool } from "pg"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
} from "./helpers/postgres"

test("privacy health monitors real pending deadlines without exporting or changing requests", async () => {
  const target = await createIsolatedPostgres()
  const pool = new Pool({ connectionString: target.databaseUrl })
  const check = (databaseUrl = target.databaseUrl) =>
    spawnSync(
      process.execPath,
      ["--no-env-file", "scripts/shopify-privacy.ts", "health"],
      {
        encoding: "utf8",
        timeout: 15000,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          DATABASE_URL: databaseUrl,
        },
      }
    )
  try {
    await migrateIsolatedPostgres(target)
    const empty = check()
    expect(empty.status).toBe(0)
    expect(JSON.parse(empty.stdout)).toEqual({
      status: "healthy",
      pending: 0,
      overdue: 0,
      dueSoon: 0,
      nextDueAt: null,
    })
    await pool.query(`INSERT INTO shopify_privacy_requests
      (id, client_id, shop, topic, payload_encrypted, due_at) VALUES
      ('late', 'private-app', 'private-store.myshopify.com', 'CUSTOMERS_REDACT', 'private-payload', now()-interval '1 day'),
      ('soon', 'private-app', 'private-store.myshopify.com', 'CUSTOMERS_DATA_REQUEST', 'private-payload', now()+interval '2 days'),
      ('later', 'private-app', 'private-store.myshopify.com', 'SHOP_REDACT', 'private-payload', now()+interval '20 days')`)
    const before = await pool.query(
      "SELECT * FROM shopify_privacy_requests ORDER BY id"
    )
    const urgent = check()
    expect(urgent.status).toBe(1)
    expect(JSON.parse(urgent.stdout)).toMatchObject({
      status: "action_required",
      pending: 3,
      overdue: 1,
      dueSoon: 1,
    })
    expect(`${urgent.stdout}${urgent.stderr}`).not.toContain("private-")
    expect(
      (await pool.query("SELECT * FROM shopify_privacy_requests ORDER BY id"))
        .rows
    ).toEqual(before.rows)
    await pool.query(`UPDATE shopify_privacy_requests SET
      completed_at=now(), completion_reference='synthetic-evidence', shop=NULL,
      payload_encrypted=NULL WHERE id IN ('late','soon')`)
    const remaining = check()
    expect(remaining.status).toBe(0)
    expect(JSON.parse(remaining.stdout)).toMatchObject({
      status: "healthy",
      pending: 1,
      overdue: 0,
      dueSoon: 0,
    })
    const unavailable = check(
      "postgresql://private-user:private-password@127.0.0.1:1/private-db"
    )
    expect(unavailable.status).toBe(1)
    expect(JSON.parse(unavailable.stdout)).toEqual({ status: "unavailable" })
    expect(`${unavailable.stdout}${unavailable.stderr}`).not.toContain(
      "private-"
    )
  } finally {
    await pool.end()
    await target.close()
  }
}, 30000)
