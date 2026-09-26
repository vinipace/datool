import { api, readJson } from "@/src/server/tracer/http"
import { parseId } from "@/src/server/tracer/validation"
export const runtime = "nodejs"
type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, context: Context) {
  const { id } = await context.params
  return api(request, (service) =>
    service.reviews.get(parseId(id, "review session id"))
  )
}
export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params
  return api(
    request,
    async (service) =>
      service.reviews.update(
        parseId(id, "review session id"),
        await readJson(request)
      ),
    { mutation: true }
  )
}
