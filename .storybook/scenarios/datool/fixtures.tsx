import type * as React from "react"
import type { Trace } from "@/components/ui/datool/trace-viewer"

export type DemoRow = {
  approved: boolean
  cost: number
  id: string
  metadata: { source: string; attempts: number }
  name: string
  startedAt: string
  status: "complete" | "pending" | "review"
}

export const demoRows: DemoRow[] = [
  {
    approved: true,
    cost: 0.18,
    id: "row-parser",
    metadata: { source: "upload", attempts: 1 },
    name: "Parse invoice",
    startedAt: "2026-09-10T14:30:00.000Z",
    status: "complete",
  },
  {
    approved: false,
    cost: 0.42,
    id: "row-classifier",
    metadata: { source: "api", attempts: 2 },
    name: "Classify supplier",
    startedAt: "2026-09-10T14:31:18.000Z",
    status: "review",
  },
  {
    approved: false,
    cost: 0.06,
    id: "row-export",
    metadata: { source: "schedule", attempts: 1 },
    name: "Export ledger",
    startedAt: "2026-09-10T14:33:02.000Z",
    status: "pending",
  },
]

const traceStart = 1_789_048_800

export const demoTrace: Trace = {
  resources: [
    {
      attributes: { "service.name": "datool-web", "service.version": "1.0.0" },
      name: "datool.web",
    },
    {
      attributes: { "service.name": "datool-worker" },
      name: "datool.worker",
    },
  ],
  rootSpanId: "trace-root",
  spans: [
    {
      attributes: { "http.method": "GET", "http.route": "/reports" },
      duration: [0, 900_000_000],
      endTime: [traceStart, 900_000_000],
      events: [
        {
          attributes: { cache: "miss" },
          name: "report.requested",
          timestamp: [traceStart, 100_000_000],
        },
      ],
      kind: 1,
      library: { name: "datool-web", version: "1.0.0" },
      links: [],
      name: "GET /reports",
      resource: "datool.web",
      spanId: "trace-root",
      startTime: [traceStart, 0],
      status: { code: 1 },
      traceFlags: 1,
    },
    {
      attributes: { document: "invoice-2026-09.pdf", tokens: 1842 },
      duration: [0, 320_000_000],
      endTime: [traceStart, 420_000_000],
      events: [
        {
          attributes: { pages: 2 },
          color: "var(--status-success)",
          name: "document.parsed",
          timestamp: [traceStart, 380_000_000],
        },
      ],
      kind: 1,
      library: { name: "invoice-parser" },
      links: [],
      name: "Parse invoice",
      parentSpanId: "trace-root",
      resource: "datool.worker",
      spanId: "trace-parse",
      startTime: [traceStart, 100_000_000],
      status: { code: 1 },
      traceFlags: 1,
    },
    {
      attributes: { provider: "ledger", retry: false },
      duration: [0, 210_000_000],
      endTime: [traceStart, 760_000_000],
      events: [],
      kind: 1,
      library: { name: "ledger-writer" },
      links: [],
      name: "Persist ledger entry",
      parentSpanId: "trace-root",
      resource: "datool.worker",
      spanId: "trace-persist",
      startTime: [traceStart, 550_000_000],
      status: { code: 1 },
      traceFlags: 1,
    },
  ],
  traceId: "trace_storybook_20260910",
}

export function StorySurface({ children }: React.PropsWithChildren) {
  return (
    <div className="w-[min(100%,72rem)] rounded-lg border border-border bg-background p-4">
      {children}
    </div>
  )
}

export function TraceSurface({ children }: React.PropsWithChildren) {
  return (
    <div className="h-[36rem] w-[min(100%,72rem)] overflow-hidden rounded-lg border border-border bg-background">
      {children}
    </div>
  )
}
