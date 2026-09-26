import { handleMcp, mcpOptions } from "@/src/server/mcp/http"
export const runtime = "nodejs"
export const maxDuration = 120
export const dynamic = "force-dynamic"
export const POST = (request: Request) => handleMcp(request)
export const GET = POST
export const DELETE = POST
export const OPTIONS = mcpOptions
