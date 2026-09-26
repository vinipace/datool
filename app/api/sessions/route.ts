import { api, readJson } from "@/src/server/tracer/http"
import {
  parseCreateSession,
  parseListLimit,
} from "@/src/server/tracer/validation"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request) {
  const url = new URL(request.url)
  return api(request, (service) =>
    service.listSessions({
      filter: url.searchParams.get("filter"),
      cursor: url.searchParams.get("cursor"),
      includeTotal: url.searchParams.get("includeTotal") === "true",
      limit: parseListLimit(url.searchParams.get("limit")),
    }),
    { readCache: "shared" }
  )
}

export async function POST(request: Request) {
  return api(
    request,
    async (service) =>
      service.createSession(parseCreateSession(await readJson(request))),
    { mutation: true }
  )
}
