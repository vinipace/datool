"use client"

import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { DocsPage } from "fumadocs-ui/layouts/docs/page"

export default function DocumentationError({ reset }: { reset: () => void }) {
  return (
    <DocsPage>
      <Notice variant="error" title="Documentation could not load">
        Try loading this page again.
      </Notice>
      <Button variant="outline" onClick={reset}>
        Try again
      </Button>
    </DocsPage>
  )
}
