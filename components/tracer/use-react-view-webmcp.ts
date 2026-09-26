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
      .omit({ dataMode: true })
      .partial()
      .extend({
        dataMode: z.enum(["full", "summary"]).optional(),
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
        "Save and select a project-wide React view. Source is optional origin context, never a restriction. Requirements null means unknown; [] means explicitly no required fields. Code exports a default component receiving ViewProps { trace }; Imports from react, @datool/ui and @datool/charts are supported. Static Tailwind uses the Datool theme. dataMode summary excludes child spans and scores.",
        createReactViewSchema,
        async (input) => {
          const settings = createReactViewSchema.parse(input)
          await prepareTraceView(settings.code)
          const view = await reactViewsApi.create(projectId, settings)
          selectProjectReactView(projectId, view.id)
          return view
        }
      ),
      tool(
        "update_trace_view",
        "Update a shared project view with its expectedRevision. A code change without reviewed requirements resets compatibility to unknown.",
        updateSchema,
        async (input) => {
          const { id, expectedRevision, ...patch } = updateSchema.parse(input)
          const existing = await reactViewsApi.get(projectId, id)
          const settings = reactViewInputSchema.parse({
            name: patch.name ?? existing.name,
            description: patch.description ?? existing.description,
            code: patch.code ?? existing.code,
            dataMode: patch.dataMode ?? existing.dataMode,
            requirements:
              patch.requirements !== undefined
                ? patch.requirements
                : (patch.code !== undefined && patch.code !== existing.code) ||
                    (patch.dataMode !== undefined &&
                      patch.dataMode !== existing.dataMode)
                  ? null
                  : existing.requirements,
          })
          await prepareTraceView(settings.code)
          const view = await reactViewsApi.update(projectId, id, {
            ...settings,
            expectedRevision,
          })
          selectProjectReactView(projectId, view.id)
          return view
        }
      ),
      tool(
        "select_trace_view",
        "Select a project view for this browser and preview the current record when Views is open.",
        idSchema,
        async (input) => {
          const view = await reactViewsApi.get(
            projectId,
            (input as { id: string }).id
          )
          selectProjectReactView(projectId, view.id)
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
          selectProjectReactView(projectId, "")
          return result
        }
      ),
    ]
    return registerColumnTools(context, tools, console.warn)
  }, [projectId])
}
