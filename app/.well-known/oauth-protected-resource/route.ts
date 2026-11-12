import {
  projectMcpConfig,
  resourceMetadata,
  authFailure,
} from "@/src/server/mcp/auth"
export const dynamic = "force-dynamic"
export function GET() {
  try {
    return Response.json(resourceMetadata(projectMcpConfig()), {
      headers: {
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    })
  } catch (error) {
    return authFailure(error)
  }
}
