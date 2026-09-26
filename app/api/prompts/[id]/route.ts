import { validation } from "@/src/server/tracer/errors"
import { api, readJson } from "@/src/server/tracer/http"
export const runtime = "nodejs"
type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, context: Context) {
  const { id } = await context.params
  return api(request, (service) =>
    service.prompts.get(
      id,
      false,
      new URL(request.url).searchParams.has("version")
        ? Number(new URL(request.url).searchParams.get("version"))
        : undefined
    )
  )
}
export async function PUT(request: Request, context: Context) {
  const { id } = await context.params
  return api(
    request,
    async (service) => service.prompts.save(await readJson(request), id),
    { mutation: true }
  )
}
export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params
  return api(
    request,
    async (service) => {
      const body = (await readJson(request)) as { expectedRevision?: number }
      if (
        !Number.isSafeInteger(body?.expectedRevision) ||
        body.expectedRevision! < 1
      )
        throw validation("expectedRevision is required.")
      return service.prompts.remove(id, body.expectedRevision!)
    },
    {
      mutation: true,
    }
  )
}
