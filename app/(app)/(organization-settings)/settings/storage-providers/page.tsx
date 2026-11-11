import { StorageProviderSettings } from "@/components/workspace/storage-provider-settings"
import { pageMetadata } from "@/lib/page-metadata"
import { requireActiveOrganization } from "@/lib/workspace-access"
import { db } from "@/lib/db"
import { memberRole } from "@/src/server/auth/config"
export const metadata = pageMetadata("storageProviders")
export default async function Page() {
  const { organization, userId } = await requireActiveOrganization(
    "/settings/storage-providers"
  )
  const role = await memberRole(db, userId, organization.id)
  return (
    <StorageProviderSettings
      key={organization.id}
      organizationId={organization.id}
      canManage={
        !!role
          ?.split(",")
          .some((value) => ["owner", "admin"].includes(value.trim()))
      }
    />
  )
}
