import { authApiError } from "@/src/server/auth/errors"
import { z } from "zod"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { assertSameOrigin } from "@/src/server/auth/request"
import { authorizeOAuthProject } from "@/src/server/auth/config"
import { withOAuthProject } from "@/src/server/auth/oauth-context"
import { readJson } from "@/src/server/tracer/http"
import { TracerError } from "@/src/server/tracer/errors"
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
async function sessionFor(request: Request) {
  const session = await getAuth().api.getSession({ headers: request.headers })
  if (!session) throw new TracerError("UNAUTHORIZED", "Sign in to connect MCP.")
  return session
}
export async function GET(request: Request) {
  try {
    const session = await sessionFor(request)
    const projects = await db.query<{
      id: string
      name: string
      organizationId: string
      organizationName: string
    }>(
      `
      SELECT p.id, p.name, p.organization_id AS "organizationId", o.name AS "organizationName"
      FROM project p JOIN organization o ON o.id = p.organization_id JOIN member m ON m."organizationId" = o.id
      WHERE m."userId" = $1 ORDER BY o.name, p.name`,
      [session.user.id]
    )
    return Response.json(
      { data: { projects: projects.rows } },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    return authApiError(error)
  }
}
const input = z
  .object({
    action: z.enum(["continue", "consent"]),
    projectId: z.string().min(1).max(200),
    oauth_query: z.string().min(1).max(16000),
    accept: z.boolean().optional(),
    scope: z.string().max(4000).optional(),
  })
  .strict()
export async function POST(request: Request) {
  try {
    assertSameOrigin(request)
    const session = await sessionFor(request)
    const body = input.parse(await readJson(request))
    await authorizeOAuthProject(db, session.user.id, body.projectId, [])
    // Better Auth verifies the signed query, PKCE, client redirect, and requested scopes.
    const endpoint = body.action === "continue" ? "continue" : "consent"
    const providerHeaders = new Headers(request.headers)
    providerHeaders.delete("content-length")
    providerHeaders.set("content-type", "application/json")
    providerHeaders.set("accept", "application/json")
    const response = await withOAuthProject(body.projectId, () =>
      getAuth().handler(
        new Request(
          `${process.env.BETTER_AUTH_URL}/api/auth/oauth2/${endpoint}`,
          {
            method: "POST",
            headers: providerHeaders,
            body: JSON.stringify(
              body.action === "continue"
                ? { postLogin: true, oauth_query: body.oauth_query }
                : {
                    accept: body.accept === true,
                    scope: body.scope,
                    oauth_query: body.oauth_query,
                  }
            ),
          }
        )
      )
    )
    const result = await response.json()
    if (!response.ok)
      return Response.json(
        {
          error: {
            message:
              result.error_description ??
              result.message ??
              "Authorization failed.",
          },
        },
        { status: response.status }
      )
    return Response.json(
      { data: result },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    return authApiError(error)
  }
}
