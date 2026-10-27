import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { authBaseUrl } from "@/src/server/auth/config"
import { assertSameOrigin } from "@/src/server/auth/request"
import { authApiError } from "@/src/server/auth/errors"
import { saveProfile } from "@/src/server/auth/profile"
import { readJson } from "@/src/server/tracer/http"
import { accessError } from "@/lib/api-response"

export async function POST(request: Request) {
  try {
    assertSameOrigin(request)
    const session = await getAuth().api.getSession({ headers: request.headers })
    if (!session) return accessError("unauthenticated")
    const data = await saveProfile(
      db,
      session.user.id,
      await readJson(request, 7 * 1024 * 1024),
      authBaseUrl()
    )
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    return authApiError(error)
  }
}
