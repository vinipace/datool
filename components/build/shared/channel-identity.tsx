import type { ChannelPresentationId } from "./channel-catalog"
import { cn } from "@/lib/utils"
import { channelCatalog, channelLabel } from "./channel-catalog"

export function ChannelIcon({
  channel,
  className,
  size = "default",
}: {
  channel: ChannelPresentationId
  className?: string
  size?: "default" | "sm"
}) {
  const { icon: Icon, tone } = channelCatalog[channel]
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        size === "sm" ? "size-6 rounded-md" : "size-10 rounded-xl",
        tone,
        className
      )}
    >
      <Icon className={size === "sm" ? "size-3.5" : "size-5"} />
    </span>
  )
}

export function ChannelIdentity({
  channel,
  className,
}: {
  channel: ChannelPresentationId
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-2.5 text-sm font-medium",
        className
      )}
    >
      <ChannelIcon channel={channel} />
      <span>{channelLabel(channel)}</span>
    </span>
  )
}
