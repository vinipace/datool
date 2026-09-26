import type { Pool } from "pg"

/** An explicit organization invitation admits its verified Google recipient even
 * on a domain-restricted installation. Removed members lose this exception. */
export async function hasInvitationSignInAccess(
  database: Pool,
  user: { email?: string | null; emailVerified?: boolean }
) {
  if (!user.email || user.emailVerified !== true) return false
  const result = await database.query(
    `SELECT 1 FROM invitation i WHERE lower(i.email)=$1 AND (
    (i.status='pending' AND i."expiresAt">now() AND EXISTS (
      SELECT 1 FROM member m WHERE m."organizationId"=i."organizationId" AND m."userId"=i."inviterId"))
    OR (i.status='accepted' AND EXISTS (
      SELECT 1 FROM member m JOIN "user" u ON u.id=m."userId"
      WHERE m."organizationId"=i."organizationId" AND lower(u.email)=$1))
    ) LIMIT 1`,
    [user.email.toLowerCase()]
  )
  return !!result.rowCount
}
