import { sql } from "drizzle-orm"
import type { BuildContext } from "../context"
import type { EveExecution, EveExecutionPlan, EveExecutionOutcome, EveExecutionState } from "./contracts"

export class EveOwnershipLostError extends Error {}

function execution(row: Record<string, unknown>): EveExecution {
  return {
    turnId: String(row.turn_id), projectId: String(row.project_id),
    conversationId: String(row.conversation_id), agentId: String(row.agent_id),
    ownerFence: Number(row.owner_fence), sessionId: row.session_id ? String(row.session_id) : null,
    plan: row.plan_json as EveExecutionPlan, state: row.state_json as EveExecutionState,
    outcome: row.outcome_json as EveExecutionOutcome | null, status: row.status as EveExecution["status"],
  }
}

export async function createEveExecution(context: BuildContext, input: {
  turnId: string; conversationId: string; agentId: string; ownerFence: number; plan: EveExecutionPlan
}) {
  const rows = await context.database.execute<Record<string, unknown>>(sql`
    INSERT INTO build_eve_executions(turn_id,project_id,conversation_id,agent_id,owner_fence,plan_json)
    SELECT t.id,c.project_id,c.id,c.agent_id,t.owner_fence,${JSON.stringify(input.plan)}::jsonb
    FROM build_conversation_turns t JOIN build_conversations c ON c.id=t.conversation_id AND c.project_id=t.project_id
    WHERE t.id=${input.turnId} AND c.id=${input.conversationId} AND c.agent_id=${input.agentId}
      AND c.project_id=${context.projectId} AND c.owner_type='ai'
      AND t.owner_fence=${input.ownerFence} AND c.owner_fence=t.owner_fence AND t.status='running'
    ON CONFLICT(turn_id) DO UPDATE SET updated_at=build_eve_executions.updated_at
    RETURNING *`)
  if (!rows.rows[0]) throw new Error("The execution no longer owns this conversation.")
  return execution(rows.rows[0])
}

export async function getEveExecution(context: BuildContext, turnId: string) {
  const rows = await context.database.execute<Record<string, unknown>>(sql`
    SELECT * FROM build_eve_executions WHERE project_id=${context.projectId} AND turn_id=${turnId}`)
  if (!rows.rows[0]) throw new Error("Agent execution was not found in this project.")
  return execution(rows.rows[0])
}

export async function assertEveOwnership(context: BuildContext, run: EveExecution) {
  if (run.plan.simulation?.kind === "evaluation") {
    const active = await context.database.execute(sql`SELECT r.id FROM eval_runs r JOIN eval_run_lease l ON l.run_id=r.id
      WHERE r.project_id=${context.projectId} AND r.id=${run.plan.simulation.runId}
        AND r.status='running' AND l.owner=${run.plan.simulation.leaseOwner} AND l.expires_at>now()`)
    if (!active.rows.length) throw new EveOwnershipLostError("The evaluation is no longer active.")
  } else if (run.plan.simulation) {
    const active = await context.database.execute(sql`SELECT r.id FROM build_test_runs r JOIN build_test_cases c ON c.project_id=r.project_id AND c.run_id=r.id
      WHERE r.project_id=${context.projectId} AND r.id=${run.plan.simulation.runId} AND c.id=${run.plan.simulation.caseId}
        AND r.status='running' AND c.status='running' AND r.lease_expires_at>now() AND c.lease_expires_at>now()
        AND r.lease_owner=${run.plan.simulation.leaseOwner} AND c.lease_owner=${run.plan.simulation.leaseOwner}`)
    if (!active.rows.length) throw new EveOwnershipLostError("The simulation is no longer active.")
  }
  const rows = await context.database.execute(sql`
    UPDATE build_conversation_turns t SET lock_expires_at=now()+interval '5 minutes'
    FROM build_conversations c WHERE t.id=${run.turnId} AND t.project_id=${context.projectId}
      AND c.id=t.conversation_id AND c.project_id=t.project_id AND c.owner_type='ai'
      AND t.owner_fence=${run.ownerFence} AND c.owner_fence=t.owner_fence AND t.status='running'
    RETURNING t.id`)
  if (!rows.rows.length) throw new EveOwnershipLostError("The execution no longer owns this conversation.")
}

export async function assertNoUncertainEveTools(context: BuildContext, turnId: string) {
  const calls = await context.database.execute(sql`SELECT d.call_id FROM build_eve_tool_dispatches d JOIN build_eve_executions e USING(turn_id)
    WHERE e.project_id=${context.projectId} AND e.turn_id=${turnId} AND d.status IN ('running','uncertain') LIMIT 1`)
  if (calls.rows.length) throw new Error("An interrupted action requires outcome verification before this turn can continue.")
}

/** Atomic patches keep parallel calls from discarding one another's results. */
export async function patchEveState(context: BuildContext, turnId: string, patch: EveExecutionState) {
  await context.database.execute(sql`
    UPDATE build_eve_executions SET state_json=state_json || ${JSON.stringify(patch)}::jsonb || jsonb_build_object(
      'actionRefs',coalesce(state_json->'actionRefs','[]'::jsonb) || ${JSON.stringify(patch.actionRefs ?? [])}::jsonb,
      'procedures',coalesce(state_json->'procedures','[]'::jsonb) || ${JSON.stringify(patch.procedures ?? [])}::jsonb,
      'continuations',coalesce(state_json->'continuations','[]'::jsonb) || ${JSON.stringify(patch.continuations ?? [])}::jsonb,
      'integrationMetadata',coalesce(state_json->'integrationMetadata','{}'::jsonb) || ${JSON.stringify(patch.integrationMetadata ?? {})}::jsonb
    ),updated_at=now()
    WHERE project_id=${context.projectId} AND turn_id=${turnId}`)
}

export async function bindEveSession(context: BuildContext, turnId: string, sessionId: string) {
  await context.database.execute(sql`
    UPDATE build_eve_executions SET session_id=${sessionId},status='running',updated_at=now()
    WHERE project_id=${context.projectId} AND turn_id=${turnId} AND status IN ('pending','running')
      AND (session_id IS NULL OR session_id=${sessionId})`)
}

export async function recordEveOutcome(context: BuildContext, turnId: string, outcome: EveExecutionOutcome) {
  // Both the final hook and durable-stream recovery must commit files before
  // exposing a successful outcome. Keep this gate at their shared boundary.
  try { await (await import("./sandbox")).closeDatoolSandbox(context, turnId) }
  catch { outcome = {status:"failed",text:"",error:{code:"DRIVE_SYNC_FAILED",message:"Sandbox shutdown or drive synchronization failed. Pending files are retained for recovery; check the drive before retrying."}} }
  await context.database.execute(sql`
    UPDATE build_eve_executions SET outcome_json=${JSON.stringify(outcome)}::jsonb,updated_at=now()
    WHERE project_id=${context.projectId} AND turn_id=${turnId} AND outcome_json IS NULL`)
}
