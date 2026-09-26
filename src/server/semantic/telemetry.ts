import { createHash } from "node:crypto"
import { channel } from "node:diagnostics_channel"

/** Optional subscribers receive bounded measurements, never SQL values or payloads. */
export const readTelemetry = channel("datool.read.statement")
export function readMeasurement(input: {
  project: string
  fingerprint: string
  elapsedMs: number
  rows: number
  bytes: number
  outcome: "ok" | "error"
}) {
  if (!readTelemetry.hasSubscribers) return
  const { project, ...measurement } = input
  readTelemetry.publish({
    ...measurement,
    projectHash: createHash("sha256")
      .update(project)
      .digest("hex")
      .slice(0, 16),
  })
}
