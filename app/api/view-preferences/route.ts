import { api, readJson } from "@/src/server/tracer/http"
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const GET = (request: Request) => api(request, service => service.viewLibrary.preference(new URL(request.url).searchParams.get("scope") ?? ""))
export const PUT = (request: Request) => api(request, async service => service.viewLibrary.savePreference(await readJson(request)), { mutation: true })
