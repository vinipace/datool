import type { ChatBubbleSettings } from "@/src/lib/build/chat-bubble"
import { resolveBubbleLauncher } from "@/src/lib/build/bubble-localization"

export function BubbleLauncherIcon({
  settings,
  className = "size-6",
}: {
  settings: ChatBubbleSettings
  className?: string
}) {
  const launcher = resolveBubbleLauncher(settings)
  return launcher.iconUrl ? (
    <img
      src={launcher.iconUrl}
      alt=""
      referrerPolicy="no-referrer"
      className={`${className} object-contain`}
    />
  ) : (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d={launcher.iconPath} />
    </svg>
  )
}
