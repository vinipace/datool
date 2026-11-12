import { sql } from "drizzle-orm"
import type { BuildContext } from "../context"
import { ConversationService } from "../conversations"
import { finalizeEveRuntimeExecution } from "../runtime"
import { advanceEveExecution, cancelEveExecution } from "./client"
import { getEveExecution, assertEveOwnership, EveOwnershipLostError } from "./store"

/** Repairs admission/delivery gaps even when the original web or queue caller died. */
export async function reconcileEveExecutions(context: BuildContext, options: { limit?: number; staleSeconds?: number } = {}) {
  const rows = await context.database.execute<{ turn_id: string }>(sql`
    UPDATE build_eve_executions SET updated_at=now() WHERE turn_id IN (
      SELECT turn_id FROM build_eve_executions WHERE project_id=${context.projectId}
        AND status IN ('pending','running') AND updated_at < now()-make_interval(secs => ${options.staleSeconds ?? 15})
      ORDER BY updated_at LIMIT ${options.limit ?? 10} FOR UPDATE SKIP LOCKED
    ) AND project_id=${context.projectId} RETURNING turn_id`)
  for (const row of rows.rows) {
    const run = await getEveExecution(context, row.turn_id)
    const service = new ConversationService(context)
    const turn = await service.getTurn(run.turnId)
    const conversation = await service.require(run.conversationId)
    let ownsExecution = turn?.status === "running" && conversation.ownerType === "ai" && conversation.ownerFence === run.ownerFence
    if (ownsExecution) {
      try { await assertEveOwnership(context, run) }
      catch (error) { if (!(error instanceof EveOwnershipLostError)) throw error; ownsExecution = false }
    }
    if (!ownsExecution) {
      // Every provider/tool call separately fences ownership. Retire abandoned
      // delivery records without allowing a recovery worker to seize a new epoch.
      const retired = await context.database.execute(sql`UPDATE build_eve_executions SET status='cancelled',updated_at=now() WHERE project_id=${context.projectId} AND turn_id=${run.turnId} AND status IN ('pending','running') RETURNING turn_id`)
      // A completion transaction can win while ownership is being checked.
      // Never cancel or resettle a result that has already committed.
      if (!retired.rows.length) continue
      await cancelEveExecution(run).catch(() => undefined)
      if (turn?.status === "running") await service.markUncertain(turn.id, { kind: "EXECUTION_OWNERSHIP_LOST", message: "The execution lost its worker or conversation lease." })
      if (run.plan.budgetReservation) await service.settleBudget({ reservationId: run.plan.budgetReservation.reservationId, ownerFence: run.ownerFence, actualUsd: null, failed: false })
      continue
    }
    const current = await advanceEveExecution(context, run)
    if (current.outcome) {
      try { await finalizeEveRuntimeExecution(context, run.turnId) }
      catch (error) {
        if (!["EVE_EXECUTION_FAILED", "EVE_EXECUTION_CANCELLED", "ACTION_UNCERTAIN"].includes((error as { code?: string }).code ?? "")) throw error
      }
    }
  }
  return rows.rows.length
}
