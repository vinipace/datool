import { JsonCode } from "./json-code"
import type * as React from "react"
import { AlertCircle, CircleDashed, DatabaseZap, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { previewValue, statusLabel, stringifyJson } from "./format"

export { LoadingState } from "@/components/ui/loading-state"

const statusTones: Record<string, string> = {
  cancelled: "border-border bg-muted text-foreground-muted",
  completed: "border-success-border bg-success-background text-success",
  empty: "border-border bg-muted text-foreground-muted",
  error: "border-destructive-border bg-destructive-background text-destructive",
  errored: "border-destructive-border bg-destructive-background text-destructive",
  failed: "border-destructive-border bg-destructive-background text-destructive",
  ok: "border-success-border bg-success-background text-success",
  partial: "border-warning-border bg-warning-background text-warning",
  passed: "border-success-border bg-success-background text-success",
  running: "border-info-border bg-info-background text-info",
}

export function StatusPill({
  className,
  status,
}: {
  className?: string
  status: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
        statusTones[status] ??
          "border-border bg-muted text-foreground-muted",
        className
      )}
    >
      {status === "running" ? (
        <CircleDashed className="size-3 animate-spin" />
      ) : null}
      {statusLabel(status)}
    </span>
  )
}

export function EmptyState({
  action,
  detail,
  icon: Icon = DatabaseZap,
  title,
}: {
  action?: React.ReactNode
  detail: React.ReactNode
  icon?: React.ComponentType<{ className?: string }>
  title: string
}) {
  return (
    <div className="flex min-h-72 flex-col items-center justify-center px-6 py-10 text-center">
      <div className="mb-4 grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground">
        <Icon className="size-5" />
      </div>
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">
        {detail}
      </p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: Error
  onRetry?: () => void
}) {
  return (
    <div className="m-5 rounded-lg border border-destructive-border bg-destructive-background px-4 py-3 text-sm text-destructive">
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">This data could not be loaded.</p>
          <p className="mt-0.5 break-words text-destructive">
            {error.message}
          </p>
        </div>
        {onRetry ? (
          <Button
            className="shrink-0"
            onClick={onRetry}
            size="sm"
            variant="outline"
          >
            <RefreshCw className="size-3.5" />
            Retry
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function JsonPreview({
  className,
  value,
}: {
  className?: string
  value: unknown
}) {
  return (
    <pre
      className={cn(
        "max-h-60 overflow-auto rounded-lg border border-border/70 bg-muted/45 p-3 font-mono text-xs leading-5 text-foreground",
        className
      )}
    >
      {<JsonCode text={stringifyJson(value)} />}
    </pre>
  )
}

export function ValuePreview({ value }: { value: unknown }) {
  return (
    <span
      className="block truncate font-mono text-xs text-muted-foreground"
      title={previewValue(value, 1000)}
    >
      {<JsonCode text={previewValue(value)} />}
    </span>
  )
}
