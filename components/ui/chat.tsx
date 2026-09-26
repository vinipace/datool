"use client"

import * as React from "react"
import { ArrowUp, MessageCircle } from "lucide-react"
import type { InspectorMessage } from "@/src/lib/tracer/value-messages"
import { Button } from "./button"
import { Textarea } from "./textarea"
import { MessageTranscript } from "./message-transcript"
import { LoadingState } from "./loading-state"

/** Conversation and composer share the enclosing form's submit behavior. */
export function Chat({
  messages,
  text,
  onTextChange,
  running,
  canSubmit,
  placeholder = "Send a message…",
  composerToolbar,
}: {
  messages: InspectorMessage[]
  text: string
  onTextChange: (text: string) => void
  running: boolean
  canSubmit: boolean
  placeholder?: string
  composerToolbar?: React.ReactNode
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
        aria-busy={running}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onScroll={(event) => {
          const element = event.currentTarget
          follow.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 64
        }}
      >
        {messages.length ? (
          <MessageTranscript messages={messages} variant="chat" />
        ) : (
          <div className="flex h-full min-h-24 flex-col items-center justify-center gap-2 text-center text-sm text-foreground-muted">
            <MessageCircle aria-hidden="true" className="size-6" />
            <p>Start a conversation</p>
          </div>
        )}
        {running && <LoadingState compact label="Waiting for the agent…" />}
      </div>
      <div className="shrink-0 pt-2 pb-4">
        {composerToolbar}
        <div className="rounded-2xl border border-border bg-input-background p-3 focus-within:ring-2 focus-within:ring-ring">
          <Textarea
            aria-label="Message"
            placeholder={placeholder}
            variant="plain"
            autoSize
            rows={2}
            className="max-h-32 resize-none"
            value={text}
            readOnly={running}
            onChange={(event) => onTextChange(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault()
                if (canSubmit) event.currentTarget.form?.requestSubmit()
              }
            }}
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button
              type="submit"
              size="icon"
              shape="circle"
              aria-label="Send message"
              title="Send message"
              disabled={!canSubmit}
              loading={running}
            >
              {!running && <ArrowUp aria-hidden="true" className="size-4" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
