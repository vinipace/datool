import { Pool, type PoolClient, type QueryResultRow } from "pg"
import { compileAlertFilter } from "@/src/lib/alerts/filter"
import { alertLimits } from "./budgets"
import { assertRestrictedAlertRole } from "./provision"

export class AlertEvaluationLimit extends Error {}
export class AlertEvaluationBusy extends Error {}
export type AlertReadQuery = <T extends QueryResultRow = QueryResultRow>(
  sql: string,
  values?: unknown[]
) => Promise<{ rows: T[]; rowCount: number | null }>

export class AlertEvaluator {
  private readonly pool: Pool
  private readonly projects = new Set<string>()

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: alertLimits.concurrentEvaluations,
      connectionTimeoutMillis: 500,
      idleTimeoutMillis: 10000,
      application_name: "datool-alert-reader",
    })
    this.pool.on("error", () =>
      console.error(
        "Alert reader connection closed; reconnecting on next evaluation."
      )
    )
  }

  async read<T>(
    projectId: string,
    run: (query: AlertReadQuery) => Promise<T>,
    windowSeconds = 86400
  ): Promise<T> {
    if (
      this.projects.size >= alertLimits.concurrentEvaluations ||
      this.projects.has(projectId)
    )
      throw new AlertEvaluationBusy(
        "Alert evaluation capacity is busy; retrying shortly."
      )
    this.projects.add(projectId)
    const deadline = Date.now() + alertLimits.evaluationMs
    let client: PoolClient | undefined
    let released = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let connectionError: ((error: Error) => void) | undefined
    const query: AlertReadQuery = async (sql, values) => {
      const remaining = deadline - Date.now()
      if (!client || released || remaining <= 0)
        throw new AlertEvaluationLimit(
          "Alert exceeded its total evaluation deadline."
        )
      await client.query("SELECT set_config('statement_timeout',$1,true)", [
        String(Math.min(alertLimits.statementMs, remaining)),
      ])
      return client.query(sql, values)
    }
    try {
      client = await this.pool.connect()
      const disconnected = new Promise<never>((_, reject) => {
        connectionError = reject
        client!.on("error", connectionError)
      })
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            // Destroy the socket, not just the promise. PostgreSQL also enforces
            // statement and transaction deadlines if the worker is interrupted.
            released = true
            client!.release(true)
            reject(
              new AlertEvaluationLimit(
                "Alert exceeded its total evaluation deadline."
              )
            )
          },
          Math.max(1, deadline - Date.now())
        )
      })
      return await Promise.race([
        timeout,
        disconnected,
        (async () => {
          await client!.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
          await client!.query(
            "SET LOCAL statement_timeout='1500ms'; SET LOCAL transaction_timeout='2500ms'; SET LOCAL lock_timeout='250ms'; SET LOCAL idle_in_transaction_session_timeout='2500ms'; SET LOCAL work_mem='4MB'"
          )
          await assertRestrictedAlertRole(client!)
          const memory = await query<{ bounded: boolean }>(
            "SELECT pg_size_bytes(current_setting('temp_file_limit')) BETWEEN 0 AND 16777216 AS bounded"
          )
          if (!memory.rows[0].bounded)
            throw new Error(
              "Alert reader requires a temporary-file limit of at most 16 MiB. Run db:alerts-reader."
            )
          const isolation = await query<{ project: boolean; slot: boolean }>(
            `
          SELECT pg_try_advisory_xact_lock(hashtext(current_database()||current_schema()||'alert-reader-project'),hashtext($1)) AS project,
            (pg_try_advisory_xact_lock(hashtext(current_database()||current_schema()||'alert-reader-slot'),0)
             OR pg_try_advisory_xact_lock(hashtext(current_database()||current_schema()||'alert-reader-slot'),1)) AS slot`,
            [projectId]
          )
          if (!isolation.rows[0].project || !isolation.rows[0].slot)
            throw new AlertEvaluationBusy(
              "Alert evaluation capacity is busy; retrying shortly."
            )
          const now = Date.now()
          await query(
            "SELECT set_config('datool.alert_project_id',$1,true),set_config('datool.alert_window_start',$2,true),set_config('datool.alert_window_end',$3,true)",
            [projectId, String(now - windowSeconds * 1000), String(now)]
          )
          const result = await run(query)
          await query("COMMIT")
          return result
        })(),
      ])
    } catch (error) {
      if (client && !released) {
        try {
          await client.query("ROLLBACK")
        } catch {
          if (!released) {
            released = true
            client.release(true)
          }
        }
      }
      const code = (error as { code?: string }).code
      if (["57014", "53400", "25P04"].includes(code ?? ""))
        throw new AlertEvaluationLimit(
          "Alert exceeded its query time or memory budget."
        )
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      if (client && connectionError)
        client.removeListener("error", connectionError)
      if (client && !released) client.release()
      this.projects.delete(projectId)
    }
  }

  async matchEvents(
    projectId: string,
    filter: string,
    events: { id: string; payload: Record<string, unknown> }[]
  ) {
    return this.read(projectId, async (query) => {
      const parameters: unknown[] = [JSON.stringify(events)]
      const predicate = compileAlertFilter(filter, parameters)
      const matches = await query<{ id: string }>(
        `SELECT id FROM jsonb_to_recordset($1::jsonb) AS log(id text,payload jsonb) WHERE ${predicate}`,
        parameters
      )
      return new Set(matches.rows.map((row) => row.id))
    })
  }

  async countWindow(projectId: string, filter: string, windowSeconds: number) {
    return this.read(
      projectId,
      async (query) => {
        const size = await query<{ count: string }>(
          `SELECT count(*) FROM (SELECT 1 FROM alert_evaluation_logs LIMIT $1) bounded`,
          [alertLimits.windowRows + 1]
        )
        if (Number(size.rows[0].count) > alertLimits.windowRows)
          throw new AlertEvaluationLimit(
            `Alert window exceeds ${alertLimits.windowRows.toLocaleString("en-US")} logs. Shorten its time window.`
          )
        const parameters: unknown[] = []
        const predicate = compileAlertFilter(filter, parameters)
        const result = await query<{ count: string; checked_at: Date }>(
          `SELECT count(*),now() AS checked_at FROM alert_evaluation_logs WHERE ${predicate}`,
          parameters
        )
        return {
          count: Number(result.rows[0].count),
          checkedAt: result.rows[0].checked_at,
        }
      },
      windowSeconds
    )
  }

  close() {
    return this.pool.end()
  }
}

let evaluator: AlertEvaluator | undefined
export function getAlertEvaluator() {
  const url = process.env.DATOOL_ALERT_DATABASE_URL
  if (!url)
    throw new Error(
      "Alert evaluation requires DATOOL_ALERT_DATABASE_URL. Provision a restricted reader with db:alerts-reader."
    )
  return (evaluator ??= new AlertEvaluator(url))
}
export async function closeAlertEvaluator() {
  const current = evaluator
  evaluator = undefined
  await current?.close()
}
