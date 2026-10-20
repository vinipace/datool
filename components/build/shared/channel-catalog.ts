import type { ComponentType, SVGProps } from "react"
import {
  Code2,
  Globe,
  Headset,
  Instagram,
  Mail,
  MessagesSquare,
  Slack,
} from "lucide-react"
import { TelegramLogo, WhatsAppLogo } from "@/components/ui/brand-icons"
import type { ChannelConnection, ChannelId } from "@/src/lib/build/channels"

/** Web presentations share delivery, sessions, safety and feedback. */
export type ChannelPresentationId = ChannelId | "help_page"

export function connectionPresentation(
  connection: ChannelConnection
): ChannelPresentationId {
  const bubble = connection.config.bubble as { layout?: string } | undefined
  return connection.channel === "web" && bubble?.layout === "help_page"
    ? "help_page"
    : connection.channel
}

/** One presentation registry for channel names, icons, colors and availability. */
export const channelCatalog: Record<
  ChannelPresentationId,
  {
    label: string
    description: string
    icon: ComponentType<SVGProps<SVGSVGElement>>
    tone: string
    available: boolean
  }
> = {
  web: {
    label: "Chat Bubble",
    description:
      "Embed a customizable chat bubble on your website to help visitors.",
    icon: MessagesSquare,
    tone: "text-channel-web bg-channel-web/10",
    available: true,
  },
  help_page: {
    label: "Help Page",
    description:
      "A full-page help center with your branding, useful links and live AI chat.",
    icon: Globe,
    tone: "text-channel-help-page bg-channel-help-page/10",
    available: true,
  },
  telegram: {
    label: "Telegram",
    description:
      "Help customers through your Telegram bot and escalate support cases to your inbox.",
    icon: TelegramLogo,
    tone: "text-channel-telegram bg-channel-telegram/10",
    available: true,
  },
  whatsapp: {
    label: "WhatsApp",
    description: "Customer conversations on WhatsApp.",
    icon: WhatsAppLogo,
    tone: "text-channel-whatsapp bg-channel-whatsapp/10",
    available: true,
  },
  messenger: {
    label: "Messenger",
    description: "Messages from your Facebook page.",
    icon: MessagesSquare,
    tone: "text-channel-messenger bg-channel-messenger/10",
    available: false,
  },
  instagram: {
    label: "Instagram",
    description: "Direct messages from your Instagram audience.",
    icon: Instagram,
    tone: "text-channel-instagram bg-channel-instagram/10",
    available: false,
  },
  email: {
    label: "Email",
    description: "Support through your customer email address.",
    icon: Mail,
    tone: "text-channel-email bg-channel-email/10",
    available: false,
  },
  slack: {
    label: "Slack",
    description: "Help your team inside Slack.",
    icon: Slack,
    tone: "text-channel-slack bg-channel-slack/10",
    available: false,
  },
  api: {
    label: "API",
    description: "Conversations in your own application.",
    icon: Code2,
    tone: "text-channel-api bg-channel-api/10",
    available: false,
  },
  helpdesk: {
    label: "Helpdesk",
    description: "Support conversations in your helpdesk.",
    icon: Headset,
    tone: "text-channel-helpdesk bg-channel-helpdesk/10",
    available: false,
  },
}

export function channelLabel(channel?: string) {
  return channel && channel in channelCatalog
    ? channelCatalog[channel as ChannelPresentationId].label
    : channel || "Channel"
}
