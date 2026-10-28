import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { apiError } from "@/src/server/tracer/http"
import { TracerError } from "@/src/server/tracer/errors"
import { roleScopes } from "@/src/lib/auth/permissions"

export const dynamic = "force-dynamic"
export async function GET(request: Request) {
  try {
    const session = await getAuth().api.getSession({ headers: request.headers })
    if (!session) throw new TracerError("UNAUTHORIZED", "Sign in to open your inbox.")
    const cursor = new URL(request.url).searchParams.get("cursor") ?? ""
    if (cursor.length > 200) throw new TracerError("VALIDATION_ERROR", "Invalid project cursor.")
    const result = await db.query<{ id: string; name: string; organizationName: string; role: string }>(`
      select p.id,p.name,o.name as "organizationName",m.role from project p
      join organization o on o.id=p.organization_id
      join member m on m."organizationId"=p.organization_id and m."userId"=$1
      where p.id>$2 order by p.id limit 51`, [session.user.id, cursor])
    const rows = result.rows.slice(0, 50)
    return Response.json({ data: {
      items: rows.filter(row => roleScopes(row.role).includes("build:read"))
        .map(({ id, name, organizationName }) => ({ id, name, organizationName })),
      nextCursor: result.rows.length > 50 ? rows.at(-1)!.id : null,
    } }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) { return apiError(error) }
}
