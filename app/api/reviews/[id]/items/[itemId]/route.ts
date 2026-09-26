import { api, readJson } from "@/src/server/tracer/http"
import { parseId } from "@/src/server/tracer/validation"
export const runtime = "nodejs"
type Context = { params: Promise<{ id: string; itemId: string }> }
export async function GET(request: Request, context: Context) {
  const { id, itemId } = await context.params
  return api(request, (service) =>
    service.reviews.item(
      parseId(id, "review session id"),
      parseId(itemId, "review item id")
    )
  )
}
export async function PUT(request: Request, context: Context) {
  const { id, itemId } = await context.params
  return api(
    request,
    async (service) =>
      service.reviews.record(
        parseId(id, "review session id"),
        parseId(itemId, "review item id"),
        await readJson(request)
      ),
    { mutation: true }
  )
}
