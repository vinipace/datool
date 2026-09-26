import RootLayout from "@/app/(app)/layout"
import { MarketingShell } from "@/components/cms/marketing-shell"
import { notFound } from "next/navigation"
import { cmsEnabled } from "@/lib/cms/config"

export const dynamic = "force-dynamic"

export { metadata } from "@/app/(app)/layout"

export default function Layout({ children }: { children: React.ReactNode }) {
  if (!cmsEnabled()) notFound()
  return (
    <RootLayout>
      <MarketingShell>{children}</MarketingShell>
    </RootLayout>
  )
}
