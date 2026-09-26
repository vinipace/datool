import { api } from "@/src/server/tracer/http"
import { parseId } from "@/src/server/tracer/validation"
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export async function GET(request: Request) {
  const url = new URL(request.url)
  return api(request, (service) =>
    service.compareEvalRuns(
      parseId(url.searchParams.get("leftId") ?? ""),
      parseId(url.searchParams.get("rightId") ?? ""),
      Number(url.searchParams.get("offset") ?? 0),
      url.searchParams.get("includeEvidence") !== "false"
    ),
    { readCache: "shared" }
  )
}
