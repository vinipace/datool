import { api } from "@/src/server/tracer/http"
import { parseId, parseListLimit } from "@/src/server/tracer/validation"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params
  const url = new URL(request.url)
  return api(request, (service) =>
    service.getEvalRun(parseId(id, "eval run id"), {
      includeEvidence: url.searchParams.get("includeEvidence") !== "false",
      cursor: url.searchParams.get("cursor"),
      includeTotal: url.searchParams.get("includeTotal") === "true",
      limit: parseListLimit(url.searchParams.get("limit")),
    }),
    { readCache: "shared" }
  )
}
