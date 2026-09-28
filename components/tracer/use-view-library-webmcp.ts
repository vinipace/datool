"use client"
import { useEffect } from "react"
import { z } from "zod"
import { viewOperations } from "@/src/lib/tracer/view-operations"
import { registerColumnTools, type PageModelContext, type PageTool } from "@/src/lib/tracer/column-webmcp"
import { callViewOperation } from "./view-library-client"

export function useViewLibraryWebMcp(projectId: string) {
  useEffect(() => {
    const context = (document as Document & { modelContext?: PageModelContext }).modelContext
      ?? (navigator as Navigator & { modelContext?: PageModelContext }).modelContext
    if (!context) return
    const tools: PageTool[] = viewOperations.map(operation => ({
      name: operation.name, description: operation.description, inputSchema: z.toJSONSchema(operation.schema),
      annotations: { readOnlyHint: !operation.write, untrustedContentHint: true },
      execute: async input => {
        try {
          const result = await callViewOperation(projectId, operation.name, operation.schema.strict().parse(input))
          return { content: [{ type: "text", text: JSON.stringify(result) }] }
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: String(error) }] }
        }
      },
    }))
    return registerColumnTools(context, tools, error => console.error("View tools could not register", error))
  }, [projectId])
}
