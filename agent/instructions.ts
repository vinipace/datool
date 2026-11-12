import { defineDynamic, defineInstructions } from "eve/instructions"
import { executionContext } from "@datool/eve-bridge"

export default defineDynamic(async ctx => {
  const { run } = await executionContext(ctx)
  return defineInstructions({ role: "system", content: run.plan.system })
})
