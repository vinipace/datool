import { NextResponse } from "next/server"
import { accessError, apiError } from "@/lib/api-response"
import { requireProjectAccess } from "@/lib/project-access"
import { createTracerDatabase } from "@/src/server/tracer/db"
import { TracerError } from "@/src/server/tracer/errors"
import { listStorageConnections } from "@/src/server/build/storage/connections"
export const runtime = "nodejs"
type Context = { params: Promise<{ projectId: string }> }
async function handle(request: Request, context: Context) {
  try {
    const { projectId } = await context.params
    const authorization = await requireProjectAccess(request, projectId, {
      manage: request.method !== "GET",
    })
    if (authorization.kind !== "ok") return accessError(authorization.kind)
    const ctx = {
      database: createTracerDatabase(undefined, { projectId }),
      projectId,
      organizationId: authorization.access.project.organizationId,
      actorId: authorization.access.userId,
    }
    if (request.method !== "GET")
      return apiError(
        "FORBIDDEN",
        "Manage storage providers in organization settings.",
        403
      )
    return NextResponse.json(await listStorageConnections(ctx), {
      headers: { "Cache-Control": "no-store" },
    })
  } catch (error) {
    if (error instanceof TracerError)
      return apiError(
        error.code === "NOT_FOUND" ? "NOT_FOUND" : "VALIDATION_ERROR",
        error.message,
        error.status
      )
    return apiError(
      "INTERNAL_ERROR",
      "Unable to access storage. Check its endpoint, bucket, prefix and credentials, then retry.",
      500
    )
  }
}
export const GET = handle
export const PUT = handle
export const DELETE = handle
