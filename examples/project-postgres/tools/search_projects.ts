import { eq } from "drizzle-orm"
import { defineTool } from "../datool.generated"
import { projects } from "../schema"

export default defineTool({
  description: "Find projects by status in the project PostgreSQL database.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["active", "paused", "done"] },
    },
    required: ["status"],
    additionalProperties: false,
  },
  execute(input: { status: "active" | "paused" | "done" }, ctx) {
    return ctx.sql
      .select()
      .from(projects)
      .where(eq(projects.status, input.status))
      .limit(20)
  },
})
