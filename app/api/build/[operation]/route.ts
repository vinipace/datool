import { workspaceRoute, readJson } from "@/src/server/tracer/http"
import {
  executeBuildOperation,
  findBuildOperation,
} from "@/src/server/build/bootstrap"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

type Context = { params: Promise<{ operation: string }> }

/**
 * One authenticated transport for every Build capability. Permissions are
 * resolved from the operation registry before this handler runs, and the
 * same operation is available as an MCP tool.
 */
export async function POST(request: Request, context: Context) {
  const { operation } = await context.params
  return workspaceRoute(async (authorizedRequest) => {
    const maxInputBytes = findBuildOperation(operation)?.maxInputBytes
    const input = await readJson(authorizedRequest, maxInputBytes)
    const idempotencyKey = authorizedRequest.headers.get("idempotency-key")?.trim() || undefined
    const requestKey = authorizedRequest.headers.get("x-request-key")?.trim() || undefined
    const data = await executeBuildOperation(operation, input, {
      idempotencyKey,
      requestKey,
    })
    return Response.json(
      { data },
      { headers: { "Cache-Control": "no-store" } }
    )
  })(request)
}
