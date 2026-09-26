import { api, readJson } from "@/src/server/tracer/http"
import { parseId } from "@/src/server/tracer/validation"
export const runtime = "nodejs"
type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, context: Context) {
  const { id } = await context.params
  return api(request, (service) =>
    service.humanScores.collection(parseId(id, "Human Score id"))
  )
}
export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params
  return api(
    request,
    async (service) =>
      service.humanScores.updateCollection(
        parseId(id, "Human Score id"),
        await readJson(request)
      ),
    { mutation: true }
  )
}
