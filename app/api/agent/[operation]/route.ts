import { api, readJson } from "@/src/server/tracer/http"
import { agentRequestMaxBytes } from "@/src/lib/tracer/dataset-payload"
import { findAgentOperation } from "@/src/server/mcp/operations"
import { notFound } from "@/src/server/tracer/errors"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

/** POST allows structured queries; permissions come from the operation catalog. */
export async function POST(
  request: Request,
  context: { params: Promise<{ operation: string }> }
) {
  const { operation } = await context.params
  const op = findAgentOperation(operation)
  return api(
    request,
    async (service) => {
      if (!op) throw notFound("Agent operation", operation)
      return op.execute(service, await readJson(request, agentRequestMaxBytes(operation)))
    },
    { mutation: op?.scopes.some((scope) => scope.endsWith(":write")) ?? true }
  )
}
