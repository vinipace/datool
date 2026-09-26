import { db } from "@/lib/db"
import type { CloudUsage } from "@/src/lib/billing"
import type { IngestionEvent } from "@/src/server/ingestion/events"
import { TracerError } from "@/src/server/tracer/errors"
import { billingEnabled } from "./config"
import { getBilling } from "./store"

export async function getCloudUsage(
  organizationId: string
): Promise<CloudUsage> {
  const row = await getBilling(organizationId)
  const result = await db.query<{
    start: Date
    end: Date
    traces: string
    spans: string
  }>(
    `SELECT month AT TIME ZONE 'UTC' AS start,
       (month + interval '1 month') AT TIME ZONE 'UTC' AS end,
       COALESCE(u.traces,0) AS traces, COALESCE(u.spans,0) AS spans
     FROM (SELECT date_trunc('month',now() AT TIME ZONE 'UTC') AS month) m
     LEFT JOIN organization_usage_month u ON u.organization_id=$1 AND u.period_start=m.month::date`,
    [organizationId]
  )
  const current = result.rows[0]
  const traces = Number(current.traces),
    spans = Number(current.spans)
  const used = traces + spans,
    limit = row?.record_limit ?? 0
  return {
    periodStart: current.start.toISOString(),
    periodEnd: current.end.toISOString(),
    traces,
    spans,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    percent: limit ? Math.round((used / limit) * 100) : 0,
    retentionDays: row?.retention_days ?? 90,
  }
}

/** Fast feedback before queueing. The database trigger is the atomic authority;
 * concurrent requests cannot bypass its limit. Existing deliveries stay retryable. */
export async function assertIngestionCapacity(
  organizationId: string,
  projectId: string,
  event: IngestionEvent
) {
  if (
    !billingEnabled() ||
    event.method !== "POST" ||
    event.path === "/api/sessions"
  )
    return
  const receipt = await db.query(
    "SELECT 1 FROM ingestion_receipts WHERE project_id=$1 AND event_id=$2::uuid",
    [projectId, event.id]
  )
  if (receipt.rowCount) return
  const body = event.body as { id: string; spans?: unknown[] }
  const isTrace = event.path === "/api/traces"
  const existing = await db.query(
    isTrace
      ? "SELECT 1 FROM traces WHERE project_id=$1 AND id=$2"
      : "SELECT 1 FROM spans WHERE project_id=$1 AND id=$2",
    [projectId, body.id]
  )
  if (existing.rowCount) return
  const usage = await getCloudUsage(organizationId)
  const units = isTrace ? 1 + (body.spans?.length ?? 0) : 1
  if (usage.used + units > usage.limit)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Monthly record limit reached. Upgrade your plan or wait for the next month. Existing data remains available.",
      {
        status: 429,
        details: {
          reason: "RECORD_LIMIT_REACHED",
          limit: usage.limit,
          billingUrl: "/billing",
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((Date.parse(usage.periodEnd) - Date.now()) / 1000)
          ),
        },
      }
    )
}
