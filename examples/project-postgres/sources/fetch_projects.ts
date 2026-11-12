import { defineSource } from "../datool.generated"
import { projects } from "../schema"

export default defineSource(async (ctx) => {
  const rows = await ctx.sql.select().from(projects).limit(100)
  return [
    {
      path: "projects.md",
      title: "Company projects",
      text:
        rows.map((row) => `${row.name}: ${row.status}`).join("\n") ||
        "No projects have been created yet.",
    },
  ]
})
