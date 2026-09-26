import { NextResponse } from "next/server"

import { accessError, apiError, hasTrustedMutationOrigin, readJson } from "@/lib/api-response"
import { db } from "@/lib/db"
import { requireProjectAccess, type Project } from "@/lib/project-access"
import { MAX_PROJECT_REQUEST_BYTES, parseProjectUpdate } from "@/lib/project-records"

type Context = { params: Promise<{ projectId: string }> }

export async function GET(request: Request, context: Context) {
  const { projectId } = await context.params
  try {
    const authorization = await requireProjectAccess(request, projectId)
    if (authorization.kind !== "ok") return accessError(authorization.kind)
    return NextResponse.json({ project: authorization.access.project })
  } catch {
    return apiError("INTERNAL_ERROR", "Unable to load project.", 500)
  }
}

export async function PATCH(request: Request, context: Context) {
  if (!hasTrustedMutationOrigin(request)) {
    return apiError("FORBIDDEN", "Request origin is not trusted.", 403)
  }

  const { projectId } = await context.params
  const body = await readJson(request, MAX_PROJECT_REQUEST_BYTES)
  if (body.kind === "too-large") return apiError("PAYLOAD_TOO_LARGE", "Project request body is too large.", 413)
  const input = body.kind === "ok" ? parseProjectUpdate(body.value) : null
  if (!input) return apiError("VALIDATION_ERROR", "Provide a valid project name or slug.", 400)

  try {
    const authorization = await requireProjectAccess(request, projectId, { manage: true })
    if (authorization.kind !== "ok") return accessError(authorization.kind)

    const result = await db.query<Project>(
      `UPDATE project
          SET name = COALESCE($2, name),
              slug = COALESCE($3, slug),
              updated_at = NOW()
        WHERE id = $1
        RETURNING id,
                  organization_id AS "organizationId",
                  name,
                  slug,
                  created_at AS "createdAt",
                  updated_at AS "updatedAt"`,
      [projectId, input.name ?? null, input.slug ?? null],
    )
    return NextResponse.json({ project: result.rows[0] })
  } catch (error) {
    if (isUniqueViolation(error)) return apiError("CONFLICT", "A project with this slug already exists.", 409)
    return apiError("INTERNAL_ERROR", "Unable to update project.", 500)
  }
}

export async function DELETE(request: Request, context: Context) {
  if (!hasTrustedMutationOrigin(request)) {
    return apiError("FORBIDDEN", "Request origin is not trusted.", 403)
  }

  const { projectId } = await context.params
  try {
    const authorization = await requireProjectAccess(request, projectId, { manage: true })
    if (authorization.kind !== "ok") return accessError(authorization.kind)

    await db.query(`DELETE FROM project WHERE id = $1`, [projectId])
    return new NextResponse(null, { status: 204 })
  } catch {
    return apiError("INTERNAL_ERROR", "Unable to delete project.", 500)
  }
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505"
}
