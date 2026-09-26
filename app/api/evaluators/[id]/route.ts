import { api, readJson } from "@/src/server/tracer/http"
import { parseId, parsePatchEvaluator } from "@/src/server/tracer/validation"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params
  return api(request, (service) => service.getEvaluator(parseId(id, "evaluator id")))
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params
  return api(
    request,
    async (service) => service.patchEvaluator(parseId(id, "evaluator id"), parsePatchEvaluator(await readJson(request))),
    { mutation: true },
  )
}
