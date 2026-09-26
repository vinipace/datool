import { authApiError } from "@/src/server/auth/errors"
import { z } from "zod"
import { db } from "@/lib/db"
import { keyAccess } from "@/src/server/auth/key-management"
import { assertSameOrigin } from "@/src/server/auth/request"
import { readJson } from "@/src/server/tracer/http"
export const dynamic = "force-dynamic"
type Context = { params: Promise<{ organizationId: string }> }
export async function GET(request: Request, context: Context) {
  try {
    const { organizationId } = await context.params
    const access = await keyAccess(request, organizationId)
    const result = await db.query(
      `SELECT c.id, client.name, p.name AS "projectName", c.scopes, c."createdAt"
      FROM "oauthConsent" c JOIN "oauthClient" client ON client."clientId" = c."clientId"
      JOIN project p ON p.id = c."referenceId"
      WHERE c."userId" = $1 AND p.organization_id = $2 ORDER BY c."createdAt" DESC`,
      [access.userId, organizationId]
    )
    return Response.json(
      { data: result.rows },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    return authApiError(error)
  }
}
export async function DELETE(request: Request, context: Context) {
  try {
    assertSameOrigin(request)
    const { organizationId } = await context.params
    const access = await keyAccess(request, organizationId)
    const { id } = z
      .object({ id: z.string().min(1) })
      .strict()
      .parse(await readJson(request))
    // The database trigger invalidates associated refresh/access tokens atomically.
    await db.query(
      `DELETE FROM "oauthConsent" c USING project p WHERE c.id = $1 AND c."userId" = $2
      AND p.id = c."referenceId" AND p.organization_id = $3`,
      [id, access.userId, organizationId]
    )
    return Response.json({ data: { revoked: true } })
  } catch (error) {
    return authApiError(error)
  }
}
