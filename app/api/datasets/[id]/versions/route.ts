import { api } from "@/src/server/tracer/http"
import { parseId, parseListLimit } from "@/src/server/tracer/validation"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const url = new URL(request.url)
  return api(request, (service) => service.listDatasetVersions(parseId(id, "dataset id"), {
    cursor: url.searchParams.get("cursor"),
    limit: parseListLimit(url.searchParams.get("limit")),
    includeTotal: url.searchParams.get("includeTotal") === "true",
  }))
}
