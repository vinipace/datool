import "../globals.css"
import { Document } from "@/app/document"
import { MarketingShell } from "@/components/cms/marketing-shell"
import { notFound } from "next/navigation"
import { cmsEnabled } from "@/lib/cms/config"

export const dynamic = "force-dynamic"

export { metadata } from "@/app/(app)/layout"

// The home page and agent landings are the light marketing pages; the rest of
// the site stays dark.
export default function Layout({ children }: { children: React.ReactNode }) {
  if (!cmsEnabled()) notFound()
  return (
    <Document theme="light">
      <MarketingShell>{children}</MarketingShell>
    </Document>
  )
}
