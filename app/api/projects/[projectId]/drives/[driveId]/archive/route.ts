import { z } from "zod"
import { Readable } from "node:stream"
import {
  accessError,
  apiError,
  hasTrustedMutationOrigin,
} from "@/lib/api-response"
import { requireProjectAccess } from "@/lib/project-access"
import { createTracerDatabase } from "@/src/server/tracer/db"
import { TracerError } from "@/src/server/tracer/errors"
import {
  exportCloudDrive,
  importCloudDrive,
} from "@/src/server/build/storage/files"
import { boundedBytes } from "@/src/server/build/storage/objects"
import { maxArchiveBytes } from "@/src/server/build/storage/archive"
export const runtime = "nodejs"
export const maxDuration = 300
type Context = { params: Promise<{ projectId: string; driveId: string }> }
async function handle(request: Request, context: Context) {
  if (request.method !== "GET" && !hasTrustedMutationOrigin(request))
    return apiError("FORBIDDEN", "Request origin is not trusted.", 403)
  try {
    const { projectId, driveId } = await context.params
    const authorization = await requireProjectAccess(request, projectId, {
      manage: request.method !== "GET",
    })
    if (authorization.kind !== "ok") return accessError(authorization.kind)
    z.uuid().parse(driveId)
    const ctx = {
      database: createTracerDatabase(undefined, { projectId }),
      projectId,
      organizationId: authorization.access.project.organizationId,
    }
    if (request.method === "GET") {
      const revision = z
        .uuid()
        .optional()
        .parse(new URL(request.url).searchParams.get("revision") ?? undefined)
      const bytes = await exportCloudDrive(ctx, driveId, revision)
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/x-tar",
          "Content-Disposition": `attachment; filename="drive-${driveId}.tar"`,
        },
      })
    }
    const expected = request.headers.get("If-Match")
    if (!expected)
      return apiError(
        "VALIDATION_ERROR",
        "Send the current drive revision in If-Match (or empty for a new drive).",
        400
      )
    const revision = expected === "empty" ? null : z.uuid().parse(expected)
    if (
      !request.body ||
      Number(request.headers.get("Content-Length")) > maxArchiveBytes
    )
      return apiError(
        "PAYLOAD_TOO_LARGE",
        "Upload an uncompressed tar archive of at most 80 MiB.",
        413
      )
    const bytes = await boundedBytes(
      Readable.fromWeb(request.body as never),
      maxArchiveBytes
    )
    return Response.json(
      { revision: await importCloudDrive(ctx, driveId, bytes, revision) },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    if (error instanceof TracerError)
      return apiError(
        error.code === "NOT_FOUND" ? "NOT_FOUND" : "VALIDATION_ERROR",
        error.message,
        error.status
      )
    return apiError(
      "VALIDATION_ERROR",
      "Unable to transfer this drive. Check the archive limits, storage availability and current revision.",
      400
    )
  }
}
export const GET = handle
export const PUT = handle
