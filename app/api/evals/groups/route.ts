import { api } from "@/src/server/tracer/http"
import { parseListLimit } from "@/src/server/tracer/validation"
import { validation } from "@/src/server/tracer/errors"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request) {
  const url = new URL(request.url)
  return api(request, (service) => {
    const groupBy = url.searchParams.get("groupBy")
    if (groupBy !== "workflow" && groupBy !== "agent")
      throw validation("groupBy must be workflow or agent.")
    return service.listEvalRunGroups({
      groupBy,
      filter: url.searchParams.get("filter"),
      cursor: url.searchParams.get("cursor"),
      includeTotal: url.searchParams.get("includeTotal") === "true",
      limit: parseListLimit(url.searchParams.get("limit")),
    })
  }, { readCache: "shared" })
}
