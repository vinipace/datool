import type { IconName } from "../components/icons"
import colors from "../theme.generated.json"

export type ChannelBrand = "whatsapp" | "telegram" | "messenger" | "instagram" | "slack"
type ChannelIdentity = { label: string; icon: IconName; color: string; brand?: ChannelBrand }

const channels: Record<string, ChannelIdentity> = {
  web: { label: "Web chat", icon: "chats", color: colors.channelWeb },
  help_page: { label: "Help page", icon: "globe", color: colors.channelHelpPage },
  whatsapp: { label: "WhatsApp", icon: "chats", color: colors.channelWhatsapp, brand: "whatsapp" },
  telegram: { label: "Telegram", icon: "chats", color: colors.channelTelegram, brand: "telegram" },
  messenger: { label: "Messenger", icon: "chats", color: colors.channelMessenger, brand: "messenger" },
  instagram: { label: "Instagram", icon: "chats", color: colors.channelInstagram, brand: "instagram" },
  email: { label: "Email", icon: "mail", color: colors.channelEmail },
  slack: { label: "Slack", icon: "chats", color: colors.channelSlack, brand: "slack" },
  api: { label: "API", icon: "code", color: colors.channelApi },
  helpdesk: { label: "Helpdesk", icon: "headset", color: colors.channelHelpdesk },
}
export function channelIdentity(channel: string): ChannelIdentity {
  const key = channel.trim().toLowerCase()
  return Object.hasOwn(channels, key) ? channels[key]! : { label: channel.trim() || "Conversation", icon: "chats" as const, color: colors.muted }
}
export function channelLabel(channel: string) { return channelIdentity(channel).label }

