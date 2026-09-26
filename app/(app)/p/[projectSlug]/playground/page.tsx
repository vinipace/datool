import { PlaygroundPage } from "@/components/tracer/playground-page"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("playground")

export default function Page() {
  return <PlaygroundPage />
}
