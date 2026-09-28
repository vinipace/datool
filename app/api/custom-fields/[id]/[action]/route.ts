import { viewHttp } from "@/src/server/tracer/view-http"
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
type Context = { params: Promise<{ id: string; action: string }> }
export async function GET(request: Request, context: Context) {
  const { id, action } = await context.params
  return viewHttp("custom-field", ["history", "dependencies", "resolve", "data"].includes(action) ? action : "unsupported", request, id)
}
export async function POST(request: Request, context: Context) {
  const { id, action } = await context.params
  return viewHttp("custom-field", ["copy", "restore", "evaluate", "preview"].includes(action) ? action : "unsupported", request, id)
}
