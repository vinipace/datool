import { api } from "@/src/server/tracer/http"
import { parseId } from "@/src/server/tracer/validation"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; targetId: string }> }
) {
  const { id, targetId } = await context.params
  return api(request, (service) =>
    service.getEvalRunTarget(
      parseId(id, "eval run id"),
      parseId(targetId, "eval target id")
    )
  )
}
