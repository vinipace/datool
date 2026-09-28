import { api, readJson } from "@/src/server/tracer/http"
import { viewHttp } from "@/src/server/tracer/view-http"
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export async function GET(request: Request) { return new URL(request.url).searchParams.has("catalog") ? viewHttp("custom-field", "list", request) : api(request, service => service.customFields.list()) }
export async function POST(request: Request) { return api<unknown>(request, async service => {
  const input = await readJson(request)
  return input && typeof input === "object" && "field" in input ? service.customFields.save(input) : service.viewLibrary.create("custom-field", input)
}, { mutation: true }) }
