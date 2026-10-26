"use client"

import { Button } from "./button"

export function ChatDeliveryStatus({
  label,
  retryLabel,
  disabled,
  onRetry,
}: {
  label: string
  retryLabel: string
  disabled: boolean
  onRetry: () => void
}) {
  return (
    <div className="flex items-center gap-1 px-2 text-xs text-destructive">
      <span role="status">{label}</span>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={onRetry}
      >
        {retryLabel}
      </Button>
    </div>
  )
}
