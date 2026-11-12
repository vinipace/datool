import { handleProjectMcp, projectMcpOptions } from "@/src/server/deploy/http"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120
export const POST = (request: Request) => handleProjectMcp(request)
export const GET = POST
export const OPTIONS = projectMcpOptions
