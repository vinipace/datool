"use client"

import * as React from "react"
import { ArrowUp, MessageCircle } from "lucide-react"
import type { InspectorMessage } from "@/src/lib/tracer/value-messages"
import { Button } from "./button"
import { Textarea } from "./textarea"
import { MessageTranscript } from "./message-transcript"
import { LoadingState } from "./loading-state"
import { ChatFeedback, type ChatFeedbackProps } from "./chat-feedback"

/** Conversation and composer share the enclosing form's submit behavior. */
export function Chat({
  messages,
  perspective = "customer",
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
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scroll}
        role="log"
        tabIndex={0}
        aria-label="Conversation"
        aria-live="polite"
        aria-busy={running || loading}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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
          <MessageTranscript
            messages={messages}
            variant="chat"
            perspective={perspective}
            onWidgetInteraction={onWidgetInteraction}
            onCodeStatus={onCodeStatus}
            renderMessageFooter={renderMessageFooter}
          />
        ) : transcriptNotice ? null : (
          <div className="flex h-full min-h-24 flex-col items-center justify-center gap-2 text-center text-sm text-foreground-muted">
            <MessageCircle aria-hidden="true" className="size-6" />
            <p>Start a conversation</p>
          </div>
        )}
        {running && <LoadingState compact label="Waiting for the agent…" />}
      </div>
      <div className="shrink-0 px-3 pt-2 pb-4">
        {composerToolbar}
        {onSubmit ? (
          <form onSubmit={onSubmit}>
            <ChatComposer
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

/** May live inside a page's existing form or Chat's own composer form. */
export function ChatTypingIndicator({ label }: { label: string }) {
  return (
    <div
      className="flex items-center gap-1.5 rounded-full bg-muted px-4 py-3 text-foreground-muted"
      role="status"
    >
      <span className="sr-only">{label}</span>
      <span
        data-bubble-typing-dot
        aria-hidden
        className="size-1.5 rounded-full bg-current"
      />
      <span
        data-bubble-typing-dot
        aria-hidden
        className="size-1.5 rounded-full bg-current"
      />
      <span
        data-bubble-typing-dot
        aria-hidden
        className="size-1.5 rounded-full bg-current"
      />
    </div>
  )
}

export function ChatComposer({
  text,
  onTextChange,
  running,
  canSubmit,
  disabled,
  placeholder,
  messageLabel = "Message",
  sendLabel = "Send message",
  variant = "default",
  accentSend,
  maxLength,
}: {
  text: string
  onTextChange: (text: string) => void
  running: boolean
  canSubmit: boolean
  disabled?: boolean
  placeholder?: string
  messageLabel?: string
  sendLabel?: string
  variant?: "default" | "customer" | "help-page"
  accentSend?: boolean
  maxLength?: number
}) {
  return (
    <div
      data-bubble-composer={variant !== "default" ? "" : undefined}
      className={
        variant === "help-page"
          ? "rounded-2xl border border-border bg-background p-4 shadow-sm focus-within:ring-2 focus-within:ring-ring"
          : variant === "customer"
            ? "flex items-end gap-2 border border-border bg-input-background px-3 py-1.5 focus-within:ring-2 focus-within:ring-ring"
            : "rounded-2xl border border-border bg-input-background p-3 focus-within:ring-2 focus-within:ring-ring"
      }
    >
      <Textarea
        aria-label={messageLabel}
        placeholder={placeholder}
        variant="plain"
        autoSize
        rows={variant === "customer" ? 1 : 2}
        className={
          variant === "customer"
            ? "max-h-32 min-h-6 flex-1 resize-none self-center leading-6"
            : "max-h-32 min-h-8 flex-1 resize-none"
        }
        value={text}
        readOnly={running}
        disabled={disabled}
        maxLength={maxLength}
        onChange={(event) => onTextChange(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault()
            if (canSubmit && !running && !disabled)
              event.currentTarget.form?.requestSubmit()
          }
        }}
      />
      <div
        className={
          variant === "customer"
            ? "shrink-0"
            : "mt-2 flex items-center justify-end gap-2"
        }
      >
        <Button
          type="submit"
          size={variant === "customer" ? "icon-sm" : "icon"}
          shape="circle"
          aria-label={sendLabel}
          title={sendLabel}
          disabled={!canSubmit || running || disabled}
          loading={running}
          className={
            variant !== "default" && !disabled
              ? "disabled:opacity-100"
              : undefined
          }
          data-bubble-send={accentSend ? "accent" : undefined}
        >
          {!running && <ArrowUp aria-hidden="true" className="size-4" />}
        </Button>
      </div>
    </div>
  )
}
