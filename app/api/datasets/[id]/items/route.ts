import { api, readJson } from "@/src/server/tracer/http"
import {
  parseCreateDatasetItem,
  parseListLimit,
  parseId,
} from "@/src/server/tracer/validation"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params
  return api(
    request,
    async (service) =>
      service.createDatasetItem(
        parseId(id, "dataset id"),
        parseCreateDatasetItem(await readJson(request))
      ),
    { mutation: true }
  )
}

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params
  const url = new URL(request.url)
  return api(request, (service) =>
    service.listDatasetItems(parseId(id, "dataset id"), {
      filter: url.searchParams.get("filter"),
      cursor: url.searchParams.get("cursor"),
      includeTotal: url.searchParams.get("includeTotal") === "true",
      limit: parseListLimit(url.searchParams.get("limit")),
    })
  )
}
