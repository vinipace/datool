import { api, readJson } from "@/src/server/tracer/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Bounded analytical reads only. The request selects catalog members and
 * filters; it cannot submit SQL or executable metric definitions.
 */
export async function POST(request: Request) {
  return api(request, async (service) => service.querySemanticMetrics(await readJson(request)))
}
