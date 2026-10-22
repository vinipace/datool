"use client"

import { useEffect } from "react"
import { z } from "zod"
import {
  registerColumnTools,
  type PageModelContext,
  type PageTool,
} from "@/src/lib/tracer/column-webmcp"
import { widgetPreviewOptionsSchema } from "@/src/lib/build/widget-validation"
import { validateWidgetPreview } from "@/src/lib/build/widget-preview-client"
import type { WidgetRecord } from "@/src/lib/build/contracts"
import { buildCall } from "../shared/build-api"

const inputSchema = widgetPreviewOptionsSchema
  .extend({
    definition: z.record(z.string(), z.json()).optional(),
    widgetId: z.string().min(1).max(200).optional(),
    width: z.number().int().min(240).max(1440).default(360),
  })
  .refine(
    (input) => Boolean(input.definition) !== Boolean(input.widgetId),
    "Provide either a candidate definition or a saved widgetId."
  )

export function useWidgetWebMcp(agentId: string) {
  useEffect(() => {
    const context =
      (document as Document & { modelContext?: PageModelContext })
        .modelContext ??
      (navigator as Navigator & { modelContext?: PageModelContext })
        .modelContext
    if (!context) return
    const controller = new AbortController()
    const tool: PageTool = {
      name: "build_validate_widget_preview",
      description:
        "Render a candidate definition or saved widgetId for the currently open agent in Datool's isolated widget sandbox. Validates actual Zod data, visible content, images and viewport overflow. Defaults to state=default, width=360, allowEmpty=false. Does not save, enable, apply or dispatch actions. A saved widget result includes its revision. Reports are observations, not proof of visual quality; inspect light/dark and mobile/desktop too.",
      inputSchema: z.toJSONSchema(inputSchema, { io: "input" }),
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (value) => {
        try {
          const input = inputSchema.parse(value)
          const record = input.widgetId
            ? await buildCall<WidgetRecord>("build_get_widget", {
                agentId,
                widgetId: input.widgetId,
              })
            : null
          const result = await validateWidgetPreview(
            record?.definition ?? input.definition,
            { ...input, signal: controller.signal }
          )
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ...result,
                  nextStep: result.valid
                    ? "Preview checks passed. Review the visible saved editor in light/dark and narrow/wide layouts before reporting completion."
                    : "Repair the listed errors and rerun this check. For missing images reuse a path returned by build_get_widget_template or build_get_widget_components.exampleAssets. If this is saved, update with expectedRevision and a new requestKey, then check that saved widgetId again. This preview is not ready.",
                  agentId,
                  ...(record
                    ? { widgetId: record.id, revision: record.revision }
                    : {}),
                }),
              },
            ],
          }
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text", text: String(error) }],
          }
        }
      },
    }
    const dispose = registerColumnTools(context, [tool], () =>
      controller.abort()
    )
    return () => {
      controller.abort()
      dispose()
    }
  }, [agentId])
}
