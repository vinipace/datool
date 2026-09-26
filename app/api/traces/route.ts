import { api, readJson } from "@/src/server/tracer/http"
import {
  parseCreateTrace,
  parseId,
  parseListLimit,
} from "@/src/server/tracer/validation"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request) {
  const url = new URL(request.url)
  return api(request, (service) =>
    service.listTraces({
      filter: url.searchParams.get("filter"),
      cursor: url.searchParams.get("cursor"),
      includeTotal: url.searchParams.get("includeTotal") === "true",
      limit: parseListLimit(url.searchParams.get("limit")),
      datasetItemId: url.searchParams.has("datasetItemId")
        ? parseId(url.searchParams.get("datasetItemId")!, "datasetItemId")
        : undefined,
      sessionId: url.searchParams.has("sessionId")
        ? parseId(url.searchParams.get("sessionId")!, "sessionId")
        : undefined,
    }),
    // Dataset membership also depends on eval targets, outside the trace revision.
    { readCache: url.searchParams.has("datasetItemId") ? "shared" : "trace-versioned" }
  )
}

export async function POST(request: Request) {
  return api(
    request,
    async (service) =>
      service.createTrace(parseCreateTrace(await readJson(request))),
    { mutation: true }
  )
}
