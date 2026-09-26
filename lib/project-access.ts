import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { organizationHasBillingAccess } from "@/src/server/billing/store"

export type ProjectRole = "owner" | "admin" | "member"

export type Project = {
  id: string
  organizationId: string
  name: string
  slug: string
  createdAt: Date
  updatedAt: Date
}

type ProjectAccessRow = Project & { role: string | null }

export type ProjectAccess = {
  project: Project
  role: ProjectRole
  userId: string
}

export type ProjectAccessResult =
  | { kind: "unauthenticated" }
  | { kind: "not-found" }
  | { kind: "payment-required" }
  | { kind: "forbidden" }
  | { kind: "ok"; access: ProjectAccess }

const MANAGER_ROLES = new Set<ProjectRole>(["owner", "admin"])

function toProject(row: ProjectAccessRow): Project {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    slug: row.slug,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  }
}

export function canManageProject(role: ProjectRole) {
  return MANAGER_ROLES.has(role)
}

/** Finds a project only when it belongs to the requested organization. */
export async function getProjectByOrganization(
  projectId: string,
  organizationId: string
): Promise<Project | null> {
  const result = await db.query<Project>(
    `SELECT id,
            organization_id AS "organizationId",
            name,
            slug,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
       FROM project
      WHERE id = $1 AND organization_id = $2
      LIMIT 1`,
    [projectId, organizationId]
  )

  return result.rows[0] ? toProject(result.rows[0] as ProjectAccessRow) : null
}

/** Finds a project by its URL slug inside one organization. */
export async function getProjectByOrganizationSlug(
  projectSlug: string,
  organizationId: string
): Promise<Project | null> {
  const result = await db.query<Project>(
    `SELECT id,
            organization_id AS "organizationId",
            name,
            slug,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
       FROM project
      WHERE slug = $1 AND organization_id = $2
      LIMIT 1`,
    [projectSlug, organizationId]
  )

  return result.rows[0] ? toProject(result.rows[0] as ProjectAccessRow) : null
}

/** Stable entry project after the caller has authorized the organization. */
export async function getOrganizationEntryProject(
  organizationId: string
): Promise<Project | null> {
  const result = await db.query<Project>(
    `SELECT id,
            organization_id AS "organizationId",
            name,
            slug,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
       FROM project
      WHERE organization_id = $1
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [organizationId]
  )
  return result.rows[0] ? toProject(result.rows[0] as ProjectAccessRow) : null
}

/**
 * Resolves both the session and membership for a project. The member lookup is
 * tied to the project's organization, so an active organization in a session
 * cannot authorize a project from a different tenant.
 */
export async function requireProjectAccess(
  request: Request,
  projectId: string,
  options: { manage?: boolean } = {}
): Promise<ProjectAccessResult> {
  const session = await getAuth().api.getSession({ headers: request.headers })
  const userId = session?.user?.id

  if (!userId) {
    return { kind: "unauthenticated" }
  }

  const result = await db.query<ProjectAccessRow>(
    `SELECT p.id,
            p.organization_id AS "organizationId",
            p.name,
            p.slug,
            p.created_at AS "createdAt",
            p.updated_at AS "updatedAt",
            m.role
       FROM project p
       LEFT JOIN member m
         ON m."organizationId" = p.organization_id
        AND m."userId" = $2
      WHERE p.id = $1
      LIMIT 1`,
    [projectId, userId]
  )
  const row = result.rows[0]

  if (!row) {
    return { kind: "not-found" }
  }

  const role = resolveProjectRole(row.role)
  if (!role) {
    return { kind: "forbidden" }
  }

  if (options.manage && !canManageProject(role)) {
    return { kind: "forbidden" }
  }

  if (!await organizationHasBillingAccess(row.organizationId)) return { kind: "payment-required" }

  return {
    kind: "ok",
    access: { project: toProject(row), role, userId },
  }
}

/** Gets a user session before organization-scoped operations such as creation. */
export async function requireOrganizationRole(
  request: Request,
  organizationId: string,
  options: { manage?: boolean } = {}
): Promise<
  | { kind: "unauthenticated" }
  | { kind: "forbidden" }
  | { kind: "ok"; userId: string; role: ProjectRole }
> {
  const session = await getAuth().api.getSession({ headers: request.headers })
  const userId = session?.user?.id

  if (!userId) {
    return { kind: "unauthenticated" }
  }

  const result = await db.query<{ role: string }>(
    `SELECT role
       FROM member
      WHERE "organizationId" = $1 AND "userId" = $2
      LIMIT 1`,
    [organizationId, userId]
  )
  const role = resolveProjectRole(result.rows[0]?.role ?? null)

  if (!role || (options.manage && !canManageProject(role))) {
    return { kind: "forbidden" }
  }

  return { kind: "ok", userId, role }
}

function resolveProjectRole(role: string | null): ProjectRole | null {
  if (!role) return null
  const roles = role.split(",").map((value) => value.trim())
  if (roles.includes("owner")) return "owner"
  if (roles.includes("admin")) return "admin"
  if (roles.includes("member")) return "member"
  return null
}
