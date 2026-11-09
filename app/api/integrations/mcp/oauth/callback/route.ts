import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/project-access"
import { roleScopes } from "@/src/lib/auth/permissions"
import { createBuildContext } from "@/src/server/build/context"
import {
  completeMcpOAuth,
  mcpOAuthStateHash,
} from "@/src/server/build/integrations/mcp-oauth"
import { createTracerDatabase } from "@/src/server/tracer/db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const headers = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  }
  try {
    const query = new URL(request.url).searchParams
    const state = query.get("state") ?? ""
    if (!/^[\w-]{43}$/.test(state))
      throw new Error("Invalid authorization state")
    const result = await db.query<{ project_id: string }>(
      "SELECT project_id FROM build_mcp_oauth_requests WHERE state_hash=$1 AND expires_at>now() AND claimed_at IS NULL",
      [mcpOAuthStateHash(state)]
    )
    const projectId = result.rows[0]?.project_id
    if (!projectId) throw new Error("Expired authorization")
    const access = await requireProjectAccess(request, projectId)
    if (
      access.kind !== "ok" ||
      !roleScopes(access.access.role).includes("build:write")
    )
      return new Response(
        "Sign in with the account that started this connection, then try again.",
        { status: 403, headers }
      )
    const context = createBuildContext(
      createTracerDatabase(undefined, { projectId }),
      {
        projectId,
        organizationId: access.access.project.organizationId,
        actorId: access.access.userId,
      }
    )
    const completed = await completeMcpOAuth(context, {
      state,
      code: query.get("code") ?? undefined,
      denied: query.has("error"),
    })
    const target = new URL(completed.returnTo, process.env.BETTER_AUTH_URL)
    target.searchParams.set("mcpOAuth", completed.success ? completed.toolsReady === false ? "tools_error" : "success" : "error")
    return new Response(null, {
      status: 303,
      headers: { ...headers, Location: target.href },
    })
  } catch {
    return new Response(
      "This MCP sign-in link has expired or could not be verified. Return to Integrations and connect again.",
      { status: 400, headers }
    )
  }
}
