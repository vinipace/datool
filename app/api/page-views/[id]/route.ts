import { viewHttp } from "@/src/server/tracer/view-http"
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
type Context = { params: Promise<{ id: string }> }
export const GET = async (request: Request, context: Context) => viewHttp("page-view", "get", request, (await context.params).id)
export const PUT = async (request: Request, context: Context) => viewHttp("page-view", "update", request, (await context.params).id)
export const DELETE = async (request: Request, context: Context) => viewHttp("page-view", "delete", request, (await context.params).id)
