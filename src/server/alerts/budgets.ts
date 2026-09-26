import type { Pool, PoolClient } from "pg"

export const alertLimits = {
  mutationsPerMinute: 30,
  evaluationsPerMinute: 120,
  concurrentEvaluations: 2,
  statementMs: 1500,
  evaluationMs: 2500,
  windowRows: 20000,
  eventRows: 100,
  eventBytes: 2 * 1024 * 1024,
  failuresBeforePause: 3,
} as const

/** Atomic across workers; a rejected attempt never resets the window. */
export async function consumeAlertBudget(
  client: Pool | PoolClient,
  projectId: string,
  kind: "mutation" | "evaluation"
) {
  const limit =
    kind === "mutation"
      ? alertLimits.mutationsPerMinute
      : alertLimits.evaluationsPerMinute
  const result = await client.query(
    `INSERT INTO alert_project_budgets(project_id,kind,window_start,used)
     VALUES($1,$2,date_trunc('minute',clock_timestamp()),1)
     ON CONFLICT(project_id,kind) DO UPDATE SET
       window_start = date_trunc('minute',clock_timestamp()),
       used = CASE WHEN alert_project_budgets.window_start < date_trunc('minute',clock_timestamp()) THEN 1 ELSE alert_project_budgets.used+1 END
     WHERE alert_project_budgets.window_start < date_trunc('minute',clock_timestamp()) OR alert_project_budgets.used < $3
     RETURNING used`,
    [projectId, kind, limit]
  )
  return Boolean(result.rowCount)
}
