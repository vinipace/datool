import { api, readJson } from "@/src/server/tracer/http"
export const runtime = "nodejs"
type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, context: Context) {
  const { id } = await context.params
  return api(request, (service) => service.scorers.get(id))
}
export async function PUT(request: Request, context: Context) {
  const { id } = await context.params
  return api(
    request,
    async (service) => service.scorers.save(await readJson(request), id),
    { mutation: true }
  )
}
export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params
  return api(request, (service) => service.scorers.remove(id), {
    mutation: true,
  })
}
