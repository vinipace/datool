import { db } from "@/lib/db"
import { requireOrganizationRole } from "@/lib/project-access"
import { authApiError } from "@/src/server/auth/errors"
import { invitationEmailConfigured } from "@/src/server/auth/invitation-email"
import { TracerError } from "@/src/server/tracer/errors"
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
) {
  try {
    const { organizationId } = await context.params
    const access = await requireOrganizationRole(request, organizationId)
    if (access.kind !== "ok")
      throw new TracerError(
        "UNAUTHORIZED",
        "Organization membership required.",
        { status: access.kind === "unauthenticated" ? 401 : 403 }
      )
    const canManage = access.role === "owner" || access.role === "admin"
    const [members, invitations] = await Promise.all([
      db.query(
        `SELECT m.id,m."userId",m.role,m."createdAt",u.name,u.email FROM member m
        JOIN "user" u ON u.id=m."userId" WHERE m."organizationId"=$1
        ORDER BY m."createdAt",m.id`,
        [organizationId]
      ),
      canManage
        ? db.query(
            `SELECT i.id,i.email,i.role,i."expiresAt",i."createdAt",i."expiresAt"<=now() AS expired,e.status AS "emailStatus"
        FROM invitation i LEFT JOIN invitation_email e ON e.invitation_id=i.id
        WHERE i."organizationId"=$1 AND i.status='pending' ORDER BY i."createdAt" DESC,i.id`,
            [organizationId]
          )
        : Promise.resolve({ rows: [] }),
    ])
    return Response.json(
      {
        members: members.rows,
        invitations: invitations.rows,
        canManage,
        currentUserId: access.userId,
        role: access.role,
        emailConfigured: invitationEmailConfigured(),
      },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    return authApiError(error)
  }
}
