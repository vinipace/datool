import { z } from "zod"
import { widgetTemplates } from "@/src/lib/build/widget-templates"
import { widgetComponentsGuide } from "@/src/lib/build/authoring-guide"
import { widgetPreviewOptionsSchema } from "@/src/lib/build/widget-validation"
import { validateWidgetDefinition } from "@/src/lib/build/widget-authoring-validation"
import { notFound, TracerError } from "@/src/server/tracer/errors"
import { registerBuildOperation } from "../api"

registerBuildOperation({
  name: "build_list_widget_templates",
  description:
    "Discover widget starters from the same catalog as the Widgets editor. Search name, description and category; get a template's complete JSX, schema and representative default data with build_get_widget_template before creating a widget.",
  scopes: ["build:read"],
  schema: z.object({
    search: z.string().trim().max(200).optional(),
    category: z.string().trim().max(80).optional(),
  }),
  execute: (_context, { search, category }) =>
    widgetTemplates
      .filter(
        (item) =>
          (!category ||
            item.category.toLowerCase() === String(category).toLowerCase()) &&
          `${item.id} ${item.category} ${item.definition.name} ${item.definition.description}`
            .toLowerCase()
            .includes(
              String(search ?? "")
                .trim()
                .toLowerCase()
            )
      )
      .map(({ id, category, previewImage, definition }) => ({
        id,
        category,
        previewImage,
        name: definition.name,
        description: definition.description,
        locales: ["en", ...Object.keys(definition.translations ?? {})],
      })),
})
registerBuildOperation({
  name: "build_get_widget_template",
  description:
    "Read a complete editable widget starter, including JSX, Zod schema, example state and Function placeholders. Examples are synthetic, actions are unbound and templates are disabled. Does not create a widget or connect a service.",
  scopes: ["build:read"],
  schema: z.object({
    templateId: z.string().trim().min(1).max(120).optional(),
    id: z.string().trim().min(1).max(120).optional(),
  }),
  execute: (_context, { templateId, id }) => {
    if ((!templateId && !id) || (templateId && id && templateId !== id))
      throw new TracerError(
        "VALIDATION_ERROR",
        "Provide a templateId or id; aliases must agree when both are supplied."
      )
    templateId ??= id
    const template = widgetTemplates.find((item) => item.id === templateId)
    if (!template) throw notFound("Widget template", String(templateId))
    return structuredClone(template)
  },
})
registerBuildOperation({
  name: "build_get_widget_components",
  description:
    "Read supported widget components, their props and insertion examples, allowed imports, helpers and Function binding contract. These are the Widgets editor's components; do not assume application UI imports are available.",
  scopes: ["build:read"],
  schema: z.object({}),
  execute: () => widgetComponentsGuide(),
})
registerBuildOperation({
  name: "build_validate_widget",
  description:
    "Check a proposed widget definition without saving: syntax, selected example state and unbound Functions. Never executes JSX or Zod source on the server. Returns rendered:false and schemaValidated:false; use build_validate_widget_preview in the browser's Widgets section for actual rendering, schema, image and empty-preview checks.",
  scopes: ["build:read"],
  schema: widgetPreviewOptionsSchema.extend({
    definition: z.record(z.string().max(120), z.json()),
  }),
  execute: (_context, input) =>
    validateWidgetDefinition(
      input.definition,
      String(input.state),
      Boolean(input.allowEmpty)
    ),
})
