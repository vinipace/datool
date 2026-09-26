import { redirect } from "next/navigation"
import { memberRole } from "@/src/server/auth/config"
import { db } from "@/lib/db"

import { ProjectSetupPage } from "@/components/workspace/project-setup-page"
import { getOrganizationEntryProject } from "@/lib/project-access"
import { requireActiveOrganization } from "@/lib/workspace-access"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("projectSetup")

export default async function Page() {
  const { organization, userId } = await requireActiveOrganization("/projects")
  const project = await getOrganizationEntryProject(organization.id)
  if (project) redirect(`/p/${encodeURIComponent(project.slug)}/projects`)
  const role = await memberRole(db, userId, organization.id)
  return (
    <ProjectSetupPage
      organization={organization}
      canManage={
        !!role
          ?.split(",")
          .some((value) => ["owner", "admin"].includes(value.trim()))
      }
    />
  )
}
