import { api, readJson } from "@/src/server/tracer/http"
import { parseId } from "@/src/server/tracer/validation"
export const runtime = "nodejs"
export async function POST(request: Request) {
  return api(
    request,
    async (service) => service.importedScores.import(await readJson(request)),
    { mutation: true }
  )
}
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const id = params.get("id")
  if (id)
    return api(request, (service) => service.importedScores.get(parseId(id)))
  return api(request, (service) =>
    service.importedScores.list({ cursor: params.get("cursor") })
  )
}
