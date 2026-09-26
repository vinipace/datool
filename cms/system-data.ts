import type { Pool, PoolClient } from "pg"
import { analyticsDb } from "@/lib/db"
import { isSystemAdmin } from "./access"
import {
  systemFilters,
  type SystemFilters,
  type SystemOrganization,
  type SystemOrganizationDetail,
  type SystemOverview,
  type UsageMonth,
} from "@/src/lib/system-overview"

const pageSize = 25
const number = (value: unknown) =>
  value === null || value === undefined ? null : Number(value)
const date = (value: Date | null) => value?.toISOString() ?? null

type OrganizationRow = {
  id: string
  name: string
  slug: string
  created_at: Date
  plan: string | null
  status: string
  current_period_end: Date | null
  cancel_at_period_end: boolean | null
  synced_at: Date | null
  grace_until: Date | null
  next_payment_attempt: Date | null
  customer_id: string | null
  subscription_id: string | null
  record_limit: number | null
  retention_days: number | null
  traces: string | null
  spans: string | null
  metered_used: string | null
  members: string
  projects: string
}

function organization(row: OrganizationRow): SystemOrganization {
  const traces = Number(row.traces ?? 0),
    spans = Number(row.spans ?? 0)
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: row.created_at.toISOString(),
    plan: row.plan,
    status: row.status,
    periodEnd: date(row.current_period_end),
    cancelAtPeriodEnd: !!row.cancel_at_period_end,
    syncedAt: date(row.synced_at),
    graceUntil: date(row.grace_until),
    nextPaymentAttempt: date(row.next_payment_attempt),
    customerId: row.customer_id,
    subscriptionId: row.subscription_id,
    recordLimit: row.record_limit,
    retentionDays: row.retention_days,
    traces,
    spans,
    used: traces + spans,
    meteredUsed: number(row.metered_used),
    members: Number(row.members),
    projects: Number(row.projects),
  }
}

const columns = `o.id,o.name,o.slug,o."createdAt" AS created_at,
  b.plan,COALESCE(b.status,'none') AS status,b.current_period_end,b.cancel_at_period_end,
  b.synced_at,b.grace_until,b.next_payment_attempt,b.customer_id,b.subscription_id,
  b.record_limit,b.retention_days,a.traces,a.spans,u.traces+u.spans AS metered_used,
  (SELECT count(*) FROM member WHERE "organizationId"=o.id) AS members,
  (SELECT count(*) FROM project WHERE organization_id=o.id) AS projects`
const from = `FROM organization o JOIN selected ON selected.id=o.id
  LEFT JOIN organization_billing b ON b.organization_id=o.id
  LEFT JOIN activity a ON a.organization_id=o.id
  LEFT JOIN organization_usage_month u ON u.organization_id=o.id AND u.period_start=$1::date`
const where = `WHERE ($2='' OR o.name ILIKE $2 ESCAPE '\\' OR o.slug ILIKE $2 ESCAPE '\\' OR o.id ILIKE $2 ESCAPE '\\')
  AND ($3='all' OR COALESCE(b.status,'none')=$3)
  AND ($4='all' OR COALESCE(b.plan,'none')=$4)`
const values = (filters: SystemFilters) => [
  `${filters.month}-01`,
  filters.q ? `%${filters.q.replace(/[\\%_]/g, "\\$&")}%` : "",
  filters.status,
  filters.plan,
]

/** Count retained records without touching billing counters or copying payloads.
 * The project/time predicates use the existing started_at_ms indexes, including
 * for historical imports with offset timestamps. Month boundaries are UTC. */
function activitySnapshot(history = false) {
  const start = history ? "$1::date - interval '11 months'" : "$1::date"
  const sources = (["traces", "spans"] as const).map(
    (table) => `
    SELECT p.organization_id,
      ${history ? "date_trunc('month',to_timestamp(r.started_at_ms/1000) AT TIME ZONE 'UTC')::date AS month," : ""}
      ${table === "traces" ? "count(*)" : "0::bigint"} AS traces,
      ${table === "spans" ? "count(*)" : "0::bigint"} AS spans
    FROM selected JOIN project p ON p.organization_id=selected.id
    JOIN ${table} r ON r.project_id=p.id
      AND r.started_at_ms >= extract(epoch FROM ((${start})::timestamp AT TIME ZONE 'UTC'))*1000
      AND r.started_at_ms < extract(epoch FROM (($1::date + interval '1 month') AT TIME ZONE 'UTC'))*1000
    GROUP BY p.organization_id${history ? ",month" : ""}`
  )
  return `WITH selected AS MATERIALIZED (
    SELECT o.id FROM organization o LEFT JOIN organization_billing b ON b.organization_id=o.id
    ${where} AND ($5::text IS NULL OR o.id=$5)
  ), record_counts AS (${sources.join(" UNION ALL ")}), activity AS (
    SELECT organization_id,${history ? "month," : ""}sum(traces) AS traces,sum(spans) AS spans
    FROM record_counts GROUP BY organization_id${history ? ",month" : ""}
  )`
}

