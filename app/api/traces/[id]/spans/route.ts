import { api, readJson } from "@/src/server/tracer/http"
import {
  parseCreateSpan,
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
      service.createSpan(
        parseId(id, "trace id"),
        parseCreateSpan(await readJson(request))
      ),
    { mutation: true }
  )
}

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params
  const url = new URL(request.url)
  return api(request, (service) =>
    service.listTraceSpans(parseId(id, "trace id"), {
      cursor: url.searchParams.get("cursor"),
      includeTotal: url.searchParams.get("includeTotal") === "true",
      limit: parseListLimit(url.searchParams.get("limit")),
    })
  )
}
