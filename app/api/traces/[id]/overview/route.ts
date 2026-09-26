import { api } from "@/src/server/tracer/http"
import { parseId } from "@/src/server/tracer/validation"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request, context: {
  params: Promise<{ id: string }>
}) {
  const { id } = await context.params
  const includeRootDetail = new URL(request.url).searchParams.get("includeRootDetail") === "true"
  return api(request, service => service.getTraceOverview(parseId(id, "trace id"), includeRootDetail), { readCache: "trace-versioned" })
}
