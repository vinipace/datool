import { api, readJson } from "@/src/server/tracer/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request) {
  return api(request, (service) =>
    service.customViews.list(
      new URL(request.url).searchParams.get("resource") ?? "eval-runs"
    )
  )
}
export async function POST(request: Request) {
  return api(
    request,
    async (service) => service.customViews.create(await readJson(request)),
    { mutation: true }
  )
}
