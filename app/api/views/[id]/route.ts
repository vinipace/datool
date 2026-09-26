import { api, readJson } from "@/src/server/tracer/http"
import { parseId, parsePatchSavedView } from "@/src/server/tracer/validation"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params
  return api(request, (service) => service.getSavedView(parseId(id, "saved view id")))
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params
  return api(
    request,
    async (service) => service.patchSavedView(parseId(id, "saved view id"), parsePatchSavedView(await readJson(request))),
    { mutation: true },
  )
}

export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params
  return api(request, (service) => service.deleteSavedView(parseId(id, "saved view id")), {
    mutation: true,
  })
}
