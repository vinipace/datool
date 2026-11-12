import { defineTool } from "../datool.generated"
import { projects } from "../schema"

export default defineTool({
  description: "Create or update a project in PostgreSQL.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1, maxLength: 100 },
      name: { type: "string", minLength: 1, maxLength: 200 },
      status: { type: "string", enum: ["active", "paused", "done"] },
    },
    required: ["id", "name", "status"],
    additionalProperties: false,
  },
  execute(
    input: { id: string; name: string; status: "active" | "paused" | "done" },
    ctx
  ) {
    return ctx.sql
      .insert(projects)
      .values(input)
      .onConflictDoUpdate({
        target: projects.id,
        set: { name: input.name, status: input.status },
      })
      .returning()
  },
})
