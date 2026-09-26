import { api, readJson } from "@/src/server/tracer/http"
import { tracerEffect } from "@/src/server/tracer/effect"
import { previewPrompt } from "@/src/server/tracer/prompt-preview"
export const runtime = "nodejs"
export async function POST(request: Request) {
  return api(
    request,
    async (_service, context) => {
      const body = await readJson(request)
      return tracerEffect(() =>
        previewPrompt(body, context.projectId, { signal: request.signal })
      )
    },
    { mutation: true }
  )
}
