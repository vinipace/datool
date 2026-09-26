"use client"

import { MarketingShell } from "@/components/cms/marketing-shell"
import ErrorPage from "@/app/(marketing)/error"

export default function HomeError({ retry }: { retry: () => void }) {
  return (
    <MarketingShell>
      <ErrorPage retry={retry} />
    </MarketingShell>
  )
}
