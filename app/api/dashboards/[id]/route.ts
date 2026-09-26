import { api, readJson } from "@/src/server/tracer/http"
import { parseId } from "@/src/server/tracer/validation"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
type Context = { params: Promise<{ id: string }> }

export async function GET(request: Request, context: Context) {
  const { id } = await context.params
  return api(request, (service) =>
    service.dashboards.get(parseId(id, "dashboard id"))
  )
}
export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params
  return api(
    request,
    async (service) =>
      service.dashboards.update(
        parseId(id, "dashboard id"),
        await readJson(request)
      ),
    { mutation: true }
  )
}
export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params
  return api(
    request,
    (service) =>
      service.dashboards.delete(
        parseId(id, "dashboard id"),
        Number(new URL(request.url).searchParams.get("expectedRevision"))
      ),
    { mutation: true }
  )
}
