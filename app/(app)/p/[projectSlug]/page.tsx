import { ProjectHomePage } from "@/components/tracer/project-home-page"
import { pageMetadata } from "@/lib/page-metadata"
import { buildEnabled } from "@/lib/build/config"
import { requireActiveOrganization } from "@/lib/workspace-access"

export const metadata = pageMetadata("projectHome")
export default async function Page() {
  const { organization } = await requireActiveOrganization()
  return <ProjectHomePage buildEnabled={buildEnabled(organization.id)} />
}
