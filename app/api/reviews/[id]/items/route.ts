import { api, readJson } from "@/src/server/tracer/http"
import { parseId } from "@/src/server/tracer/validation"

export const runtime = "nodejs"
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params
  return api(
    request,
    async (service) =>
      service.reviews.mutateSelection(
        parseId(id, "review session id"),
        await readJson(request)
      ),
    { mutation: true }
  )
}
