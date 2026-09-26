import { NextResponse } from "next/server"

import {
  accessError,
  apiError,
  hasTrustedMutationOrigin,
  readJson,
} from "@/lib/api-response"
import { db } from "@/lib/db"
import { organizationHasBillingAccess } from "@/src/server/billing/store"
import { requireOrganizationRole, type Project } from "@/lib/project-access"
import {
  MAX_PROJECT_REQUEST_BYTES,
  parsePagination,
  parseProjectCreate,
} from "@/lib/project-records"

type Context = { params: Promise<{ organizationId: string }> }

export async function GET(request: Request, context: Context) {
  const { organizationId } = await context.params
  const searchParams = new URL(request.url).searchParams
  const pagination = parsePagination(searchParams)
  const search = (searchParams.get("q") ?? "").trim()
  const includeStats = searchParams.get("includeStats") === "true"
  if (!pagination)
    return apiError("VALIDATION_ERROR", "Invalid pagination parameters.", 400)
  if (search.length > 120)
    return apiError(
      "VALIDATION_ERROR",
      "Project search must be at most 120 characters.",
      400
    )

  try {
    const authorization = await requireOrganizationRole(request, organizationId)
    if (authorization.kind !== "ok") return accessError(authorization.kind)
    if (!await organizationHasBillingAccess(organizationId)) return accessError("payment-required")

    const [projectsResult, countResult] = await Promise.all([
      db.query<Project>(
        `SELECT id,
                organization_id AS "organizationId",
                name,
                slug,
                created_at AS "createdAt",
                updated_at AS "updatedAt"
                ${
                  includeStats
                    ? `,
                (SELECT COUNT(*)::int FROM traces WHERE project_id = project.id) AS "traceCount",
                (SELECT COUNT(*)::int FROM eval_runs WHERE project_id = project.id) AS "evalCount",
                (SELECT COUNT(*)::int FROM datasets WHERE project_id = project.id) AS "datasetCount"`
                    : ""
                }
           FROM project
          WHERE organization_id = $1
            AND ($4 = '' OR strpos(lower(name), lower($4)) > 0 OR strpos(lower(slug), lower($4)) > 0)
          ORDER BY created_at DESC, id DESC
          LIMIT $2 OFFSET $3`,
        [organizationId, pagination.pageSize, pagination.offset, search]
      ),
      db.query<{ total: string }>(
        `SELECT COUNT(*) AS total FROM project WHERE organization_id = $1
          AND ($2 = '' OR strpos(lower(name), lower($2)) > 0 OR strpos(lower(slug), lower($2)) > 0)`,
        [organizationId, search]
      ),
    ])

    return NextResponse.json({
      projects: projectsResult.rows,
      page: pagination.page,
      pageSize: pagination.pageSize,
      total: Number(countResult.rows[0]?.total ?? 0),
    })
  } catch {
    return apiError("INTERNAL_ERROR", "Unable to load projects.", 500)
  }
}

export async function POST(request: Request, context: Context) {
  if (!hasTrustedMutationOrigin(request)) {
    return apiError("FORBIDDEN", "Request origin is not trusted.", 403)
  }

  const { organizationId } = await context.params
  const body = await readJson(request, MAX_PROJECT_REQUEST_BYTES)
  if (body.kind === "too-large")
    return apiError(
      "PAYLOAD_TOO_LARGE",
      "Project request body is too large.",
      413
    )
  const input = body.kind === "ok" ? parseProjectCreate(body.value) : null
  if (!input)
    return apiError(
      "VALIDATION_ERROR",
      "A valid project name and slug are required.",
      400
    )

  try {
    const authorization = await requireOrganizationRole(
      request,
      organizationId,
      { manage: true }
    )
    if (authorization.kind !== "ok") return accessError(authorization.kind)
    if (!await organizationHasBillingAccess(organizationId)) return accessError("payment-required")

    const result = await db.query<Project>(
      `INSERT INTO project (id, organization_id, name, slug)
       VALUES ($1, $2, $3, $4)
       RETURNING id,
                 organization_id AS "organizationId",
                 name,
                 slug,
                 created_at AS "createdAt",
                 updated_at AS "updatedAt"`,
      [crypto.randomUUID(), organizationId, input.name, input.slug]
    )
    return NextResponse.json({ project: result.rows[0] }, { status: 201 })
  } catch (error) {
    if (isUniqueViolation(error))
      return apiError(
        "CONFLICT",
        "A project with this slug already exists.",
        409
      )
    return apiError("INTERNAL_ERROR", "Unable to create project.", 500)
  }
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  )
}
