import { api, readJson } from "@/src/server/tracer/http"

export const runtime = "nodejs"

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params
  return api(
    request,
    async (service) => service.prompts.publish(id, await readJson(request)),
    { mutation: true }
  )
}
