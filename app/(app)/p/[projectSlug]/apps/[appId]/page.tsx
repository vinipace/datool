import { AppDetailPage } from "@/components/tracer/app-editor"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("appDetail")

export default async function Page({
  params,
}: {
  params: Promise<{ appId: string }>
}) {
  const { appId } = await params
  return <AppDetailPage key={appId} appId={appId} />
}
