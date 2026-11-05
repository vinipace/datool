import { buildEnabled } from "@/lib/build/config"
import { TracerError } from "@/src/server/tracer/errors"
import { api } from "@/src/server/tracer/http"
import { parseListLimit } from "@/src/server/tracer/validation"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request) {
  const url = new URL(request.url)
  return api(request, (service, context) => {
    if (!buildEnabled(context.identity.organizationId))
      throw new TracerError(
        "NOT_FOUND",
        "Agent conversations are not enabled for this organization."
      )
    return service.listSessionActivity({
      filter: url.searchParams.get("filter"),
      cursor: url.searchParams.get("cursor"),
      includeTotal: url.searchParams.get("includeTotal") === "true",
      limit: parseListLimit(url.searchParams.get("limit")),
    })
  })
}
