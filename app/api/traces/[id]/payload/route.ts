import { api } from "@/src/server/tracer/http"
import { parseId } from "@/src/server/tracer/validation"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request, context: {
  params: Promise<{ id: string }>
}) {
  const { id } = await context.params
  return api(request, service => service.getTracePayload(parseId(id, "trace id")))
}
