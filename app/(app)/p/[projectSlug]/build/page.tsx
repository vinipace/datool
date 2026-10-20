import { BuildLandingPage } from "@/components/build/agents/agents-page"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("build")

export default function Page() {
  return <BuildLandingPage />
}
