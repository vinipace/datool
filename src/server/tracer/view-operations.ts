import type { ViewOperation } from "@/src/lib/tracer/view-operations"
import { objectTypes, pageViewResources } from "@/src/lib/tracer/view-resources"
import type { TracerService } from "./service"
import { tracerEffect, type TracerEffect } from "./effect"
import { validation } from "./errors"

export function executeViewOperation(operation: ViewOperation, service: TracerService, value: unknown): TracerEffect<unknown> {
  const parsed = operation.schema.strict().safeParse(value)
  if (!parsed.success) return tracerEffect(async () => { throw validation(parsed.error.message) })
  const input = parsed.data as Record<string, unknown>
  const library = service.viewLibrary
  const kind = operation.kind ?? "page-view"
  const id = input.id as string
  switch (operation.action) {
    case "list": return library.list(kind, input)
    case "get": return library.get(kind, id, input.revision as number | undefined)
    case "create": return library.create(kind, input.definition)
    case "update": return library.update(kind, id, input.definition)
    case "copy": return library.copy(kind, id, input.name as string)
    case "delete": return library.delete(kind, id, input.expectedRevision as number)
    case "history": return library.history(kind, id, input.before as number | undefined)
    case "restore": return library.restore(kind, id, input.revision as number, input.expectedRevision as number)
    case "dependencies": return library.dependencies(kind, id)
    case "validate": return library.validate(kind, input.definition)
    case "resolve": return library.resolve(id, input.revision as number | undefined)
    case "evaluate": return library.evaluate(input)
    case "preview": return library.preview(input)
    case "data": { const { id: _, ...options } = input; void _; return library.data(id, options) }
    case "preference": return library.preference(input.scope as string)
    case "savePreference": return library.savePreference(input)
    case "capabilities": return tracerEffect(async () => ({ resources: pageViewResources, objectTypes, customFieldQuery: { sort: false, filter: false }, objectViewPreview: { syntax: true, headlessRender: false }, preferences: { persistence: "database", scope: "project/principal/page" } }))
    default: return tracerEffect(async () => { throw validation("Unsupported view operation.") })
  }
}
