import { NextResponse } from "next/server"

import { accessError, apiError, hasTrustedMutationOrigin, readJson } from "@/lib/api-response"
import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/project-access"
import {
  isRecordKind,
  MAX_RECORD_REQUEST_BYTES,
  newRecordId,
  parsePagination,
  parseRecordCreate,
  type ProjectRecord,
} from "@/lib/project-records"

type Context = { params: Promise<{ projectId: string }> }

export async function GET(request: Request, context: Context) {
  const { projectId } = await context.params
  const searchParams = new URL(request.url).searchParams
  const pagination = parsePagination(searchParams)
  const requestedKind = searchParams.get("kind")
  if (!pagination || (requestedKind !== null && !isRecordKind(requestedKind))) {
    return apiError("VALIDATION_ERROR", "Invalid record filter or pagination parameters.", 400)
  }

  try {
    const authorization = await requireProjectAccess(request, projectId)
    if (authorization.kind !== "ok") return accessError(authorization.kind)

    const values: unknown[] = [projectId]
    const kindClause = requestedKind ? ` AND kind = $2` : ""
    if (requestedKind) values.push(requestedKind)
    const pageSizeParameter = values.push(pagination.pageSize)
    const offsetParameter = values.push(pagination.offset)
    const [recordsResult, countResult] = await Promise.all([
      db.query<ProjectRecord>(
        `SELECT id,
                project_id AS "projectId",
                kind,
                name,
                data,
                created_at AS "createdAt",
                updated_at AS "updatedAt"
           FROM project_record
          WHERE project_id = $1${kindClause}
          ORDER BY created_at DESC, id DESC
          LIMIT $${pageSizeParameter} OFFSET $${offsetParameter}`,
        values,
      ),
      db.query<{ total: string }>(
        `SELECT COUNT(*) AS total FROM project_record WHERE project_id = $1${kindClause}`,
        requestedKind ? [projectId, requestedKind] : [projectId],
      ),
    ])
    return NextResponse.json({
      records: recordsResult.rows,
      page: pagination.page,
      pageSize: pagination.pageSize,
      total: Number(countResult.rows[0]?.total ?? 0),
    })
  } catch {
    return apiError("INTERNAL_ERROR", "Unable to load project records.", 500)
  }
}

export async function POST(request: Request, context: Context) {
  if (!hasTrustedMutationOrigin(request)) {
    return apiError("FORBIDDEN", "Request origin is not trusted.", 403)
  }

  const { projectId } = await context.params
  const body = await readJson(request, MAX_RECORD_REQUEST_BYTES)
  if (body.kind === "too-large") return apiError("PAYLOAD_TOO_LARGE", "Record request body is too large.", 413)
  const input = body.kind === "ok" ? parseRecordCreate(body.value) : null
  if (!input) return apiError("VALIDATION_ERROR", "Provide a valid record kind, name, and JSON data payload.", 400)

  try {
    const authorization = await requireProjectAccess(request, projectId)
    if (authorization.kind !== "ok") return accessError(authorization.kind)

    const result = await db.query<ProjectRecord>(
      `INSERT INTO project_record (id, project_id, kind, name, data)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id,
                 project_id AS "projectId",
                 kind,
                 name,
                 data,
                 created_at AS "createdAt",
                 updated_at AS "updatedAt"`,
      [newRecordId(), projectId, input.kind, input.name, input.dataJson],
    )
    return NextResponse.json({ record: result.rows[0] }, { status: 201 })
  } catch {
    return apiError("INTERNAL_ERROR", "Unable to create project record.", 500)
  }
}
