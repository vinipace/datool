import { api } from "@/src/server/tracer/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Discover the static, source-owned semantic metric catalog. */
export async function GET(request: Request) {
  return api(request, (service) => service.getSemanticMetricsMetadata())
}
