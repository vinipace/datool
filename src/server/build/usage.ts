import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import type { Pool } from "pg"
import { db } from "@/lib/db"
import { NANO_USD } from "@/src/lib/execution-credits"
import type {
  AgentUsage,
  AgentUsageRow,
  AgentUsageMetrics,
} from "@/src/lib/build/integrations"
import { TracerError } from "@/src/server/tracer/errors"
import { assertBuildProject, type BuildContext } from "./context"

export async function beginModelUsage(
  context: BuildContext,
  input: {
    agentId: string
    conversationId: string
    turnId: string
    provider: string
    model: string
  }
) {
  const ctx = await assertBuildProject(context)
  const id = randomUUID()
  const admitted = await ctx.database
    .execute(sql`INSERT INTO build_usage_event(id,organization_id,project_id,agent_id,conversation_id,turn_id,event_key,kind,provider,model,status,cost_source)
    SELECT ${id}::uuid,${ctx.organizationId},${ctx.projectId},c.agent_id,c.id,t.id,${`model:${id}`},'model',${input.provider},${input.model},'pending','unknown'
    FROM build_conversation_turns t JOIN build_conversations c ON c.id=t.conversation_id AND c.project_id=t.project_id
    WHERE t.id=${input.turnId} AND c.id=${input.conversationId} AND c.agent_id=${input.agentId} AND t.project_id=${ctx.projectId} RETURNING id`)
  if (!admitted.rows.length)
    throw new TracerError(
      "UNAUTHORIZED",
      "The model usage context is outside this conversation."
    )
  return id
}
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {}
export async function finishModelUsage(
  context: BuildContext,
  id: string,
  rawUsage?: unknown,
  metadata?: unknown,
  responseId?: string
) {
  const usage = record(rawUsage)
  const input =
    count(usage.inputTokens) ?? count(record(usage.inputTokens).total)
  const output =
    count(usage.outputTokens) ?? count(record(usage.outputTokens).total)
  const cached =
    count(usage.cachedInputTokens) ??
    count(record(usage.inputTokenDetails).cacheReadTokens) ??
    count(record(usage.inputTokens).cacheRead)
  const reasoning =
    count(usage.reasoningTokens) ??
    count(record(usage.outputTokenDetails).reasoningTokens) ??
    count(record(usage.outputTokens).reasoning)
  const meta = record(metadata)
  const cost = [
    usage.costUsd,
    usage.totalCostUsd,
    meta.costUsd,
    meta.totalCostUsd,
    record(meta.gateway).cost,
  ].find(
    (v) =>
      typeof v === "number" &&
      Number.isFinite(v) &&
      v >= 0 &&
      v * NANO_USD <= Number.MAX_SAFE_INTEGER
  ) as number | undefined
  await context.database
    .execute(sql`UPDATE build_usage_event SET status=${rawUsage ? "completed" : "uncertain"},input_tokens=${input},output_tokens=${output},cached_input_tokens=${cached},reasoning_tokens=${reasoning},
    cost_nano_usd=${cost === undefined ? null : Math.ceil(cost * NANO_USD)},cost_source=${cost === undefined ? "unknown" : "provider"},provider_log_id=${responseId ?? null}
    WHERE id=${id}::uuid AND project_id=${context.projectId} AND status='pending'`)
}

