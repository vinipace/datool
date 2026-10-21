import { cache } from "react"
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { pageMetadata } from "@/lib/page-metadata"
import { PublicChat } from "@/components/build/chat/public-chat"
import {
  getPublicChatAppearance,
  publicConnectionContext,
} from "@/src/server/build/channels/service"

export const dynamic = "force-dynamic"

const readAppearance = cache(async (channelId: string) => {
  try {
    const context = await publicConnectionContext(channelId)
    return (await getPublicChatAppearance(context, channelId, null)).appearance
  } catch {
    // The chat handles paused, unavailable and unknown deployments uniformly.
    return undefined
  }
})

export async function generateMetadata({
  params,
}: {
  params: Promise<{ channelId: string }>
}): Promise<Metadata> {
  const appearance = await readAppearance((await params).channelId)
  if (appearance?.layout !== "help_page") return pageMetadata("publicChat")
  const { pageTitle, description, faviconUrl } = appearance.helpPage
  return {
    title: { absolute: pageTitle || appearance.displayName },
    description: description || undefined,
    ...(faviconUrl ? { icons: { icon: faviconUrl } } : {}),
  }
}

function parseContext(value?: string) {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value }
  } catch {
    return { value }
  }
}

export default async function PublicChatRoute({
  params,
  searchParams,
}: {
  params: Promise<{ channelId: string }>
  searchParams: Promise<{ embed?: string; context?: string; origin?: string }>
}) {
  const [{ channelId }, query] = await Promise.all([params, searchParams])
  const initialAppearance = await readAppearance(channelId)
  if (!initialAppearance) notFound()
  return (
    <PublicChat
      channelId={channelId}
      initialAppearance={initialAppearance}
      embedded={query.embed === "1"}
      context={parseContext(query.context)}
      embedOrigin={query.origin}
    />
  )
}
