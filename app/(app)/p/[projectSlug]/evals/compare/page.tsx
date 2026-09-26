import { redirect } from "next/navigation"
import { evalComparisonUrl } from "@/src/lib/tracer/eval-comparison"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("evals")
export default async function Page({ params, searchParams }: { params: Promise<{ projectSlug: string }>; searchParams: Promise<{ left?: string; right?: string }> }) {
 const { projectSlug } = await params
 const { left, right } = await searchParams
 const prefix = `/p/${encodeURIComponent(projectSlug)}`
 redirect(prefix + (left ? evalComparisonUrl([left, ...(right ? [right] : [])]) : "/evals"))
}
