import { workspaceRoute, readJson } from "@/src/server/tracer/http"
import { getBuildContext } from "@/src/server/build/context"
import { projectMcp } from "@/src/server/deploy/mcp"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120
export const POST = workspaceRoute(async (request) =>
  projectMcp(getBuildContext(), request, await readJson(request, 128 * 1024))
)
export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } })
}
