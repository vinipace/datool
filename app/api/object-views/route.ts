import { viewHttp } from "@/src/server/tracer/view-http"
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const GET = (request: Request) => viewHttp("object-view", "list", request)
export const POST = (request: Request) => viewHttp("object-view", "create", request)
