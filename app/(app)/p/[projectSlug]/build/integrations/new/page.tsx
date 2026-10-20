import { ChannelEditorPage } from "@/components/build/channels/channel-editor"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("newBuildChannel")

export default function NewChannelRoute() {
  return <ChannelEditorPage />
}
