import { createHash } from "node:crypto"
import { z } from "zod"
import { Effect } from "effect"
import { parseCreateSession, parseCreateTrace, parseCreateSpan, parsePatchTrace, parsePatchSpan, parseId } from "../tracer/validation"
import { validation } from "../tracer/errors"
import type { TracerService } from "../tracer/service"
import type { TracerEffect } from "../tracer/effect"

const envelope = z.object({
  id: z.string().uuid(),
  previousId: z.string().uuid().nullable(),
  path: z.string().max(400),
  method: z.enum(["POST", "PATCH"]),
  body: z.unknown(),
}).strict()
export type IngestionEvent = z.infer<typeof envelope>
export function parseIngestionEvent(value: unknown): IngestionEvent {
  const parsed = envelope.safeParse(value)
  if (!parsed.success) throw validation("Invalid ingestion event envelope.")
  if (parsed.data.id === parsed.data.previousId) throw validation("An event cannot depend on itself.")
  // Validate the exact allowlisted lifecycle operation before accepting into Redis.
  operation(parsed.data)
  return parsed.data
}
export function eventDigest(event: IngestionEvent) {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex")
}
function operation(
  event: IngestionEvent
): (service: TracerService) => TracerEffect<{ id: string }> {
  const { path, method, body } = event
  if (method === "POST" && path === "/api/sessions") {
    const input = parseCreateSession(body)
    if (!input.id) throw validation("Queued sessions require a stable ID.")
    return (service: TracerService) => service.createSession(input)
  }
  if (method === "POST" && path === "/api/traces") {
    const input = parseCreateTrace(body)
    if (!input.id) throw validation("Queued traces require a stable ID.")
    return (service: TracerService) => service.createTraceReceipt(input)
  }
  const span = /^\/api\/traces\/([^/]+)\/spans$/.exec(path)
  if (method === "POST" && span) {
    const traceId = parseId(span[1], "traceId")
    const input = parseCreateSpan(body)
    if (!input.id) throw validation("Queued spans require a stable ID.")
    return (service: TracerService) => service.createSpan(traceId, input)
  }
  const target = /^\/api\/(traces|spans)\/([^/]+)$/.exec(path)
  if (method === "PATCH" && target) {
    const id = parseId(target[2], "id")
    if (target[1] === "traces") {
      const input = parsePatchTrace(body)
      return (service: TracerService) => service.patchTraceReceipt(id, input)
    }
    const input = parsePatchSpan(body)
    return (service: TracerService) => service.patchSpan(id, input)
  }
  throw validation("Unsupported ingestion operation.")
}
// New receipts retain only the resource ID. Existing stored results remain authoritative on replay.
export const applyEvent = (service: TracerService, event: IngestionEvent) =>
  Effect.map(operation(event)(service), resource => ({ id: resource.id }))
