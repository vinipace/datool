import { defineHook } from "eve/hooks"
import { reply } from "eve/events"
import { executionContext, recordEveOutcome, finalizeEveRuntimeExecution } from "@datool/eve-bridge"

export default defineHook({ events: {
  async "turn.settled"(event, ctx) {
    const { context, run } = await executionContext(ctx, false)
    const text = reply(ctx.view, event.data.turnId).filter(part => part.kind === "text").map(part => part.value).join("\n")
    await recordEveOutcome(context, run.turnId, {
      status: event.data.outcome, text,
      ...(event.data.error ? { error: { code: event.data.error.code, message: "The agent execution failed." } } : {}),
    })
    await finalizeEveRuntimeExecution(context, run.turnId)
  },
} })
