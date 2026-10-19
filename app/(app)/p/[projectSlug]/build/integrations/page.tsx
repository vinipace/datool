import { pageMetadata } from "@/lib/page-metadata"
import { IntegrationsPage } from "@/components/build/operations/integrations-page"

export const metadata = pageMetadata("buildIntegrations")

export default async function BuildIntegrationsRoute({ params }: { params: Promise<{ projectSlug: string }> }) {
  await params
  return <IntegrationsPage />
}
