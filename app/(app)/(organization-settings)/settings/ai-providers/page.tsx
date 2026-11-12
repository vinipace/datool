import { ModelProviderSettings } from "@/components/workspace/model-provider-settings"
import { pageMetadata } from "@/lib/page-metadata"
import { requireActiveOrganization } from "@/lib/workspace-access"
import { db } from "@/lib/db"
import { memberRole } from "@/src/server/auth/config"
export const metadata = pageMetadata("aiProviders")
export default async function Page() {
  const { organization, userId } = await requireActiveOrganization(
    "/settings/ai-providers"
  )
  const role = await memberRole(db, userId, organization.id)
  return (
    <ModelProviderSettings
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
