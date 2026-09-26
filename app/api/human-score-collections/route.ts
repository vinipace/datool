import { api, readJson } from "@/src/server/tracer/http"
export const runtime = "nodejs"
export async function GET(request: Request) {
  return api(request, (service) => service.humanScores.library())
}
export async function POST(request: Request) {
  return api(
    request,
    async (service) =>
      service.humanScores.createCollection(await readJson(request)),
    { mutation: true }
  )
}
