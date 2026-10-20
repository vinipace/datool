import { api, readJson } from "@/src/server/tracer/http"
import { parseId } from "@/src/server/tracer/validation"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request) {
  return api(request, (service) => service.projectHome.get())
}
export async function POST(request: Request) {
  return api(
    request,
    async (service) => service.projectHome.pin(await readJson(request)),
    { mutation: true }
  )
}
export async function PATCH(request: Request) {
  return api(
    request,
    async (service) => service.projectHome.layout(await readJson(request)),
    { mutation: true }
  )
}
export async function DELETE(request: Request) {
  return api(
    request,
    (service) =>
      service.projectHome.unpin(
        parseId(new URL(request.url).searchParams.get("id") ?? "", "pin id")
      ),
    { mutation: true }
  )
}
