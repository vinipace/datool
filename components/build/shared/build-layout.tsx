"use client"

import { Check, CircleAlert, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { cn } from "@/lib/utils"

export function BuildStatus({
  state,
  label,
  className,
}: {
  state:
    | "active"
    | "archived"
    | "draft"
    | "connected"
    | "paused"
    | "error"
    | "disconnected"
    | "pending"
    | "indexing"
    | "ready"
    | "deleted"
  label?: string
  className?: string
}) {
  const tone =
    state === "active" || state === "connected" || state === "ready"
      ? "text-success"
      : state === "error"
        ? "text-destructive"
        : state === "pending" || state === "indexing"
          ? "text-warning"
          : "text-foreground-muted"
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        tone,
        className
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full", tone.replace("text-", "bg-"))}
      />
      {label ?? state}
    </span>
  )
}

export function BuildSaveNotice({
  pending,
  dirty,
  error,
  saved,
}: {
  pending: boolean
  dirty: boolean
  error: string | null
  saved?: string | null
}) {
  if (error)
    return (
      <Notice role="alert" variant="error" layout="banner">
        {error}
      </Notice>
    )
  if (pending)
    return (
      <Notice role="status" variant="info" layout="banner">
        <span className="inline-flex items-center gap-2">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          Saving changes…
        </span>
      </Notice>
    )
  if (saved)
    return (
      <Notice role="status" variant="success" layout="banner">
        <span className="inline-flex items-center gap-2">
          <Check className="size-3.5" aria-hidden />
          {saved}
        </span>
      </Notice>
    )
  if (dirty)
    return (
      <Notice role="status" variant="warning" layout="banner">
        Unsaved changes
      </Notice>
    )
  return null
}

export function BuildErrorState({
  message,
  onRetry,
}: {
  message: string
  onRetry?: () => void
}) {
  return (
    <Notice role="alert" variant="error" className="m-4">
      <span className="inline-flex items-start gap-2">
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">{message}</span>
      </span>
      {onRetry ? (
        <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </Notice>
  )
}
