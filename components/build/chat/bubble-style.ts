import type { CSSProperties } from "react"
import type { ChatBubbleSettings } from "@/src/lib/build/chat-bubble"

export const bubbleFonts = {
  system:
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  inter: "Inter, system-ui, sans-serif",
  serif: 'Georgia, "Times New Roman", serif',
}
export const bubbleRadii = { square: 0, small: 8, medium: 16, large: 24 }

/** Validated customer branding, intentionally independent of the dashboard theme. */
export function bubbleStyle(settings: ChatBubbleSettings): CSSProperties {
  const contrast = (color: string) => {
    const rgb = color
      .slice(1)
      .match(/.{2}/g)!
      .map((value) => parseInt(value, 16))
    const luminance = rgb.reduce(
      (sum, value, index) => sum + value * [0.299, 0.587, 0.114][index]!,
      0
    )
    return luminance > 150
      ? "var(--bubble-dark-ink)"
      : "var(--bubble-light-ink)"
  }
  return {
    "--bubble-accent": settings.primaryColor,
    "--bubble-accent-text": contrast(settings.primaryColor),
    "--bubble-launcher-color": settings.launcherColor ?? settings.primaryColor,
    "--bubble-launcher-text": contrast(
      settings.launcherColor ?? settings.primaryColor
    ),
    "--bubble-radius": `${bubbleRadii[settings.radius]}px`,
    "--bubble-font": bubbleFonts[settings.fontFamily],
    "--bubble-font-size": `${settings.fontSize}px`,
    fontFamily: bubbleFonts[settings.fontFamily],
    fontSize: `${settings.fontSize}px`,
  } as CSSProperties
}
