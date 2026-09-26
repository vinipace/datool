import { AppEditor } from "@/components/tracer/app-editor"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("newApp")

export default function Page() {
  return <AppEditor />
}
