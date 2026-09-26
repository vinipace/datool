import { api } from "@/src/server/tracer/http"
import { parseId } from "@/src/server/tracer/validation"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params
  return api(request, (service) => service.getSession(parseId(id, "session id")), { readCache: "shared" })
}
