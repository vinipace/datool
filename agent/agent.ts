import { defineAgent, defineDynamic } from "eve"
import { executionContext, executionModel } from "@datool/eve-bridge"

export default defineAgent({
  defaultTools: false,
  build: { externalDependencies: ["@datool/eve-bridge"] },
  model: defineDynamic(async ctx => {
    const { context, run } = await executionContext(ctx)
    return executionModel(context, run)
  }),
  limits: { sessionTimeoutMs: 300_000 },
  experimental: { workflow: { world: "@workflow/world-postgres", retention: "default" } },
})
