"use client"

import { ThumbsDown, ThumbsUp } from "lucide-react"
import { Button } from "./button"

export type ChatFeedbackValue = "positive" | "negative"
export type ChatFeedbackProps = {
  value?: ChatFeedbackValue | null
  onChange: (value: ChatFeedbackValue) => void
  disabled?: boolean
  label?: string
  positiveLabel?: string
  negativeLabel?: string
  hideLabel?: boolean
}

export function ChatFeedback({
  value,
  onChange,
  disabled,
  label = "Rate response",
  positiveLabel = "Helpful",
  negativeLabel = "Not helpful",
  hideLabel = false,
}: ChatFeedbackProps) {
  return (
    <span
      data-slot="chat-feedback"
      className="flex items-center text-xs text-foreground-muted"
      role="group"
      aria-label={label}
    >
      <span className={hideLabel ? "sr-only" : "mr-1"}>{label}</span>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost-subtle"
        aria-label={positiveLabel}
        title={positiveLabel}
        aria-pressed={value === "positive"}
        className="group/feedback size-6 disabled:opacity-100"
        onClick={() => onChange("positive")}
        disabled={disabled}
      >
        <ThumbsUp
          className="size-3.5 group-aria-pressed/feedback:fill-current"
          aria-hidden
        />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost-subtle"
        aria-label={negativeLabel}
        title={negativeLabel}
        aria-pressed={value === "negative"}
        className="group/feedback size-6 disabled:opacity-100"
        onClick={() => onChange("negative")}
        disabled={disabled}
      >
        <ThumbsDown
          className="size-3.5 group-aria-pressed/feedback:fill-current"
          aria-hidden
        />
      </Button>
    </span>
  )
}
