import { api, readJson } from "@/src/server/tracer/http"
import { parseId, parsePatchTrace } from "@/src/server/tracer/validation"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params
  return api(request, (service) => service.getTrace(parseId(id, "trace id")))
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params
  return api(
    request,
    async (service) => service.patchTrace(parseId(id, "trace id"), parsePatchTrace(await readJson(request))),
    { mutation: true },
  )
}
