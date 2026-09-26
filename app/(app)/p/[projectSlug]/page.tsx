import { redirect } from "next/navigation"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("traces")
export default async function Page({ params }: { params: Promise<{ projectSlug: string }> }) {
 const { projectSlug } = await params
 redirect(`/p/${encodeURIComponent(projectSlug)}/traces`)
}
