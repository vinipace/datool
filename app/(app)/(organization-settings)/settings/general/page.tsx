import { OrganizationSettingsPage } from "@/components/workspace/organization-settings-page"
import { pageMetadata } from "@/lib/page-metadata"
import { requireActiveOrganization } from "@/lib/workspace-access"
import { db } from "@/lib/db"
import { memberRole } from "@/src/server/auth/config"

export const metadata = pageMetadata("organizationSettings")

export default async function Page() {
  const { organization, userId } =
    await requireActiveOrganization("/settings/general")
  const role = await memberRole(db, userId, organization.id)
  return (
    <OrganizationSettingsPage
      key={organization.id}
      embedded
      organization={organization}
      canManage={
        !!role
          ?.split(",")
          .some((value) => ["owner", "admin"].includes(value.trim()))
      }
    />
  )
}
