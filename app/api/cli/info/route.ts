import {
  cliProtocolVersion,
  minimumCliVersion,
} from "@/src/lib/auth/cli-contract"
import { cliConfig } from "@/src/server/mcp/auth"

export const dynamic = "force-dynamic"
export function GET() {
  const config = cliConfig()
  return Response.json(
    {
      data: {
        protocolVersion: cliProtocolVersion,
        minimumCliVersion,
        oauthResource: config.resource,
        issuer: config.issuer,
        capabilities: [
          "agent",
          "traces",
          "cli-oauth",
          "permission-diagnostics",
        ],
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
