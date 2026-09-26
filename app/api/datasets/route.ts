import { api, readJson } from "@/src/server/tracer/http"
import {
  parseCreateDataset,
  parseListLimit,
} from "@/src/server/tracer/validation"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request) {
  const url = new URL(request.url)
  return api(request, (service) =>
    service.listDatasets({
      filter: url.searchParams.get("filter"),
      cursor: url.searchParams.get("cursor"),
      includeTotal: url.searchParams.get("includeTotal") === "true",
      limit: parseListLimit(url.searchParams.get("limit")),
    })
  )
}

export async function POST(request: Request) {
  return api(
    request,
    async (service) =>
      service.createDataset(parseCreateDataset(await readJson(request))),
    { mutation: true }
  )
}
