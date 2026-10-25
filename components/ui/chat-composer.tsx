"use client"

import * as React from "react"
import { ArrowUp } from "lucide-react"
import { Button } from "./button"
import { Textarea } from "./textarea"

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
