import type { ProjectContext } from "@datool/sdk/deploy"

export default {
  description: "List company projects, optionally filtered by status.",
  inputSchema: {
    type: "object",
    properties: { status: { type: "string" } },
    additionalProperties: false,
  },
  async execute(input: { status?: string }, { db }: ProjectContext) {
    return db.list("projects", {
      limit: 20,
      ...(input.status ? { where: { status: input.status } } : {}),
    })
  },
}
