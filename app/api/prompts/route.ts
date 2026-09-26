import { api, readJson } from "@/src/server/tracer/http"
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export async function GET(request: Request) {
  return api(request, (service) => service.prompts.list())
}
export async function POST(request: Request) {
  return api(
    request,
    async (service) => service.prompts.save(await readJson(request)),
    { mutation: true }
  )
}