async function readSnapshot<T>(
  user: unknown,
  pool: Pool,
  read: (client: PoolClient) => Promise<T>
) {
  if (!isSystemAdmin(user))
    throw new Error("System administrator access required.")
  const client = await pool.connect()
  try {
    // These screens never refresh Stripe or write billing/usage state.
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
    )
    const result = await read(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

function environment() {
  const key = process.env.STRIPE_SECRET_KEY ?? ""
  return {
    currentMonth: new Date().toISOString().slice(0, 7),
    capturedAt: new Date().toISOString(),
    billingEnabled: process.env.DATOOL_BILLING_ENABLED === "true",
    stripeBase: /^(sk|rk)_test_/.test(key)
      ? "https://dashboard.stripe.com/test"
      : /^(sk|rk)_live_/.test(key)
        ? "https://dashboard.stripe.com"
        : null,
  }
}

async function history(
  client: PoolClient,
  filters: SystemFilters,
  organizationId: string | null = null
): Promise<UsageMonth[]> {
  const result = await client.query<{
    month: string
    traces: string
    spans: string
    organizations: string
  }>(
    `${activitySnapshot(true)}, totals AS (
    SELECT month,sum(traces) AS traces,sum(spans) AS spans,count(*) AS organizations
    FROM activity GROUP BY month
  ) SELECT to_char(m.month,'YYYY-MM') AS month,COALESCE(t.traces,0) AS traces,
    COALESCE(t.spans,0) AS spans,COALESCE(t.organizations,0) AS organizations
    FROM generate_series($1::date-interval '11 months',$1::date,interval '1 month') m(month)
    LEFT JOIN totals t ON t.month=m.month::date ORDER BY m.month`,
    [...values(filters), organizationId]
  )
  return result.rows.map((row) => ({
    month: row.month,
    traces: Number(row.traces),
    spans: Number(row.spans),
    used: Number(row.traces) + Number(row.spans),
    organizations: Number(row.organizations),
  }))
}

export async function getSystemOverview(
  user: unknown,
  params: Record<string, unknown>,
  pool = analyticsDb
): Promise<SystemOverview> {
  return readSnapshot(user, pool, async (client) => {
    const filters = systemFilters(params)
    const summary = (
      await client.query<{
        total: string
        active: string
        past_due: string
        canceling: string
        active_organizations: string
        traces: string
        spans: string
      }>(
        `${activitySnapshot()} SELECT count(*) AS total,count(*) FILTER (WHERE b.status='active') AS active,
      count(*) FILTER (WHERE b.status='past_due') AS past_due,
      count(*) FILTER (WHERE b.cancel_at_period_end) AS canceling,
      count(a.organization_id) AS active_organizations,
      COALESCE(sum(a.traces),0) AS traces,COALESCE(sum(a.spans),0) AS spans
      ${from}`,
        [...values(filters), null]
      )
    ).rows[0]
    const pages = Math.max(1, Math.ceil(Number(summary.total) / pageSize))
    filters.page = Math.min(filters.page, pages)
    const rows = await client.query<OrganizationRow>(
      `${activitySnapshot()} SELECT ${columns} ${from}
      ORDER BY ${filters.sort === "usage" ? "COALESCE(a.traces+a.spans,0) DESC," : ""} lower(o.name),o.id LIMIT $6 OFFSET $7`,
      [...values(filters), null, pageSize, (filters.page - 1) * pageSize]
    )
    return {
      ...environment(),
      filters,
      rows: rows.rows.map(organization),
      total: Number(summary.total),
      pages,
      summary: {
        active: Number(summary.active),
        pastDue: Number(summary.past_due),
        canceling: Number(summary.canceling),
        activeOrganizations: Number(summary.active_organizations),
        traces: Number(summary.traces),
        spans: Number(summary.spans),
        used: Number(summary.traces) + Number(summary.spans),
      },
      history: await history(client, filters),
    }
  })
}

export async function getSystemOrganization(
  user: unknown,
  id: string,
  pool = analyticsDb
): Promise<SystemOrganizationDetail | null> {
  return readSnapshot(user, pool, async (client) => {
    const filters = systemFilters()
    const row = (
      await client.query<OrganizationRow>(
        `${activitySnapshot()} SELECT ${columns} ${from}`,
        [...values(filters), id]
      )
    ).rows[0]
    if (!row) return null
    const projects = await client.query<{
      id: string
      name: string
      slug: string
      created_at: Date
    }>(
      "SELECT id,name,slug,created_at FROM project WHERE organization_id=$1 ORDER BY lower(name),id LIMIT 100",
      [id]
    )
    return {
      ...environment(),
      organization: organization(row),
      history: await history(client, filters, id),
      projects: projects.rows.map((project) => ({
        ...project,
        createdAt: project.created_at.toISOString(),
      })),
    }
  })
}
