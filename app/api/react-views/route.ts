import { api, readJson } from "@/src/server/tracer/http"
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export function GET(request: Request) {
  const params = new URL(request.url).searchParams
  return api(request, (service) =>
    service.reactViews.list({
      cursor: params.get("cursor") ?? undefined,
      limit: params.has("limit") ? Number(params.get("limit")) : undefined,
    })
  )
}
export function POST(request: Request) {
  return api(
    request,
    async (service) => service.reactViews.create(await readJson(request)),
    { mutation: true }
  )
}
