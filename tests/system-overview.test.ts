import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import assert from "node:assert/strict"
import { getSystemOrganization, getSystemOverview } from "../cms/system-data"
import { isSystemAdmin } from "../cms/access"
import { systemFilters } from "../src/lib/system-overview"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  type IsolatedPostgres,
} from "./helpers/postgres"

describe("read-only system oversight", () => {
  let target: IsolatedPostgres
  let pool: Pool
  const admin = { collection: "cms-users", authUserId: "system-test-admin" }
  const saved = {
    cms: process.env.CMS_ADMIN_USER_IDS,
    system: process.env.SYSTEM_ADMIN_USER_IDS,
    billing: process.env.DATOOL_BILLING_ENABLED,
  }
  const month = new Date().toISOString().slice(0, 7)
  const prior = new Date(`${month}-01T00:00:00Z`)
  prior.setUTCMonth(prior.getUTCMonth() - 1)
  const priorMonth = prior.toISOString().slice(0, 7)
  beforeAll(async () => {
    process.env.CMS_ADMIN_USER_IDS = "system-test-admin,content-editor"
    process.env.SYSTEM_ADMIN_USER_IDS = "system-test-admin"
    process.env.DATOOL_BILLING_ENABLED = "false"
    target = await createIsolatedPostgres()
    await migrateIsolatedPostgres(target)
    const databaseUrl = new URL(target.databaseUrl)
    databaseUrl.searchParams.set(
      "options",
      `${databaseUrl.searchParams.get("options")} -c timezone=America/Sao_Paulo`
    )
    pool = new Pool({ connectionString: databaseUrl.toString() })
    await pool.query(
      `INSERT INTO organization(id,name,slug) SELECT 'org-'||n,'Organization '||lpad(n::text,2,'0'),'org-'||n FROM generate_series(1,30) n`
    )
    await pool.query(`INSERT INTO organization_billing(organization_id,checkout_attempt_id,plan,status,record_limit,synced_at,cancel_at_period_end)
      VALUES ('org-1','attempt-1','core','active',1000,'2020-01-01T00:00:00Z',true),('org-2','attempt-2','pro','past_due',10000,'2020-01-02T00:00:00Z',false)`)
    await pool.query(
      `INSERT INTO organization_usage_month VALUES ('org-1',$1,10,90),('org-2',$1,0,0),('org-1',$2,3,7)`,
      [`${month}-01`, `${priorMonth}-01`]
    )
    await pool.query(
      `INSERT INTO "user"(id,name,email,"emailVerified") VALUES ('user-1','Owner','owner@system.test',true),('user-2','Member','member@system.test',true)`
    )
    await pool.query(
      `INSERT INTO member(id,"organizationId","userId",role) VALUES ('m1','org-1','user-1','owner'),('m2','org-1','user-2','member')`
    )
    await pool.query(
      `INSERT INTO project(id,organization_id,name,slug) VALUES ('p1','org-1','Alpha','alpha'),('p2','org-1','Beta','beta'),('p3','org-2','Private other project','other'),('p4','org-3','Unbilled','unbilled'),('p30','org-30','Beyond first page','last')`
    )
    const old = new Date(`${month}-01T00:00:00Z`)
    old.setUTCMonth(old.getUTCMonth() - 12)
    const next = new Date(`${month}-01T00:00:00Z`)
    next.setUTCMonth(next.getUTCMonth() + 1)
    for (const [id, project, startedAt] of [
      ["t1", "p1", `${month}-01T00:00:00Z`],
      ["t2", "p2", `${month}-02T00:00:00Z`],
      ["t-prior", "p1", `${priorMonth}-01T00:00:00Z`],
      ["t-offset", "p2", `${month}-01T00:30:00+01:00`],
      ["t-other", "p3", `${month}-01T00:00:00Z`],
      ["t-unbilled", "p4", `${month}-01T00:00:00Z`],
      ["t-last", "p30", `${month}-01T00:00:00Z`],
      ["t-old", "p1", old.toISOString()],
      ["t-future", "p1", next.toISOString()],
      ["t-invalid", "p1", "invalid"],
    ]) {
      await pool.query(
        `INSERT INTO traces(id,project_id,name,operation,status,started_at)
         VALUES($1,$2,'Historical trace','test','completed',$3)`,
        [id, project, startedAt]
      )
    }
    for (const [id, project, trace, startedAt] of [
      ["s1", "p1", "t1", `${month}-01T00:00:00Z`],
      ["s2", "p1", "t1", `${month}-01T00:00:01Z`],
      // A span belongs to its own start month, even if its trace started earlier.
      ["s-cross-month", "p1", "t-prior", `${month}-01T00:00:00Z`],
      ["s-prior", "p1", "t-prior", `${priorMonth}-01T00:00:00Z`],
      ["s-other", "p3", "t-other", `${month}-01T00:00:00Z`],
      ["s-unbilled-1", "p4", "t-unbilled", `${month}-01T00:00:00Z`],
      ["s-unbilled-2", "p4", "t-unbilled", `${month}-01T00:00:01Z`],
    ]) {
      await pool.query(
        `INSERT INTO spans(id,project_id,trace_id,name,kind,status,started_at)
         VALUES($1,$2,$3,'Historical span','tool','completed',$4)`,
        [id, project, trace, startedAt]
      )
    }
  })
  afterAll(async () => {
    for (const [key, value] of [
      ["CMS_ADMIN_USER_IDS", saved.cms],
      ["SYSTEM_ADMIN_USER_IDS", saved.system],
      ["DATOOL_BILLING_ENABLED", saved.billing],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await pool?.end()
    await target?.close()
  })
  test("content editors and organization owners do not inherit system access", async () => {
    for (const user of [
      null,
      { collection: "cms-users", authUserId: "content-editor" },
      { id: "system-test-admin", role: "owner" },
      { collection: "cms-users", authUserId: "outsider" },
    ]) {
      expect(isSystemAdmin(user)).toBe(false)
      await assert.rejects(
        getSystemOverview(user, {}, pool),
        /System administrator access required/
      )
      await assert.rejects(
        getSystemOrganization(user, "org-1", pool),
        /System administrator access required/
      )
    }
  })
  test("summaries include every matching organization, with stable bounded pagination", async () => {
    const data = await getSystemOverview(admin, {}, pool)
    expect(data.total).toBe(30)
    expect(data.rows).toHaveLength(25)
    expect(data.pages).toBe(2)
    expect(data.summary).toEqual({
      active: 1,
      pastDue: 1,
      canceling: 1,
      activeOrganizations: 4,
      traces: 5,
      spans: 6,
      used: 11,
    })
    const last = await getSystemOverview(admin, { page: "999" }, pool)
    expect(last.filters.page).toBe(2)
    expect(last.rows).toHaveLength(5)
    expect(
      new Set([...data.rows, ...last.rows].map((row) => row.id)).size
    ).toBe(30)
  })
  test("retained activity works without billing and keeps quota counters separate", async () => {
    const before = (
      await pool.query(
        "SELECT * FROM organization_usage_month ORDER BY organization_id,period_start"
      )
    ).rows
    const data = await getSystemOverview(admin, { sort: "usage" }, pool)
    expect(data.billingEnabled).toBe(false)
    expect(data.rows[0].id).toBe("org-1")
    expect(data.rows[0].used).toBe(5)
    expect(data.rows[0].meteredUsed).toBe(100)
    expect(data.rows[1].id).toBe("org-3")
    expect(data.rows[1].used).toBe(3)
    expect(data.rows[1].meteredUsed).toBeNull()
    expect(data.rows[2].used).toBe(2)
    expect(data.rows[2].meteredUsed).toBe(0)
    expect(data.rows[4].used).toBe(0)
    expect(data.history.at(-1)?.used).toBe(11)
    expect(data.history.at(-2)?.used).toBe(3)
    expect(data.history[0].used).toBe(0)
    expect(
      (
        await pool.query(
          "SELECT * FROM organization_usage_month ORDER BY organization_id,period_start"
        )
      ).rows
    ).toEqual(before)
  })
  test("search, plan, status and month filters apply to rows and summaries", async () => {
    const data = await getSystemOverview(
      admin,
      { q: "organization", plan: "core", status: "active", month: priorMonth },
      pool
    )
    expect(data.rows.map((row) => row.id)).toEqual(["org-1"])
    expect(data.summary.used).toBe(3)
    expect(data.rows[0].meteredUsed).toBe(10)
    expect(data.rows[0].members).toBe(2)
    expect(data.rows[0].projects).toBe(2)
    for (const q of ["%", "_", "' OR true --"]) {
      expect((await getSystemOverview(admin, { q }, pool)).total).toBe(0)
    }
    expect((await getSystemOverview(admin, { plan: "none" }, pool)).total).toBe(
      28
    )
  })
  test("organization detail stays scoped and never refreshes stale billing state", async () => {
    const before = (
      await pool.query(
        "SELECT * FROM organization_billing ORDER BY organization_id"
      )
    ).rows
    const detail = await getSystemOrganization(admin, "org-1", pool)
    expect(detail?.projects.map((project) => project.id)).toEqual(["p1", "p2"])
    expect(detail?.organization.syncedAt).toBe("2020-01-01T00:00:00.000Z")
    expect(detail?.organization.traces).toBe(2)
    expect(detail?.organization.spans).toBe(3)
    expect(detail?.organization.meteredUsed).toBe(100)
    expect(detail?.history.at(-1)?.used).toBe(5)
    expect(detail?.history.at(-2)?.used).toBe(3)
    expect(detail?.history).toHaveLength(12)
    expect(
      detail?.history.slice(0, -2).every((entry) => entry.used === 0)
    ).toBe(true)
    expect(await getSystemOrganization(admin, "missing", pool)).toBeNull()
    expect(
      (
        await pool.query(
          "SELECT * FROM organization_billing ORDER BY organization_id"
        )
      ).rows
    ).toEqual(before)
  })
  test("deletion reduces retained activity without refunding billing usage", async () => {
    await pool.query(
      `INSERT INTO traces(id,project_id,name,operation,status,started_at)
       VALUES('t-deleted','p1','Deleted trace','test','completed',$1)`,
      [`${month}-01T00:00:00Z`]
    )
    try {
      await pool.query(
        `INSERT INTO spans(id,project_id,trace_id,name,kind,status,started_at)
         VALUES('s-deleted','p1','t-deleted','Deleted span','tool','completed',$1)`,
        [`${month}-01T00:00:00Z`]
      )
      expect(
        (await getSystemOrganization(admin, "org-1", pool))?.organization.used
      ).toBe(7)
      await pool.query("DELETE FROM traces WHERE id='t-deleted'")
      const detail = await getSystemOrganization(admin, "org-1", pool)
      expect(detail?.organization.used).toBe(5)
      expect(detail?.history.at(-1)?.used).toBe(5)
      expect(detail?.organization.meteredUsed).toBe(100)
    } finally {
      await pool.query("DELETE FROM traces WHERE id='t-deleted'")
    }
  })
  test("empty filters return zero activity and no unrelated records", async () => {
    const data = await getSystemOverview(admin, { q: "does-not-exist" }, pool)
    expect(data.rows).toEqual([])
    expect(data.summary.used).toBe(0)
    expect(data.summary.activeOrganizations).toBe(0)
    expect(data.history.every((entry) => entry.used === 0)).toBe(true)
  })
})

test("untrusted filters are bounded and validated", () => {
  const filters = systemFilters(
    {
      q: "x".repeat(1000),
      month: "2026-13",
      status: "x",
      plan: "x",
      sort: "SQL",
      page: "-1",
    },
    new Date("2026-09-22T00:00:00Z")
  )
  expect(filters).toEqual({
    q: "x".repeat(120),
    month: "2026-09",
    status: "all",
    plan: "all",
    sort: "name",
    page: 1,
  })
})
