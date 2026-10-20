import { TeamsPage } from "@/components/workspace/teams-page"
import { requireActiveOrganization } from "@/lib/workspace-access"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("teams")
export default async function Page() {
  const { organization } = await requireActiveOrganization("/teams")
  return <TeamsPage key={organization.id} organization={organization} />
}