/** Organization authorization belongs to the HTTP caller; Build uses its verified context. */
export async function getAgentUsage(
  organizationId: string,
  filters: {
    projectId?: string
    agentId?: string
    conversationId?: string
    start?: string
    end?: string
  } = {},
  pool: Pool = db
): Promise<AgentUsage> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    const period = await client.query(
      `SELECT COALESCE((SELECT c.period_start FROM execution_credit_period c JOIN organization_billing b ON b.organization_id=c.organization_id AND b.subscription_id=c.subscription_id WHERE c.organization_id=$1 AND c.period_start<=now() AND c.period_end>now() ORDER BY c.period_start DESC LIMIT 1),date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS start,
      COALESCE((SELECT c.period_end FROM execution_credit_period c JOIN organization_billing b ON b.organization_id=c.organization_id AND b.subscription_id=c.subscription_id WHERE c.organization_id=$1 AND c.period_start<=now() AND c.period_end>now() ORDER BY c.period_start DESC LIMIT 1),(date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC') AS "end"`,
      [organizationId]
    )
    const start = filters.start ?? period.rows[0].start.toISOString()
    const end = filters.end ?? period.rows[0].end.toISOString()
    const values = [
      organizationId,
      start,
      end,
      filters.projectId ?? null,
      filters.agentId ?? null,
      filters.conversationId ?? null,
    ]
    const from = `FROM build_usage_event u LEFT JOIN project p ON p.id=u.project_id AND p.organization_id=u.organization_id LEFT JOIN build_agents a ON a.id=u.agent_id AND a.project_id=u.project_id
      WHERE u.organization_id=$1 AND u.created_at >= $2::timestamptz AND u.created_at < $3::timestamptz AND ($4::text IS NULL OR u.project_id=$4) AND ($5::text IS NULL OR u.agent_id=$5) AND ($6::text IS NULL OR u.conversation_id=$6)`
    const measures = `count(*) FILTER(WHERE kind='model') AS "modelCalls", count(*) FILTER(WHERE kind='integration' AND u.status<>'blocked') AS "integrationCalls",
      count(*) FILTER(WHERE u.status='failed') AS "failedCalls", count(*) FILTER(WHERE u.status IN ('pending','uncertain')) AS "pendingCalls",
      COALESCE(sum(input_tokens),0) AS "inputTokens",COALESCE(sum(output_tokens),0) AS "outputTokens",COALESCE(sum(cached_input_tokens),0) AS "cachedInputTokens",COALESCE(sum(reasoning_tokens),0) AS "reasoningTokens",
      count(*) FILTER(WHERE kind='model' AND (input_tokens IS NULL OR output_tokens IS NULL)) AS "missingTokenCalls",
      COALESCE(sum(cost_nano_usd) FILTER(WHERE kind='model'),0)::float8/${NANO_USD} AS "modelCostUsd",
      COALESCE(sum(cost_nano_usd) FILTER(WHERE kind='integration'),0)::float8/${NANO_USD} AS "integrationCostUsd",
      count(*) FILTER(WHERE kind='model' AND cost_nano_usd IS NULL) AS "unpricedModelCalls"`
    const names = `u.project_id AS "projectId",COALESCE(p.name,'Deleted project') AS "projectName",u.agent_id AS "agentId",COALESCE(a.name,'Deleted agent') AS "agentName"`
    const totals = await client.query(`SELECT ${measures} ${from}`, values)
    const agents = await client.query(
      `SELECT ${names},NULL AS "conversationId",${measures} ${from} GROUP BY u.project_id,p.name,u.agent_id,a.name ORDER BY max(u.created_at) DESC LIMIT 100`,
      values
    )
    const conversations = await client.query(
      `SELECT ${names},u.conversation_id AS "conversationId",${measures} ${from} GROUP BY u.project_id,p.name,u.agent_id,a.name,u.conversation_id ORDER BY max(u.created_at) DESC LIMIT 100`,
      values
    )
    const mapMetrics = (row: Record<string, unknown>): AgentUsageMetrics =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, Number(value)])
      ) as AgentUsageMetrics
    const map = (row: Record<string, unknown>): AgentUsageRow =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [
          k,
          [
            "projectId",
            "projectName",
            "agentId",
            "agentName",
            "conversationId",
          ].includes(k)
            ? v
            : Number(v),
        ])
      ) as AgentUsageRow
    await client.query("COMMIT")
    return {
      periodStart: start,
      periodEnd: end,
      totals: mapMetrics(totals.rows[0]),
      agents: agents.rows.map(map),
      conversations: conversations.rows.map(map),
      rowLimit: 100,
    }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
