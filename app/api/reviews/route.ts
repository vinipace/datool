import { api, readJson } from "@/src/server/tracer/http"
import { parseListLimit } from "@/src/server/tracer/validation"
export const runtime = "nodejs"
export async function GET(request: Request) {
  const url = new URL(request.url)
  return api(request, (service) =>
    service.reviews.list({
      filter: url.searchParams.get("filter") ?? undefined,
      cursor: url.searchParams.get("cursor"),
      limit: parseListLimit(url.searchParams.get("limit")),
      includeTotal: url.searchParams.get("includeTotal") === "true",
    })
  )
}
export async function POST(request: Request) {
  return api(
    request,
    async (service) => service.reviews.create(await readJson(request)),
    { mutation: true }
  )
}
