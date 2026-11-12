import { sql } from "drizzle-orm"
import { ConversationService } from "../conversations"
import { startEveModelTrace } from "../runtime"
import { assertEveOwnership, getEveExecution } from "./store"
import type { BuildContext } from "../context"
import type { EveExecution } from "./contracts"
import {
  getSandboxProviderCredentials,
  SandboxSettingsValidationError,
} from "../../sandbox/providers-store"

export const sandboxToolNames = [
  "bash",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
] as const
export function builtinEnabled(run: EveExecution, name: string) {
  if (run.plan.scopeRestricted || run.plan.simulation) return false
  if (name === "web_fetch")
    return Boolean(run.plan.configuration.web?.fetchEnabled)
  if (name === "web_search")
    return Boolean(run.plan.configuration.web?.searchEnabled)
  return (
    sandboxToolNames.includes(name as (typeof sandboxToolNames)[number]) &&
    run.plan.sandboxEnabled
  )
}

/** Apply the same ownership, replay and trace boundaries as database actions. */
export async function executeEveBuiltin<T>(
  context: BuildContext,
  turnId: string,
  name: string,
  input: unknown,
  callId: string,
  execute: () => Promise<T>,
  hasSideEffects: () => boolean
): Promise<T> {
  const run = await getEveExecution(context, turnId)
  await assertEveOwnership(context, run)
  if (!builtinEnabled(run, name))
    throw new Error("This tool is disabled for this agent execution.")
  const claim = await context.database.execute(
    sql`INSERT INTO build_eve_tool_dispatches(turn_id,call_id,status) VALUES(${turnId},${callId},'running') ON CONFLICT DO NOTHING RETURNING call_id`
  )
  if (!claim.rows.length) {
    const old = await context.database.execute<{
      status: string
      output_json: T
    }>(
      sql`SELECT status,output_json FROM build_eve_tool_dispatches WHERE turn_id=${turnId} AND call_id=${callId}`
    )
    if (old.rows[0]?.status === "completed") return old.rows[0].output_json
    throw new Error(
      "This tool call was interrupted. Verify its outcome before repeating it."
    )
  }
  const service = new ConversationService(context)
  const toolCallId = `eve_${callId}`
  const trace = await startEveModelTrace(context, run, input, {
    kind: "tool",
    name,
  })
  await service.recordToolCallStart({
    conversationId: run.conversationId,
    turnId,
    toolCallId,
    actionId: name,
    args: input as Record<string, unknown>,
    ownerFence: run.ownerFence,
  })
  try {
    if (sandboxToolNames.includes(name as (typeof sandboxToolNames)[number])) {
      await getSandboxProviderCredentials(
        context.projectId,
        run.plan.configuration.sandbox.provider,
        context.database
      )
    }
    const output = await execute()
    await service.recordToolCallFinish({
      conversationId: run.conversationId,
      turnId,
      toolCallId,
      status: "completed",
      output,
      ownerFence: run.ownerFence,
    })
    await context.database.execute(
      sql`UPDATE build_eve_tool_dispatches SET status='completed',output_json=${JSON.stringify(output ?? null)}::jsonb WHERE turn_id=${turnId} AND call_id=${callId}`
    )
    await trace?.(output)
    return output
  } catch (error) {
    // Shell/file writes may already have happened. Never repeat an interrupted mutation.
    const mutation = hasSideEffects()
    const failure = {
      error:
        error instanceof SandboxSettingsValidationError
          ? error.message
          : "The tool did not complete.",
    }
    await service
      .recordToolCallFinish({
        conversationId: run.conversationId,
        turnId,
        toolCallId,
        status: "failed",
        output: failure,
        ownerFence: run.ownerFence,
      })
      .catch(() => undefined)
    await context.database.execute(
      sql`UPDATE build_eve_tool_dispatches SET status=${mutation ? "uncertain" : "completed"},output_json=${JSON.stringify(failure)}::jsonb WHERE turn_id=${turnId} AND call_id=${callId}`
    )
    await trace?.(failure, undefined, true)
    throw error
  }
}
