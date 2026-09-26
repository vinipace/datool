import { PlaygroundAppPage } from "@/components/tracer/playground-page"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("playgroundApp")

export default async function Page({
  params,
}: {
  params: Promise<{ appId: string }>
}) {
  const { appId } = await params
  return <PlaygroundAppPage key={appId} appId={appId} />
}
