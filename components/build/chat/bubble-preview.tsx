"use client"

import * as React from "react"
import { Monitor, Smartphone, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PublicChat } from "./public-chat"
import { BubbleLauncherIcon } from "./bubble-launcher-icon"
import { localizeBubble } from "@/src/lib/build/bubble-localization"
import { cn } from "@/lib/utils"
import type { ChatBubbleSettings } from "@/src/lib/build/chat-bubble"
import { bubbleStyle } from "./bubble-style"

export function BubblePreview({
  settings,
  agentId,
  channelId,
  onBeforeSend,
}: {
  settings: ChatBubbleSettings
  agentId: string
  channelId: string
  onBeforeSend: () => Promise<void>
}) {
  const localized = localizeBubble(
    settings,
    typeof navigator === "undefined" ? "en" : navigator.languages.join(",")
  )
  const [device, setDevice] = React.useState<"desktop" | "mobile">("desktop")
  const helpPage = settings.layout === "help_page"
  const [open, setOpen] = React.useState(true)
  return (
    <section
      aria-label={helpPage ? "Help Page preview" : "Chat Bubble preview"}
      className="flex min-h-[44rem] min-w-0 flex-col lg:min-h-0"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-5 py-3">
        <span className="text-sm font-medium">Preview</span>
        <div
          role="group"
          aria-label="Preview device"
          className="flex items-center gap-1"
        >
          <Button
            variant={device === "desktop" ? "secondary" : "ghost-muted"}
            size="icon-sm"
            aria-label="Desktop preview"
            aria-pressed={device === "desktop"}
            onClick={() => setDevice("desktop")}
          >
            <Monitor className="size-4" />
          </Button>
          <Button
            variant={device === "mobile" ? "secondary" : "ghost-muted"}
            size="icon-sm"
            aria-label="Mobile preview"
            aria-pressed={device === "mobile"}
            onClick={() => setDevice("mobile")}
          >
            <Smartphone className="size-4" />
          </Button>
        </div>
      </div>
      <div className="datool-chat-preview-canvas flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4 sm:p-6">
        {helpPage ? (
          <div
            className={cn(
              "flex h-full min-h-[38rem] w-full flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm lg:min-h-0",
              device === "mobile" ? "max-w-[390px]" : "max-w-[1400px]"
            )}
          >
            <div
              className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-muted px-4"
              aria-hidden
            >
              <div className="flex gap-1.5">
                <span className="size-2 rounded-full bg-foreground-muted/40" />
                <span className="size-2 rounded-full bg-foreground-muted/40" />
                <span className="size-2 rounded-full bg-foreground-muted/40" />
              </div>
              <span className="min-w-0 truncate text-xs text-foreground-muted">
                {settings.helpPage.pageTitle}
              </span>
            </div>
            <div className="min-h-0 flex-1">
              <PublicChat
                channelId={channelId}
                previewAgentId={agentId}
                appearanceOverride={settings}
                onBeforeSend={onBeforeSend}
              />
            </div>
          </div>
        ) : (
          <div
            className={cn(
              "relative flex h-full max-h-[780px] min-h-[38rem] w-full flex-col justify-end lg:min-h-0",
              device === "mobile"
                ? "max-w-[390px] overflow-hidden rounded-3xl border border-border bg-background shadow-sm"
                : "max-w-[640px]"
            )}
          >
            <div
              className="datool-chat-surface datool-chat-preview flex min-h-0 flex-1 flex-col justify-end"
              data-theme={settings.theme}
              style={{
                ...bubbleStyle(settings),
                alignItems:
                  settings.position === "left" ? "flex-start" : "flex-end",
                paddingInline: `min(${settings.offsetX}px, 12%)`,
                paddingBottom: `min(${settings.offsetY}px, 12%)`,
                paddingTop: "16px",
              }}
            >
              <div
                data-bubble-window
                className={cn(
                  "mb-3 h-full max-h-[680px] min-h-64 w-full max-w-[400px] overflow-hidden border border-border bg-background shadow-xl",
                  !open && "hidden"
                )}
              >
                <PublicChat
                  channelId={channelId}
                  previewAgentId={agentId}
                  appearanceOverride={settings}
                  embedded
                  onBeforeSend={onBeforeSend}
                  onClose={() => setOpen(false)}
                />
              </div>
              <Button
                data-bubble-launcher
                aria-label={
                  open ? "Close preview bubble" : "Open preview bubble"
                }
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className="h-14 max-w-full shrink-0 gap-2 rounded-full px-4 shadow-lg"
              >
                {open ? (
                  <X className="size-6" />
                ) : (
                  <BubbleLauncherIcon settings={settings} />
                )}
                {!open ? localized.appearance.launcherLabel || null : null}
              </Button>
            </div>
          </div>
        )}
      </div>
      <p className="shrink-0 border-t border-border bg-background px-4 py-3 text-center text-xs text-foreground-muted">
        Live preview · Uses the applied agent and can run its enabled actions.
      </p>
    </section>
  )
}
