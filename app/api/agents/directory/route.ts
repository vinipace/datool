import { buildEnabled } from "@/lib/build/config"
import { TracerError } from "@/src/server/tracer/errors"
import { api, readJson } from "@/src/server/tracer/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: Request) {
  return api(request, async (service, context) => {
    if (!buildEnabled(context.identity.organizationId))
      throw new TracerError(
        "NOT_FOUND",
        "Agent creation is not enabled for this organization."
      )
    return service.queryAgentDirectory(await readJson(request))
  })
}
