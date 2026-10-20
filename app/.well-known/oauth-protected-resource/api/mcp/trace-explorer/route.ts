import { authFailure, resourceMetadata } from "@/src/server/mcp/auth"
import { traceExplorerConfig } from "@/src/server/mcp/trace-explorer"

export const dynamic = "force-dynamic"
export function GET() {
  try {
    return Response.json(resourceMetadata(traceExplorerConfig()), {
      headers: {
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    })
  } catch (error) {
    return authFailure(error)
  }
}
