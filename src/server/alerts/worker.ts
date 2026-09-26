import type { Pool, PoolClient } from "pg"
import { db } from "@/lib/db"
import type { AlertConfig } from "@/src/lib/alerts/contracts"
import { alertLimits, consumeAlertBudget } from "./budgets"
import {
  AlertEvaluationBusy,
  AlertEvaluationLimit,
  getAlertEvaluator,
  type AlertEvaluator,
} from "./evaluator"
import { alertTransaction } from "./service"
import { deliverWebhook } from "./webhook"

type WorkerRule = {
  id: string
  project_id: string
  config: AlertConfig
  revision: number
  last_notified_at: Date | null
}

async function enqueueDelivery(
  client: PoolClient,
  rule: WorkerRule,
  occurredAt: Date,
  matchCount: number,
  log?: Record<string, unknown>
) {
  if (
    rule.last_notified_at &&
    occurredAt.getTime() <
      rule.last_notified_at.getTime() + rule.config.notifyIntervalSeconds * 1000
  )
    return
  const id = crypto.randomUUID()
  const payload = {
    id,
    alertId: rule.id,
    projectId: rule.project_id,
    alertName: rule.config.name,
    type: rule.config.type,
    occurredAt: occurredAt.toISOString(),
    matchCount,
    ...(rule.config.type === "time_window"
      ? {
          windowSeconds: rule.config.windowSeconds,
          threshold: rule.config.threshold,
        }
      : {}),
    ...(log
      ? {
          log: {
            id: log.id,
            trace_id: log.trace_id,
            name: log.name,
            resource: log.resource,
            status: log.status,
          },
        }
      : {}),
  }
  await client.query(
    `INSERT INTO alert_deliveries(id,project_id,alert_id,alert_name,action,webhook_url,payload) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      rule.project_id,
      rule.id,
      rule.config.name,
      rule.config.action,
      rule.config.webhookUrl || null,
      payload,
    ]
  )
  await client.query(
    "UPDATE project_alerts SET last_notified_at=$2 WHERE id=$1",
    [rule.id, occurredAt]
  )
  rule.last_notified_at = occurredAt
}

export async function evaluateAlert(
  pool: Pool,
  id: string,
  reader?: AlertEvaluator
) {
  return alertTransaction(pool, async (client) => {
    await client.query(
      "SET LOCAL statement_timeout='1500ms'; SET LOCAL transaction_timeout='5s'; SET LOCAL lock_timeout='250ms'"
    )
    const result = await client.query<WorkerRule>(
      "SELECT * FROM project_alerts WHERE id=$1 AND next_check_at <= now() FOR NO KEY UPDATE SKIP LOCKED",
      [id]
    )
    const rule = result.rows[0]
    if (!rule) return
    if (!rule.config.enabled) {
      await client.query("DELETE FROM alert_events WHERE alert_id=$1", [id])
      return
    }
    // Do not wait on another worker's project budget while holding a rule lock.
    const gate = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext(current_database()||current_schema()||'alert-worker-project'),hashtext($1)) AS acquired",
      [rule.project_id]
    )
    if (!gate.rows[0].acquired) return
    if (!(await consumeAlertBudget(client, rule.project_id, "evaluation"))) {
      await client.query(
        "UPDATE project_alerts SET next_check_at=date_trunc('minute',clock_timestamp())+interval '1 minute', last_evaluated_at=now(), last_error='Project evaluation limit reached; waiting for the next minute.' WHERE id=$1",
        [id]
      )
      return
    }
    // Keep failed quota reservations committed and isolate SQL errors on the
    // reader connection from this transaction's queue/delivery writes.
    try {
      const evaluator = reader ?? getAlertEvaluator()
      if (rule.config.type === "log_event") {
        const events = await client.query<{
          id: string
          payload: Record<string, unknown> | null
          revision: number
          occurred_at: Date
        }>(
          `WITH candidates AS MATERIALIZED (
            SELECT id,revision,occurred_at,payload_bytes FROM alert_events WHERE alert_id=$1 ORDER BY id LIMIT $2
          ), sized AS (
            SELECT *,sum(payload_bytes) OVER (ORDER BY id) AS bytes FROM candidates
          ) SELECT s.id,s.revision,s.occurred_at,CASE WHEN s.bytes <= $3 THEN e.payload END AS payload
            FROM sized s JOIN alert_events e ON e.id=s.id ORDER BY s.id`,
          [id, alertLimits.eventRows, alertLimits.eventBytes]
        )
        if (events.rows[0]?.payload === null)
          throw new AlertEvaluationLimit(
            "Alert event exceeds the 2 MiB evaluation budget."
          )
        const batch = events.rows.filter(
          (
            event
          ): event is typeof event & { payload: Record<string, unknown> } =>
            event.payload !== null
        )
        const matches = await evaluator.matchEvents(
          rule.project_id,
          rule.config.filter,
          batch.filter((event) => event.revision === rule.revision)
        )
        for (const event of batch) {
          if (matches.has(event.id))
            await enqueueDelivery(
              client,
              rule,
              event.occurred_at,
              1,
              event.payload
            )
        }
        if (batch.length)
          // An older sequence ID can commit after SELECT. Delete only exact IDs.
          await client.query(
            "DELETE FROM alert_events WHERE alert_id=$1 AND id = ANY($2::bigint[])",
            [id, batch.map((event) => event.id)]
          )
      } else {
        const result = await evaluator.countWindow(
          rule.project_id,
          rule.config.filter,
          rule.config.windowSeconds
        )
        if (result.count >= rule.config.threshold)
          await enqueueDelivery(client, rule, result.checkedAt, result.count)
      }
      await client.query(
        "UPDATE project_alerts SET last_evaluated_at=now(),last_error=NULL,consecutive_failures=0,next_check_at=CASE WHEN config->>'type'='time_window' THEN now()+interval '1 minute' ELSE now() END WHERE id=$1",
        [id]
      )
    } catch (error) {
      // Reader failures leave the writer transaction usable. Writer SQL errors
      // abort it and are handled by runAlertTick after rollback instead.
      if (error instanceof AlertEvaluationBusy) {
        await client.query(
          "UPDATE project_alerts SET next_check_at=now()+interval '1 second',last_evaluated_at=now() WHERE id=$1",
          [id]
        )
        return
      }
      const expensive = error instanceof AlertEvaluationLimit
      const failure = await client.query<{ paused: boolean }>(
        `
        UPDATE project_alerts SET consecutive_failures=CASE WHEN $2 THEN consecutive_failures+1 ELSE consecutive_failures END,
          config=CASE WHEN $2 AND consecutive_failures+1 >= $4 THEN jsonb_set(config,'{enabled}','false') ELSE config END,
          revision=revision+CASE WHEN $2 AND consecutive_failures+1 >= $4 THEN 1 ELSE 0 END,
          last_error=CASE WHEN $2 AND consecutive_failures+1 >= $4 THEN 'Automatically paused after repeated budget failures. ' ELSE '' END || $3,
          last_evaluated_at=now(),next_check_at=now()+interval '1 minute'
        WHERE id=$1 RETURNING NOT (config->>'enabled')::boolean AS paused`,
        [
          id,
          expensive,
          expensive
            ? error.message
            : "Alert reader unavailable or filter evaluation failed. Check worker configuration.",
          alertLimits.failuresBeforePause,
        ]
      )
      if (failure.rows[0].paused) {
        await client.query("DELETE FROM alert_events WHERE alert_id=$1", [id])
        await client.query(
          "UPDATE alert_deliveries SET status='cancelled' WHERE alert_id=$1 AND status='pending'",
          [id]
        )
      }
      if (!expensive)
        console.error(
          JSON.stringify({
            event: "alert_reader_failed",
            alertId: id,
            reason: error instanceof Error ? error.message : "Unknown failure",
          })
        )
    }
  })
}

export async function processAlertDelivery(pool: Pool) {
  return alertTransaction(pool, async (client) => {
    const result = await client.query<{
      id: string
      action: string
      webhook_url: string
      payload: unknown
      attempts: number
      enabled: boolean
    }>(`
      SELECT d.*, (a.config->>'enabled')::boolean AS enabled FROM alert_deliveries d JOIN project_alerts a ON a.id=d.alert_id
      WHERE d.status='pending' AND d.next_attempt_at <= now() ORDER BY d.next_attempt_at, d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`)
    const delivery = result.rows[0]
    if (!delivery) return false
    if (!delivery.enabled) {
      await client.query(
        "UPDATE alert_deliveries SET status='cancelled' WHERE id=$1",
        [delivery.id]
      )
      return true
    }
    try {
      if (delivery.action === "webhook")
        await deliverWebhook(
          delivery.webhook_url,
          delivery.id,
          delivery.payload
        )
      await client.query(
        "UPDATE alert_deliveries SET status='delivered', attempts=attempts+1, delivered_at=now(), last_error=NULL WHERE id=$1",
        [delivery.id]
      )
    } catch (error) {
      await client.query(
        `UPDATE alert_deliveries SET status=$2, attempts=attempts+1, last_error=$3, next_attempt_at=now()+$4::int*interval '1 second' WHERE id=$1`,
        [
          delivery.id,
          delivery.attempts >= 4 ? "failed" : "pending",
          error instanceof Error ? error.message : "Webhook delivery failed.",
          Math.min(300, 5 * 2 ** delivery.attempts),
        ]
      )
    }
    return true
  })
}

export async function runAlertTick(pool: Pool = db) {
  // Bound each pass so a slow receiver/project cannot starve other rule work.
  const deadline = Date.now() + 5000
  await pool.query(
    "INSERT INTO alert_worker_heartbeat(id,seen_at) VALUES('alerts',now()) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at"
  )
  const rules = await pool.query<{
    id: string
  }>(`SELECT id FROM (
      SELECT id,last_evaluated_at,row_number() OVER (PARTITION BY project_id ORDER BY last_evaluated_at NULLS FIRST,id) AS project_rank
      FROM project_alerts WHERE config->>'enabled'='true' AND next_check_at <= now() AND
        (config->>'type'='time_window' OR EXISTS(SELECT 1 FROM alert_events e WHERE e.alert_id=project_alerts.id))
    ) due ORDER BY project_rank,last_evaluated_at NULLS FIRST,id LIMIT 100`)
  for (const rule of rules.rows) {
    if (Date.now() >= deadline) break
    try {
      await evaluateAlert(pool, rule.id)
    } catch {
      await pool.query(
        "UPDATE project_alerts SET last_error='Alert evaluation failed. Check the filter and worker logs.', last_evaluated_at=now(), next_check_at=now()+interval '1 minute' WHERE id=$1",
        [rule.id]
      )
      console.error(
        JSON.stringify({ event: "alert_evaluation_failed", alertId: rule.id })
      )
    }
  }
  const deliveryDeadline = Date.now() + 5000
  for (let i = 0; i < 25; i++) {
    if (Date.now() >= deliveryDeadline) break
    if (!(await processAlertDelivery(pool))) break
  }
}

export function startAlertWorker(pool: Pool = db) {
  let stopping = false
  let running: Promise<void> | undefined
  const tick = () => {
    if (stopping || running) return
    running = runAlertTick(pool)
      .catch(() => console.error("Alert worker tick failed; retrying."))
      .finally(() => {
        running = undefined
      })
  }
  tick()
  const timer = setInterval(tick, 1000)
  return async () => {
    stopping = true
    clearInterval(timer)
    await running
  }
}
