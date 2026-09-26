import type { Pool, PoolClient } from "pg"
import { db } from "@/lib/db"
import {
  alertConfigSchema,
  type AlertConfig,
  type AlertRule,
  type AlertsResponse,
} from "@/src/lib/alerts/contracts"
import { parseAlertFilter } from "@/src/lib/alerts/filter"
import { validateWebhookUrl } from "./webhook"

export class AlertInputError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message)
  }
}

export function parseAlertConfig(value: unknown): AlertConfig {
  const parsed = alertConfigSchema.safeParse(value)
  if (!parsed.success)
    throw new AlertInputError(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")
    )
  try {
    parseAlertFilter(parsed.data.filter)
    if (parsed.data.action === "webhook")
      validateWebhookUrl(parsed.data.webhookUrl)
  } catch (error) {
    throw new AlertInputError(
      error instanceof Error ? error.message : "Invalid alert configuration."
    )
  }
  return {
    ...parsed.data,
    webhookUrl: parsed.data.action === "webhook" ? parsed.data.webhookUrl : "",
  }
}

export const alertColumns = `id, config, revision, created_at AS "createdAt", last_notified_at AS "lastNotifiedAt", last_evaluated_at AS "lastEvaluatedAt", last_error AS "lastError"`

export async function getAlert(projectId: string, id: string, pool: Pool = db) {
  const result = await pool.query<AlertRule>(
    `SELECT ${alertColumns} FROM project_alerts WHERE project_id=$1 AND id=$2`,
    [projectId, id]
  )
  if (!result.rows[0]) throw new AlertInputError("Alert not found.", 404)
  return result.rows[0]
}

export async function alertWorkerOnline(pool: Pool = db) {
  const result = await pool.query<{ online: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM alert_worker_heartbeat WHERE seen_at > now() - interval '30 seconds') AS online"
  )
  return result.rows[0].online
}

export async function listAlerts(
  projectId: string,
  pool: Pool = db
): Promise<AlertsResponse> {
  const [alerts, deliveries, heartbeat] = await Promise.all([
    pool.query<AlertRule>(
      `SELECT ${alertColumns} FROM project_alerts WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [projectId]
    ),
    pool.query<AlertsResponse["deliveries"][number]>(
      `SELECT id, alert_id AS "alertId", alert_name AS "alertName", action, status, attempts, last_error AS "lastError", created_at AS "createdAt", delivered_at AS "deliveredAt", payload FROM alert_deliveries WHERE project_id=$1 ORDER BY created_at DESC, id LIMIT 50`,
      [projectId]
    ),
    pool.query<{ online: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM alert_worker_heartbeat WHERE seen_at > now() - interval '30 seconds') AS online`
    ),
  ])
  return {
    alerts: alerts.rows,
    deliveries: deliveries.rows,
    workerOnline: heartbeat.rows[0].online,
  }
}

export async function alertTransaction<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  let failed = false
  const onError = () => {
    failed = true
  }
  client.on("error", onError)
  try {
    await client.query("BEGIN")
    await client.query(
      "SET LOCAL statement_timeout = '10s'; SET LOCAL transaction_timeout='15s'; SET LOCAL lock_timeout='1s'"
    )
    const result = await run(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    try {
      await client.query("ROLLBACK")
    } catch {
      failed = true
    }
    throw error
  } finally {
    client.removeListener("error", onError)
    client.release(failed)
  }
}

export async function createAlert(
  projectId: string,
  value: unknown,
  pool: Pool = db
) {
  const config = parseAlertConfig(value)
  return alertTransaction(pool, async (client) => {
    await client.query("SELECT id FROM project WHERE id=$1 FOR UPDATE", [
      projectId,
    ])
    const count = await client.query<{ count: string }>(
      "SELECT count(*) FROM project_alerts WHERE project_id=$1",
      [projectId]
    )
    if (Number(count.rows[0].count) >= 100)
      throw new AlertInputError("A project can have up to 100 alerts.")
    const result = await client.query<AlertRule>(
      `INSERT INTO project_alerts(id, project_id, config) VALUES($1,$2,$3) RETURNING ${alertColumns}`,
      [crypto.randomUUID(), projectId, config]
    )
    return result.rows[0]
  })
}

export async function updateAlert(
  projectId: string,
  id: string,
  revision: number,
  value: unknown,
  pool: Pool = db
) {
  const config = parseAlertConfig(value)
  return alertTransaction(pool, async (client) => {
    const result = await client.query<AlertRule>(
      `UPDATE project_alerts SET config=$4, revision=revision+1, updated_at=now(), next_check_at=now(), last_error=NULL, consecutive_failures=0 WHERE project_id=$1 AND id=$2 AND revision=$3 RETURNING ${alertColumns}`,
      [projectId, id, revision, config]
    )
    if (!result.rows[0])
      throw new AlertInputError(
        "Alert changed or was removed. Refresh and try again.",
        409
      )
    // Old revisions must never fire later using a new filter or destination.
    await client.query(
      "DELETE FROM alert_events WHERE alert_id=$1 AND revision <> $2",
      [id, result.rows[0].revision]
    )
    if (!config.enabled)
      await client.query(
        "UPDATE alert_deliveries SET status='cancelled' WHERE alert_id=$1 AND status='pending'",
        [id]
      )
    return result.rows[0]
  })
}

export async function deleteAlert(
  projectId: string,
  id: string,
  pool: Pool = db
) {
  const result = await pool.query(
    "DELETE FROM project_alerts WHERE project_id=$1 AND id=$2 RETURNING id",
    [projectId, id]
  )
  if (!result.rowCount) throw new AlertInputError("Alert not found.", 404)
}
