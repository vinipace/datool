import { mcpOAuthClientMetadata } from "@/src/server/build/integrations/mcp-oauth"

export const runtime = "nodejs"
export function GET() {
  return Response.json(mcpOAuthClientMetadata(), {
    headers: { "Cache-Control": "public, max-age=300" },
  })
}
