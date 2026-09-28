import { viewOperations } from "@/src/lib/tracer/view-operations"
import type { ViewResourceKind } from "@/src/lib/tracer/view-resources"
import { api, readJson } from "./http"
import { executeViewOperation } from "./view-operations"
import { tracerEffect } from "./effect"
import { validation } from "./errors"

export function viewHttp(kind: ViewResourceKind, action: string, request: Request, id?: string) {
  const operation = viewOperations.find(op => op.kind === kind && op.action === action)
  return api(request, async service => {
    if (!operation) return tracerEffect(async () => { throw validation("Unsupported view operation.") })
    const params = new URL(request.url).searchParams
    const input: Record<string, unknown> = request.method === "GET" || request.method === "DELETE"
      ? Object.fromEntries([...params].filter(([key]) => key !== "projectId" && key !== "catalog"))
      : await readJson(request) as Record<string, unknown>
    for (const key of ["limit", "offset", "revision", "expectedRevision", "before"]) if (typeof input[key] === "string") input[key] = Number(input[key])
    if (id) input.id = id
    if (action === "create" || action === "update" || action === "validate") {
      const { id: _, ...definition } = input
      void _
      return executeViewOperation(operation, service, { ...(id ? { id } : {}), definition })
    }
    return executeViewOperation(operation, service, input)
  }, { mutation: operation?.write ?? false })
}
