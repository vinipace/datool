import { PromptDetailPage } from "@/components/tracer/prompts-page"
import { pageMetadata } from "@/lib/page-metadata"
export const metadata = pageMetadata("promptDetail")
export default async function Page({
  params,
}: {
  params: Promise<{ promptId: string }>
}) {
  const { promptId } = await params
  return <PromptDetailPage promptId={promptId} />
}
