import { defineDynamic, defineTool } from "eve/tools"
import type { JsonObject } from "eve/events"
import { executionContext, describeEveRuntimeTools, executeEveRuntimeTool } from "@datool/eve-bridge"

export default defineDynamic(async ctx => {
  const { context, run } = await executionContext(ctx)
  const tools = await describeEveRuntimeTools(context, run.turnId)
  return Object.fromEntries(tools.map(entry => [entry.name, defineTool({
    description: entry.description,
    inputSchema: entry.inputSchema as JsonObject,
    deferred: true,
    async execute(input, toolContext) {
      return executeEveRuntimeTool(context, run.turnId, entry.name, input as Record<string, unknown>, toolContext.callId, toolContext.abortSignal)
    },
  })]))
})
