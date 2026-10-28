"use client"

import {
  ArrowLeft,
  BatteryFull,
  Phone,
  RefreshCw,
  Signal,
  Video,
  Wifi,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { PublicChat } from "@/components/build/chat/public-chat"
import { chatBubbleSettingsSchema } from "@/src/lib/build/chat-bubble"

export function WhatsAppPreview({
  name,
  phoneNumber,
  agentId,
  channelId,
}: {
  name: string
  phoneNumber?: string
  agentId: string
  channelId: string
}) {
  const appearance = chatBubbleSettingsSchema.parse({
    displayName: name,
    welcomeMessage: "",
    inputPlaceholder: "Message",
    showBranding: false,
    showFeedback: false,
    suggestedReplies: [],
  })
  return (
    <figure className="mx-auto w-full max-w-[340px] space-y-5">
      <div
        aria-label={`WhatsApp agent test with ${name}`}
        className="@container/phone mx-auto w-full max-w-[clamp(240px,calc((100dvh-18rem)*9/19.5),340px)] overflow-hidden rounded-[3rem] border-[6px] border-border bg-background p-1 shadow-2xl"
      >
        <div className="flex aspect-[9/19.5] min-h-0 flex-col overflow-hidden rounded-[2.5rem] bg-[var(--commerce-chat-canvas)] text-[var(--commerce-chat-text)]">
          <div className="shrink-0 bg-[var(--commerce-chat-header)]">
            <div
              aria-hidden="true"
              className="relative flex h-12 items-center justify-between px-6 text-xs font-semibold"
            >
              <span>9:41</span>
              <span className="absolute top-2 left-1/2 h-5 w-20 -translate-x-1/2 rounded-full bg-background" />
              <span className="flex items-center gap-1">
                <Signal className="size-3" />
                <Wifi className="size-3" />
                <BatteryFull className="size-4" />
              </span>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <PublicChat
              key={`${agentId}:${channelId}`}
              channelId={channelId}
              previewAgentId={agentId}
              appearanceOverride={appearance}
              variant="whatsapp"
              renderHeader={({ onNewChat, disabled }) => (
                <header className="flex shrink-0 items-center gap-2 bg-[var(--commerce-chat-header)] px-3 pb-3">
                  <ArrowLeft aria-hidden="true" className="size-5 shrink-0" />
                  <span
                    aria-hidden="true"
                    className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--commerce-chat-outgoing)] text-sm font-semibold"
                  >
                    {name.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{name}</p>
                    <p className="truncate text-[10px] text-[var(--commerce-chat-meta)]">
                      {phoneNumber || "Business account"}
                    </p>
                  </div>
                  <span
                    aria-hidden="true"
                    className="hidden items-center gap-3 @min-[300px]/phone:flex"
                  >
                    <Video className="size-4" />
                    <Phone className="size-4" />
                  </span>
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    aria-label="New test conversation"
                    title="New test conversation"
                    disabled={disabled}
                    onClick={onNewChat}
                  >
                    <RefreshCw className="size-4" />
                  </Button>
                </header>
              )}
            />
          </div>
          <div
            aria-hidden="true"
            className="flex shrink-0 justify-center pt-1 pb-2"
          >
            <span className="h-1 w-24 rounded-full bg-[var(--commerce-chat-meta)]" />
          </div>
        </div>
      </div>
      <figcaption className="text-center text-xs leading-5 text-foreground-muted">
        Live agent test · No WhatsApp messages sent
        <br />
        Uses the applied agent and can run its enabled actions.
      </figcaption>
    </figure>
  )
}
