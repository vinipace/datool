import { randomUUID } from "node:crypto"
import type { Pool, PoolClient } from "pg"
import { db } from "@/lib/db"
import {
  executionAllowances,
  NANO_USD,
  type ExecutionUsage,
} from "@/src/lib/execution-credits"
import type { CloudPlan } from "@/src/lib/billing"

export class ExecutionCreditError extends Error {
  constructor(
    message = "Your organization has no available execution credits. Check Usage or select your own provider."
  ) {
    super(message)
  }
}
export type PaidPeriod = {
  organizationId: string
  subscriptionId: string
  invoiceId: string
  start: Date
  end: Date
  plan: CloudPlan
}
export class ExecutionCreditStore {
  constructor(private pool: Pool = db) {}
  private async transaction<T>(action: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const value = await action(client)
      await client.query("COMMIT")
      return value
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }
  /** Called only with an authoritative paid, non-prorated recurring invoice. */
  async grant(period: PaidPeriod, client?: PoolClient) {
    const apply = async (connection: PoolClient) => {
      const result = await connection.query(
        `INSERT INTO execution_credit_period(id,organization_id,subscription_id,invoice_id,period_start,period_end,plan,allowance)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
        [
          randomUUID(),
          period.organizationId,
          period.subscriptionId,
          period.invoiceId,
          period.start,
          period.end,
          period.plan,
          executionAllowances[period.plan] * NANO_USD,
        ]
      )
      if (result.rows[0])
        await connection.query(
          "INSERT INTO execution_credit_ledger(period_id,kind,amount) VALUES($1,'grant',$2)",
          [result.rows[0].id, executionAllowances[period.plan] * NANO_USD]
        )
    }
    return client ? apply(client) : this.transaction(apply)
  }
  async reserve(
    projectId: string,
    runtime: "model" | "sandbox",
    amount: number,
    rateVersion: string,
    id = randomUUID()
  ) {
    if (!Number.isSafeInteger(amount) || amount <= 0)
      throw new Error("Invalid reservation.")
    return this.transaction(async (client) => {
      // Lock the current period; all projects share this row. Paid access is
      // checked again atomically, so cached UI readiness cannot authorize spend.
      const found = await client.query(
        `SELECT c.* FROM execution_credit_period c JOIN project p ON p.organization_id=c.organization_id
         JOIN organization_billing b ON b.organization_id=c.organization_id AND b.subscription_id=c.subscription_id
         WHERE p.id=$1 AND b.status='active' AND b.access_until>now()
           AND c.period_start<=now() AND c.period_end>now()
         ORDER BY c.period_start DESC LIMIT 1 FOR UPDATE OF c`,
        [projectId]
      )
      const period = found.rows[0]
      if (!period) throw new ExecutionCreditError()
      // A replayed operation must never dispatch another external request.
      const existing = await client.query(
        "SELECT 1 FROM execution_credit_operation WHERE id=$1",
        [id]
      )
      if (existing.rowCount)
        throw new ExecutionCreditError(
          "This execution attempt has already been reserved."
        )
      const changed = await client.query(
        `UPDATE execution_credit_period SET reserved=reserved+$2 WHERE id=$1 AND spent+reserved+$2<=allowance RETURNING id`,
        [period.id, amount]
      )
      if (!changed.rowCount) throw new ExecutionCreditError()
      await client.query(
        `INSERT INTO execution_credit_operation(id,period_id,project_id,runtime,rate_version,reserved) VALUES($1,$2,$3,$4,$5,$6)`,
        [id, period.id, projectId, runtime, rateVersion, amount]
      )
      await client.query(
        "INSERT INTO execution_credit_ledger(period_id,operation_id,kind,amount) VALUES($1,$2,'reserve',$3)",
        [period.id, id, amount]
      )
      return id
    })
  }
  async recordEvidence(
    id: string,
    providerId: string | null,
    usage: Record<string, unknown>
  ) {
    await this.pool.query(
      "UPDATE execution_credit_operation SET provider_id=COALESCE($2,provider_id),usage=$3 WHERE id=$1 AND state='reserved'",
      [id, providerId, JSON.stringify(usage)]
    )
  }
  async settle(
    id: string,
    charged: number,
    providerId: string | null,
    usage: Record<string, unknown>
  ) {
    if (!Number.isSafeInteger(charged) || charged < 0)
      throw new Error("Invalid charge.")
    return this.transaction(async (client) => {
      const { rows } = await client.query(
        "SELECT * FROM execution_credit_operation WHERE id=$1 FOR UPDATE",
        [id]
      )
      const op = rows[0]
      if (!op) throw new Error("Unknown credit operation.")
      if (op.state !== "reserved") {
        if (Number(op.charged) !== charged)
          throw new Error("Conflicting settlement.")
        return
      }
      if (charged > Number(op.reserved))
        throw new Error(
          "Usage exceeded its reserved bound; reconciliation required."
        )
      await client.query(
        `UPDATE execution_credit_period SET reserved=reserved-$2,spent=spent+$3 WHERE id=$1`,
        [op.period_id, op.reserved, charged]
      )
      await client.query(
        `UPDATE execution_credit_operation SET charged=$2,state=$3,provider_id=$4,usage=$5,settled_at=now() WHERE id=$1`,
        [
          id,
          charged,
          charged ? "settled" : "released",
          providerId,
          JSON.stringify(usage),
        ]
      )
      await client.query(
        `INSERT INTO execution_credit_ledger(period_id,operation_id,kind,amount) VALUES($1,$2,$3,$4)`,
        [
          op.period_id,
          id,
          charged ? "settle" : "release",
          charged || Number(op.reserved),
        ]
      )
      if (charged && charged < Number(op.reserved))
        await client.query(
          `INSERT INTO execution_credit_ledger(period_id,operation_id,kind,amount) VALUES($1,$2,'release',$3)`,
          [op.period_id, id, Number(op.reserved) - charged]
        )
    })
  }
  async usage(organizationId: string): Promise<ExecutionUsage> {
    return this.transaction(async (client) => {
      await client.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
      )
      return this.readUsage(organizationId, client)
    })
  }
  private async readUsage(
    organizationId: string,
    client: PoolClient
  ): Promise<ExecutionUsage> {
    const { rows } = await client.query(
      `SELECT c.* FROM execution_credit_period c JOIN organization_billing b
       ON b.organization_id=c.organization_id AND b.subscription_id=c.subscription_id
       WHERE c.organization_id=$1 AND c.period_start<=now() AND c.period_end>now()
       ORDER BY c.period_start DESC LIMIT 1`,
      [organizationId]
    )
    const period = rows[0]
    if (!period)
      return {
        plan: null,
        periodStart: null,
        periodEnd: null,
        allowance: 0,
        used: 0,
        reserved: 0,
        remaining: 0,
        model: 0,
        sandbox: 0,
        pendingRuns: 0,
        projects: [],
      }
    const totals = await client.query(
      `SELECT o.project_id AS id,COALESCE(p.name,'Deleted project') AS name,
      COALESCE(sum(o.charged) FILTER(WHERE o.runtime='model'),0) AS model,
      COALESCE(sum(o.charged) FILTER(WHERE o.runtime='sandbox'),0) AS sandbox,
      COALESCE(sum(o.reserved) FILTER(WHERE o.state='reserved'),0) AS reserved,
      count(*) FILTER(WHERE o.state='reserved') AS pending
      FROM execution_credit_operation o LEFT JOIN project p ON p.id=o.project_id
      WHERE o.period_id=$1 GROUP BY o.project_id,p.name ORDER BY name`,
      [period.id]
    )
    const projects = totals.rows.map((p) => ({
      id: p.id,
      name: p.name,
      model: Number(p.model) / NANO_USD,
      sandbox: Number(p.sandbox) / NANO_USD,
      reserved: Number(p.reserved) / NANO_USD,
    }))
    return {
      plan: period.plan,
      periodStart: period.period_start.toISOString(),
      periodEnd: period.period_end.toISOString(),
      allowance: Number(period.allowance) / NANO_USD,
      used: Number(period.spent) / NANO_USD,
      reserved: Number(period.reserved) / NANO_USD,
      remaining:
        (Number(period.allowance) -
          Number(period.spent) -
          Number(period.reserved)) /
        NANO_USD,
      model: projects.reduce((s, p) => s + p.model, 0),
      sandbox: projects.reduce((s, p) => s + p.sandbox, 0),
      pendingRuns: totals.rows.reduce((s, p) => s + Number(p.pending), 0),
      projects,
    }
  }
}
export const executionCredits = new ExecutionCreditStore()
