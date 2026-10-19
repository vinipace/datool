import { pageMetadata } from "@/lib/page-metadata"
import { CampaignsPage } from "@/components/build/operations/campaigns-page"

export const metadata = pageMetadata("buildCampaigns")

export default async function BuildCampaignsRoute({ params }: { params: Promise<{ projectSlug: string }> }) {
  await params
  return <CampaignsPage />
}
