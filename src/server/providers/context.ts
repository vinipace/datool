import { drizzle } from "drizzle-orm/node-postgres"
import { sql } from "drizzle-orm"
import { db } from "@/lib/db"
import * as schema from "@/src/server/tracer/schema"
import type { TracerDatabase } from "@/src/server/tracer/db"
import {
  assertBuildProject,
  type BuildContext,
} from "@/src/server/build/context"

export type OrganizationProviderContext = {
  database: TracerDatabase
  organizationId: string
}
export const organizationProviderContext = (
  organizationId: string
): OrganizationProviderContext => ({
  database: drizzle(db, { schema }),
  organizationId,
})
export async function projectProviderContext(
  projectId: string,
  database?: TracerDatabase
) {
  const connection = database ?? drizzle(db, { schema })
  return assertBuildProject({ database: connection, projectId })
}
export async function providerContext(
  context: BuildContext | OrganizationProviderContext
): Promise<OrganizationProviderContext> {
  if ("projectId" in context) return assertBuildProject(context)
  const found = await context.database.execute(
    sql`SELECT id FROM organization WHERE id=${context.organizationId}`
  )
  if (!found.rows.length) throw new Error("Organization is unavailable.")
  return context
}
export const organizationCredentialScope = (organizationId: string) =>
  `organization:${organizationId}`
