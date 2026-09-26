import { api } from "@/src/server/tracer/http"
import { parseId } from "@/src/server/tracer/validation"
export const runtime = "nodejs"
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params
  return api(request, (service) =>
    service.getEvalPromptConfig(parseId(id, "eval run id"))
  )
}
