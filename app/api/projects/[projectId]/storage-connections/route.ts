import { NextResponse } from "next/server"
import { z } from "zod"
import {
  accessError,
  apiError,
  hasTrustedMutationOrigin,
  readJson,
} from "@/lib/api-response"
import { requireProjectAccess } from "@/lib/project-access"
import { createTracerDatabase } from "@/src/server/tracer/db"
import { TracerError } from "@/src/server/tracer/errors"
import { storageConnectionInputSchema } from "@/src/lib/build/storage"
import {
  listStorageConnections,
  saveStorageConnection,
  removeStorageConnection,
} from "@/src/server/build/storage/connections"
export const runtime = "nodejs"
type Context = { params: Promise<{ projectId: string }> }
async function handle(request: Request, context: Context) {
  if (request.method !== "GET" && !hasTrustedMutationOrigin(request))
    return apiError("FORBIDDEN", "Request origin is not trusted.", 403)
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
    if (request.method !== "GET") {
      const body = await readJson(request, 32768)
      if (body.kind === "too-large")
        return apiError(
          "PAYLOAD_TOO_LARGE",
          "Storage settings are too large.",
          413
        )
      if (request.method === "PUT")
        await saveStorageConnection(
          ctx,
          storageConnectionInputSchema.parse(
            body.kind === "ok" ? body.value : null
          )
        )
      else
        await removeStorageConnection(
          ctx,
          z
            .object({ id: z.uuid() })
            .strict()
            .parse(body.kind === "ok" ? body.value : null).id
        )
    }
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
    if (error instanceof z.ZodError)
      return apiError(
        "VALIDATION_ERROR",
        "Provide valid storage settings and credentials.",
        400
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
