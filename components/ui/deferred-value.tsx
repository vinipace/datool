"use client"

import { Download } from "lucide-react"
import { Button } from "./button"

/** Render only a bounded preview. The caller fetches and mounts the editor on demand. */
export function DeferredValue({ label, preview, bytes, onLoad, loading = false, disabled = false, error }: {
  label: string
  preview: string
  bytes: number
  onLoad: () => void
  loading?: boolean
  disabled?: boolean
  error?: string
}) {
  const size = bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`
  return (
    <div className="relative isolate overflow-hidden rounded-lg border border-border bg-muted" aria-busy={loading}>
      <pre aria-hidden="true" className="pointer-events-none absolute inset-0 select-none overflow-hidden whitespace-pre-wrap break-all p-4 font-mono text-xs leading-6 text-foreground opacity-60 blur-[3px]">
        {preview}
      </pre>
      <div className="relative flex min-h-44 flex-col items-center justify-center gap-3 bg-background/40 px-4 py-6 text-center">
        <p className="text-sm text-foreground-muted">Large field · {size}</p>
        <Button variant="outline" size="sm" className="min-w-36" aria-label={`Load ${label}`} loading={loading} disabled={disabled} onClick={onLoad}>
          {!loading && <Download className="size-3.5" aria-hidden="true" />}
          {loading ? "Loading field…" : "Load field"}
        </Button>
        {error && <p role="alert" className="max-w-full break-words text-xs text-destructive">{error}</p>}
      </div>
    </div>
  )
}
