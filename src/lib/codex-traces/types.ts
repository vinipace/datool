import type {
  CreateSpanInput,
  CreateTraceInput,
  JsonObject,
} from "../tracer/contracts"

/** The subset of the local App Server protocol used by this read-only connector. */
export type CodexItem = JsonObject & { id: string; type: string }
export type CodexTurn = {
  id: string
  items: CodexItem[]
  status: string
  startedAt: number | null
  completedAt: number | null
  durationMs: number | null
  error?: JsonObject | null
}
export type CodexThread = {
  id: string
  name?: string | null
  cwd: string
  model?: string | null
  modelProvider: string
  cliVersion: string
  createdAt: number
  parentThreadId?: string | null
  forkedFromId?: string | null
  turns: CodexTurn[]
  recordedItems?: { at: number; item: JsonObject }[]
  historyCoverage?: string
}

export type CapturedSpan = {
  traceId: string
  spanId: string
  parentSpanId: string
  name: string
  start: number
  end: number
  attributes: JsonObject
  events: { name: string; at: number; attributes: JsonObject }[]
  links: { traceId: string; spanId: string }[]
  error: boolean
}
export type CapturedLog = {
  id: string
  traceId: string
  spanId: string
  name: string
  at: number
  attributes: JsonObject
}
export type Telemetry = { spans: CapturedSpan[]; logs: CapturedLog[] }
export type CodexSnapshot = {
  version: 1
  capturedAt: string
  threadId: string
  turnId: string
  session: { name: string; attributes: JsonObject; createdAt: string }
  trace: Omit<CreateTraceInput, "spans"> & {
    name: string
    startedAt: string
    spans: (CreateSpanInput & { id: string; startedAt: string })[]
  }
}
