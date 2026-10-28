import { sql, type SQL } from "drizzle-orm"
import { buildEnabled, buildOrganizationIds } from "@/lib/build/config"

/** Filter before LIMIT/locking so disabled tenants stay queued without starving others. */
export function enabledBuildProject(projectId: SQL): SQL {
  if (buildEnabled()) return sql`true`
  const organizations = buildOrganizationIds()
  if (!organizations.length) return sql`false`
  return sql`EXISTS (
    SELECT 1 FROM project AS build_enabled_project
    WHERE build_enabled_project.id = ${projectId}
      AND build_enabled_project.organization_id IN (${sql.join(
        organizations.map((id) => sql`${id}`),
        sql`, `
      )})
  )`
}
