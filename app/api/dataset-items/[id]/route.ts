import { api, readJson } from "@/src/server/tracer/http"
import { parseId, parsePatchDatasetItem } from "@/src/server/tracer/validation"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

type RouteContext = { params: Promise<{ id: string }> }

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params
  return api(
    request,
    async (service) => service.patchDatasetItem(parseId(id, "dataset item id"), parsePatchDatasetItem(await readJson(request))),
    { mutation: true },
  )
}

export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params
  return api(request, (service) => service.deleteDatasetItem(parseId(id, "dataset item id")), {
    mutation: true,
  })
}
