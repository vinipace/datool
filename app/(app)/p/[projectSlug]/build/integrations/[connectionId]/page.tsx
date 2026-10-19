import { ChannelEditorPage } from "@/components/build/channels/channel-editor"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("buildChannel")

export default async function ChannelRoute({
  params,
}: {
  params: Promise<{ connectionId: string }>
}) {
  const { connectionId } = await params
  return <ChannelEditorPage connectionId={connectionId} />
}
