import { api } from "@/src/server/tracer/http"
import { parseId, parseListLimit } from "@/src/server/tracer/validation"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params
  const url = new URL(request.url)
  const runId = url.searchParams.get("runId")
  return api(request, (service) =>
    service.getSavedViewData(parseId(id, "saved view id"), {
      limit: parseListLimit(url.searchParams.get("limit")),
      offset: Math.max(0, Number(url.searchParams.get("offset") ?? 0)),
      runId: runId ? parseId(runId, "runId") : undefined,
    })
  )
}
