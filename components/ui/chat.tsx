"use client"

import * as React from "react"
import { MessageCircle } from "lucide-react"
import type { InspectorMessage } from "@/src/lib/tracer/value-messages"
import { cn } from "@/lib/utils"
import { ChatComposer } from "./chat-composer"
export { ChatComposer, ChatTypingIndicator } from "./chat-composer"
import { MessageTranscript } from "./message-transcript"
import { LoadingState } from "./loading-state"
import { ChatFeedback, type ChatFeedbackProps } from "./chat-feedback"

/** Conversation and composer share the enclosing form's submit behavior. */
export function Chat({
  messages,
  perspective = "customer",
  variant = "default",
  text,
  onTextChange,
  running,
  canSubmit,
  placeholder = "Send a message…",
  composerToolbar,
  composerDisabled = false,
  composerFooter,
  feedback,
  loading = false,
  transcriptNotice,
  renderMessageFooter,
  onWidgetInteraction,
  onCodeStatus,
  onSubmit,
}: {
  variant?: "default" | "inbox"
  messages: InspectorMessage[]
  perspective?: React.ComponentProps<typeof MessageTranscript>["perspective"]
  text: string
  onTextChange: (text: string) => void
  running: boolean
  canSubmit: boolean
  placeholder?: string
  composerToolbar?: React.ReactNode
  composerDisabled?: boolean
  composerFooter?: React.ReactNode
  feedback?: ChatFeedbackProps
  loading?: boolean
  transcriptNotice?: React.ReactNode
  renderMessageFooter?: React.ComponentProps<
    typeof MessageTranscript
  >["renderMessageFooter"]
  onWidgetInteraction?: React.ComponentProps<
    typeof MessageTranscript
  >["onWidgetInteraction"]
  onCodeStatus?: (error: string | null) => void
  onSubmit?: React.FormEventHandler<HTMLFormElement>
}) {
  const scroll = React.useRef<HTMLDivElement>(null)
  const follow = React.useRef(true)
  React.useEffect(() => {
    if (scroll.current && follow.current)
      scroll.current.scrollTop = scroll.current.scrollHeight
  }, [messages, running])
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col",
        variant === "inbox" && "bg-muted/20"
      )}
    >
      <div
        ref={scroll}
        role="log"
        tabIndex={0}
        aria-label="Conversation"
        aria-live="polite"
        aria-busy={running || loading}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          variant === "inbox" && "flex flex-col px-4 py-5 sm:px-6"
        )}
        onScroll={(event) => {
          const element = event.currentTarget
          follow.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 64
        }}
      >
        {transcriptNotice}
        {loading && !messages.length ? (
          <LoadingState compact label="Loading messages…" />
        ) : messages.length ? (
          <div
            className={
              variant === "inbox"
                ? "mx-auto w-full max-w-3xl shrink-0"
                : undefined
            }
          >
            <MessageTranscript
              messages={messages}
              variant={variant === "inbox" ? "inbox" : "chat"}
              perspective={perspective}
              onWidgetInteraction={onWidgetInteraction}
              onCodeStatus={onCodeStatus}
              renderMessageFooter={renderMessageFooter}
            />
          </div>
        ) : transcriptNotice ? null : (
          <div className="flex h-full min-h-24 flex-col items-center justify-center gap-2 text-center text-sm text-foreground-muted">
            <MessageCircle aria-hidden="true" className="size-6" />
            <p>Start a conversation</p>
          </div>
        )}
        {running && <LoadingState compact label="Waiting for the agent…" />}
      </div>
      <div
        className={cn(
          "shrink-0 px-3 pt-2 pb-4",
          variant === "inbox" &&
            "mx-auto w-full max-w-3xl px-4 pt-3 pb-4 sm:px-6"
        )}
      >
        {composerToolbar}
        {onSubmit ? (
          <form onSubmit={onSubmit}>
            <ChatComposer
              variant={variant === "inbox" ? "inbox" : "default"}
              text={text}
              onTextChange={onTextChange}
              running={running}
              canSubmit={canSubmit}
              disabled={composerDisabled}
              placeholder={placeholder}
            />
          </form>
        ) : (
          <ChatComposer
            variant={variant === "inbox" ? "inbox" : "default"}
            text={text}
            onTextChange={onTextChange}
            running={running}
            canSubmit={canSubmit}
            disabled={composerDisabled}
            placeholder={placeholder}
          />
        )}
        {feedback && (
          <div className="mt-2 flex justify-end">
            <ChatFeedback {...feedback} />
          </div>
        )}
        {composerFooter}
      </div>
    </div>
  )
}
