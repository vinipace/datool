import { NextResponse } from "next/server"

import { accessError, apiError, hasTrustedMutationOrigin, readJson } from "@/lib/api-response"
import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/project-access"
import { MAX_RECORD_REQUEST_BYTES, parseRecordUpdate, type ProjectRecord } from "@/lib/project-records"

type Context = { params: Promise<{ projectId: string; recordId: string }> }

export async function GET(request: Request, context: Context) {
  const { projectId, recordId } = await context.params
  try {
    const authorization = await requireProjectAccess(request, projectId)
    if (authorization.kind !== "ok") return accessError(authorization.kind)

    const record = await getScopedRecord(projectId, recordId)
    if (!record) return apiError("NOT_FOUND", "Resource not found.", 404)
    return NextResponse.json({ record })
  } catch {
    return apiError("INTERNAL_ERROR", "Unable to load project record.", 500)
  }
}

export async function PATCH(request: Request, context: Context) {
  if (!hasTrustedMutationOrigin(request)) {
    return apiError("FORBIDDEN", "Request origin is not trusted.", 403)
  }

  const { projectId, recordId } = await context.params
  const body = await readJson(request, MAX_RECORD_REQUEST_BYTES)
  if (body.kind === "too-large") return apiError("PAYLOAD_TOO_LARGE", "Record request body is too large.", 413)
  const input = body.kind === "ok" ? parseRecordUpdate(body.value) : null
  if (!input) return apiError("VALIDATION_ERROR", "Provide a valid record name or JSON data payload.", 400)

  try {
    const authorization = await requireProjectAccess(request, projectId)
    if (authorization.kind !== "ok") return accessError(authorization.kind)

    const result = await db.query<ProjectRecord>(
      `UPDATE project_record
          SET name = COALESCE($3, name),
              data = COALESCE($4::jsonb, data),
              updated_at = NOW()
        WHERE id = $1 AND project_id = $2
        RETURNING id,
                  project_id AS "projectId",
                  kind,
                  name,
                  data,
                  created_at AS "createdAt",
                  updated_at AS "updatedAt"`,
      [recordId, projectId, input.name ?? null, input.dataJson ?? null],
    )
    if (!result.rows[0]) return apiError("NOT_FOUND", "Resource not found.", 404)
    return NextResponse.json({ record: result.rows[0] })
  } catch {
    return apiError("INTERNAL_ERROR", "Unable to update project record.", 500)
  }
}

export async function DELETE(request: Request, context: Context) {
  if (!hasTrustedMutationOrigin(request)) {
    return apiError("FORBIDDEN", "Request origin is not trusted.", 403)
  }

  const { projectId, recordId } = await context.params
  try {
    const authorization = await requireProjectAccess(request, projectId)
    if (authorization.kind !== "ok") return accessError(authorization.kind)

    const result = await db.query(`DELETE FROM project_record WHERE id = $1 AND project_id = $2`, [recordId, projectId])
    if (result.rowCount === 0) return apiError("NOT_FOUND", "Resource not found.", 404)
    return new NextResponse(null, { status: 204 })
  } catch {
    return apiError("INTERNAL_ERROR", "Unable to delete project record.", 500)
  }
}

async function getScopedRecord(projectId: string, recordId: string): Promise<ProjectRecord | null> {
  const result = await db.query<ProjectRecord>(
    `SELECT id,
            project_id AS "projectId",
            kind,
            name,
            data,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
       FROM project_record
      WHERE id = $1 AND project_id = $2
      LIMIT 1`,
    [recordId, projectId],
  )
  return result.rows[0] ?? null
}
