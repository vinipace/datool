import { api, readJson } from "@/src/server/tracer/http"
import { parseId, parsePatchDataset } from "@/src/server/tracer/validation"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params
  return api(request, (service) => service.getDataset(parseId(id, "dataset id"), {
    includeItems: new URL(request.url).searchParams.get("includeItems") !== "false",
  }))
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params
  return api(
    request,
    async (service) => service.patchDataset(parseId(id, "dataset id"), parsePatchDataset(await readJson(request))),
    { mutation: true },
  )
}
