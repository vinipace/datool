import { mcpConfig, resourceMetadata, authFailure } from "@/src/server/mcp/auth"
export const dynamic = "force-dynamic"
export function GET() {
  try {
    return Response.json(resourceMetadata(mcpConfig()), {
      headers: {
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    })
  } catch (error) {
    return authFailure(error)
  }
}
