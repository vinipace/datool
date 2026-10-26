"use client"

import type { ReactNode } from "react"
import { ChatMessageAuthor } from "./chat-message-author"
import { cn } from "@/lib/utils"

/** Real message text stays visible while the rich transcript bundle loads. */
export function ChatTextTranscript({
  messages,
  pendingReply,
  renderMessageFooter,
}: {
  messages: Array<{
    id: string
    text: string
    outgoing: boolean
    author?: { name: string; image: string | null } | null
  }>
  renderMessageFooter?: (id: string) => ReactNode
  pendingReply?: ReactNode
}) {
  return (
    <div className="space-y-3">
      {messages
        .filter((message) => message.text)
        .map((message) => (
          <article
            key={message.id}
            data-chat-message=""
            aria-label={
              message.outgoing
                ? "Your message"
                : message.author
                  ? `${message.author.name} message`
                  : "Assistant message"
            }
            className={cn(
              "flex min-w-0 flex-col py-1",
              message.outgoing ? "items-end" : "items-start"
            )}
          >
            {!message.outgoing && message.author && (
              <ChatMessageAuthor {...message.author} />
            )}
            <div
              data-bubble-message=""
              data-bubble-user={message.outgoing ? "" : undefined}
              className={cn(
                "max-w-[min(85%,36rem)] rounded-2xl px-4 py-3 text-sm leading-6 [overflow-wrap:anywhere] whitespace-pre-wrap",
                message.outgoing
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-foreground"
              )}
            >
              {message.text}
            </div>
            {renderMessageFooter?.(message.id)}
          </article>
        ))}
      {pendingReply}
    </div>
  )
}
