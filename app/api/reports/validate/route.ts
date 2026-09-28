import { api, readJson } from "@/src/server/tracer/http"
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export async function POST(request:Request) {
  return api(request,async service=>service.reports.validate(await readJson(request)),{mutation:true})
}
