import { z } from "zod"
import {
  authoringTopicSchema,
  buildAuthoringGuide,
} from "@/src/lib/build/authoring-guide"
import {
  skillFromTemplate,
  skillTemplates,
} from "@/src/lib/build/skill-templates"
import { TracerError } from "@/src/server/tracer/errors"
import { registerBuildOperation } from "../api"

const filters = z.object({
  search: z.string().trim().max(200).optional(),
  category: z.string().trim().max(80).optional(),
})
const templateId = z.object({ id: z.string().trim().min(1).max(120) })

registerBuildOperation({
  name: "build_list_skill_templates",
  description: `List built-in skill template IDs, categories and descriptions, optionally filtered by search/category. This bounded gallery is shared with the UI. Use build_get_skill_template for an editable disabled definition; listing does not save anything.`,
  scopes: ["build:read"],
  schema: filters,
  execute: (_context, input) => {
    const summaries = skillTemplates.map(
      ({ id, category, name, description }) => ({
        id,
        category,
        name,
        description,
      })
    )
    const search = String(input.search ?? "").toLowerCase()
    const category = String(input.category ?? "").toLowerCase()
    return summaries.filter(
      (item) =>
        (!category || item.category.toLowerCase() === category) &&
        `${item.id} ${item.name} ${item.description} ${item.category}`
          .toLowerCase()
          .includes(search)
    )
  },
})
registerBuildOperation({
  name: "build_get_skill_template",
  description: `Read a built-in skill template by discovered ID. Returns a copy of its complete disabled definition for build_save_procedure. Suggested actions are guidance, not connected action IDs. Does not save or execute anything.`,
  scopes: ["build:read"],
  schema: templateId,
  execute: (_context, input) => {
    const template = skillTemplates.find((item) => item.id === input.id)
    if (template)
      return {
        id: template.id,
        category: template.category,
        suggestedActions: [...template.suggestedActions],
        definition: skillFromTemplate(template),
      }
    throw new TracerError("NOT_FOUND", `Unknown skill template '${input.id}'.`)
  },
})

registerBuildOperation({
  name: "build_get_authoring_guide",
  description:
    "Get authoritative input JSON Schema, a valid example and authoring workflow for an agent configuration, action, skill (procedure) or widget. Includes semantic constraints beyond JSON Schema, safe save/apply guidance and translation support. Does not validate or save user content.",
  scopes: ["build:read"],
  schema: z.object({ topic: authoringTopicSchema }),
  execute: (_context, input) =>
    buildAuthoringGuide(input.topic as z.infer<typeof authoringTopicSchema>),
})
