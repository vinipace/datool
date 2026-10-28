import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/project-access"
import { z } from "zod"
import { apiError, assertTracerMutationOrigin, readJson } from "@/src/server/tracer/http"
import { TracerError } from "@/src/server/tracer/errors"
import { createTracerDatabase } from "@/src/server/tracer/db"
import { registerInboxDevice } from "@/src/server/build/mobile/devices"

export const dynamic = "force-dynamic"

async function sessionFor(request: Request) {
  const session = await getAuth().api.getSession({ headers: request.headers })
  if (!session) throw new TracerError("UNAUTHORIZED", "Sign in to manage notifications.")
  return session
}
export async function POST(request: Request) {
  try {
    assertTracerMutationOrigin(request)
    const session = await sessionFor(request)
    const projectId = z.string().min(1).max(200).parse(request.headers.get("x-project-id"))
    const access = await requireProjectAccess(request, projectId)
    if (access.kind !== "ok") throw new TracerError("UNAUTHORIZED", "You cannot subscribe to this project.", { status: access.kind === "payment-required" ? 402 : 403 })
    const data = await registerInboxDevice(createTracerDatabase(undefined, { projectId }), {
      projectId, userId: session.user.id, sessionId: session.session.id,
    }, await readJson(request, 4096))
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) { return apiError(error) }
}
export async function GET(request: Request) {
  try {
    const session = await sessionFor(request)
    const installationId = z.string().uuid().parse(new URL(request.url).searchParams.get("installationId"))
    const result = await db.query<{ projectId: string }>(
      'select project_id as "projectId" from inbox_mobile_devices where user_id=$1 and installation_id=$2 and session_id=$3',
      [session.user.id, installationId, session.session.id])
    return Response.json({ data: result.rows }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) { return apiError(error) }
}
export async function DELETE(request: Request) {
  try {
    assertTracerMutationOrigin(request)
    const session = await sessionFor(request)
    const input = z.object({ installationId: z.string().uuid(), projectId: z.string().min(1).max(200).optional() }).strict().parse(await readJson(request, 4096))
    // Global unsubscribe also works after membership is removed; it only deletes
    // this person's installation and is used before sign-out.
    await db.query('delete from inbox_mobile_devices where user_id=$1 and installation_id=$2 and ($3::text is null or project_id=$3)',
      [session.user.id, input.installationId, input.projectId ?? null])
    return Response.json({ data: { enabled: false } }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) { return apiError(error) }
}
