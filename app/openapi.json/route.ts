import { docsOrigin } from "@/lib/docs-origin"
import { agentOpenApi } from "@/src/server/mcp/openapi"

export const dynamic = "force-dynamic"

export function GET(request: Request) {
  return Response.json(agentOpenApi(docsOrigin(request)), {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  })
}
