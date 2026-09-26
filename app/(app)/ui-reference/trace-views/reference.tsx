"use client"
import { useState } from "react"
import { ReactViewPreview } from "@/components/tracer/react-view-preview"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import type { TraceDetail } from "@/src/lib/tracer/contracts"

export function TraceViewDemo({
  code,
  trace,
}: {
  code: string
  trace: TraceDetail | null
}) {
  const [revision, setRevision] = useState(0)
  if (!trace)
    return (
      <main className="p-6">
        <Notice title="Local trace view demo">
          Place a recorded trace in the ignored artifacts/trace-view-demo.json
          file to inspect it here. This page exists only in development.
        </Notice>
      </main>
    )
  return (
    <main className="flex h-svh flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-3">
        <div>
          <h1 className="text-sm font-medium">
            Datool · Local trace view preview
          </h1>
          <p className="text-xs text-foreground-muted">
            Recorded diagnosis. Updates below exercise the view without running
            the workflow.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-foreground-muted" role="status">
            Update {revision}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRevision((n) => n + 1)}
          >
            Simulate trace update
          </Button>
        </div>
      </header>
      <ReactViewPreview
        code={code}
        dataMode="summary"
        trace={{
          ...trace,
          attributes: { ...trace.attributes, demoRevision: revision },
        }}
      />
    </main>
  )
}
