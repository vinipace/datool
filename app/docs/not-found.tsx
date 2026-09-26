import Link from "next/link"
import { DocsPage, DocsTitle, DocsDescription } from "fumadocs-ui/page"
import { Button } from "@/components/ui/button"

export default function DocumentationNotFound() {
  return (
    <DocsPage>
      <DocsTitle>Page not found</DocsTitle>
      <DocsDescription>
        This documentation page may have moved. Search the docs or start from
        the overview.
      </DocsDescription>
      <Button asChild variant="outline">
        <Link href="/docs">Back to documentation</Link>
      </Button>
    </DocsPage>
  )
}
