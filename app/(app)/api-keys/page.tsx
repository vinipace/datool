import { requireActiveOrganization } from "@/lib/workspace-access"
import { ApiKeysPage } from "@/components/workspace/api-keys-page"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("apiKeys")

export default async function Page() {
  const { organization } = await requireActiveOrganization("/api-keys")
  return (
    <ApiKeysPage
      organizationId={organization.id}
      organizationName={organization.name}
    />
  )
}
