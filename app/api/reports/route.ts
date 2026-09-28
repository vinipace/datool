import { api, readJson } from "@/src/server/tracer/http"
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export async function GET(request: Request) {
  return api(request, (service) => service.reports.list())
}
export async function POST(request: Request) {
  return api(
    request,
    async (service) => service.reports.create(await readJson(request)),
    { mutation: true }
  )
}
