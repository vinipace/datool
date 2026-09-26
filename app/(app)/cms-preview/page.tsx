import { headers } from "next/headers"
import { notFound, redirect } from "next/navigation"
import { getCMS } from "@/lib/cms/client"
import { cmsEnabled } from "@/lib/cms/config"
import { isEditor } from "@/cms/access"
import { LivePreview } from "@/components/cms/live-preview"

export const metadata = {
  title: "Content preview",
  robots: { index: false, follow: false },
}
export const dynamic = "force-dynamic"
export default async function Preview({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>
}) {
  if (!cmsEnabled()) notFound()
  const cms = await getCMS()
  const { user } = await cms.auth({ headers: await headers() })
  if (!isEditor(user)) redirect("/cms/login")
  const { type } = await searchParams
  if (
    type !== "pages" &&
    type !== "landing-page" &&
    type !== "faq-page" &&
    type !== "faqs"
  )
    notFound()
  return (
    <LivePreview
      type={type}
      serverURL={new URL(process.env.BETTER_AUTH_URL!).origin}
    />
  )
}
