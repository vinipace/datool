"use client"
import { useEffect } from "react"
import { prepareTraceView } from "@/src/lib/tracer/trace-view-client"
import { z } from "zod"
import {
  createReactViewSchema,
  reactViewInputSchema,
} from "@/src/lib/tracer/react-views"
import { selectProjectReactView } from "@/src/lib/tracer/react-view-preferences"
import {
  registerColumnTools,
  type PageModelContext,
  type PageTool,
} from "@/src/lib/tracer/column-webmcp"
import { reactViewsApi } from "./api"

export function useReactViewWebMcp(projectId: string) {
  useEffect(() => {
    const context =
      (document as Document & { modelContext?: PageModelContext })
        .modelContext ??
      (navigator as Navigator & { modelContext?: PageModelContext })
        .modelContext
    if (!context) return
    function tool(
      name: string,
      description: string,
      schema: z.ZodType,
      execute: (input: unknown) => Promise<unknown>,
      readOnlyHint = false
    ): PageTool {
      return {
        name,
        description,
        inputSchema: z.toJSONSchema(schema),
        annotations: { readOnlyHint, untrustedContentHint: true },
        execute: async (input) => {
          try {
            const result = await execute(schema.parse(input))
            return { content: [{ type: "text", text: JSON.stringify(result) }] }
          } catch (error) {
            return {
              isError: true,
              content: [{ type: "text", text: String(error) }],
            }
          }
        },
      }
    }
    const idSchema = z.object({ id: z.string().min(1) }).strict()
    const updateSchema = reactViewInputSchema
      .omit({ dataMode: true, objectTypes: true, inputContract: true, customFields: true })
      .partial()
      .extend({
        dataMode: z.enum(["full", "summary"]).optional(),
        objectTypes: reactViewInputSchema.shape.objectTypes.unwrap().optional(),
        inputContract: reactViewInputSchema.shape.inputContract.unwrap().optional(),
        customFields: reactViewInputSchema.shape.customFields.unwrap().optional(),
        id: z.string().min(1),
        expectedRevision: z.number().int().positive(),
      })
      .strict()
    const tools = [
      tool(
        "list_trace_views",
        "List project-wide React views, provenance and requirements. Follow nextCursor; get_trace_view returns code.",
        z.object({ cursor: z.string().optional() }).strict(),
        (input) =>
          reactViewsApi.list(projectId, (input as { cursor?: string }).cursor),
        true
      ),
      tool(
        "get_trace_view",
        "Read a project React view including its code and current revision.",
        idSchema,
        (input) => reactViewsApi.get(projectId, (input as { id: string }).id),
        true
      ),
      tool(
        "create_trace_view",
        "Save a project-wide Object View and open or activate its own closable tab in an open trace inspector when it supports traces. Source is optional origin context, never a restriction. Requirements null means unknown; [] means explicitly no required fields. New components use inputContract=object and ViewProps { kind, object, context, fields }; legacy-trace components receive { trace }. Imports from react, @datool/ui and @datool/charts are supported. Static Tailwind uses the Datool theme. dataMode summary excludes child spans and scores. This does not change a review session's shared defaultObjectViewId.",
        createReactViewSchema,
        async (input) => {
          const settings = createReactViewSchema.parse(input)
          await prepareTraceView(settings.code)
          const view = await reactViewsApi.create(projectId, settings)
          selectProjectReactView(projectId, view)
          return view
        }
      ),
      tool(
        "update_trace_view",
        "Update a shared project view with its expectedRevision and open or activate its trace tab when a trace inspector is open. A code change without reviewed requirements resets compatibility to unknown. Editing the definition affects the project library; it does not change a review session's default view setting.",
        updateSchema,
        async (input) => {
          const { id, expectedRevision, ...patch } = updateSchema.parse(input)
          const existing = await reactViewsApi.get(projectId, id)
          const settings = reactViewInputSchema.parse({
            name: patch.name ?? existing.name,
            description: patch.description ?? existing.description,
            code: patch.code ?? existing.code,
            dataMode: patch.dataMode ?? existing.dataMode,
            objectTypes: patch.objectTypes ?? existing.objectTypes,
            inputContract: patch.inputContract ?? existing.inputContract,
            customFields: patch.customFields ?? existing.customFields,
            requirements:
              patch.requirements !== undefined
                ? patch.requirements
                : (patch.code !== undefined && patch.code !== existing.code) ||
                    (patch.dataMode !== undefined &&
                      patch.dataMode !== existing.dataMode) ||
                    (patch.inputContract !== undefined &&
                      patch.inputContract !== existing.inputContract)
                  ? null
                  : existing.requirements,
          })
          await prepareTraceView(settings.code)
          const view = await reactViewsApi.update(projectId, id, {
            ...settings,
            expectedRevision,
          })
          selectProjectReactView(projectId, view)
          return view
        }
      ),
      tool(
        "select_trace_view",
        "Open or activate a saved trace-compatible Object View as its own closable tab in an open trace inspector. The fixed Views tab remains the card library; selecting an already open view reuses its tab. This browser selection does not set the review session's shared defaultObjectViewId; use update_review_session for that setting.",
        idSchema,
        async (input) => {
          const view = await reactViewsApi.get(
            projectId,
            (input as { id: string }).id
          )
          if (!(view.objectTypes ?? ["trace", "dataset-item"]).includes("trace"))
            throw new Error("This Object View does not support traces.")
          selectProjectReactView(projectId, view)
          return { selected: view.id }
        }
      ),
      tool(
        "delete_trace_view",
        "Delete a view from the entire project library using its current revision.",
        idSchema.extend({ expectedRevision: z.number().int().positive() }),
        async (input) => {
          const { id, expectedRevision } = input as {
            id: string
            expectedRevision: number
          }
          const result = await reactViewsApi.delete(
            projectId,
            id,
            expectedRevision
          )
          selectProjectReactView(projectId, null)
          return result
        }
      ),
    ]
    return registerColumnTools(context, tools, console.warn)
  }, [projectId])
}
