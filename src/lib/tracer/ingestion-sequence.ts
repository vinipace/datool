import type { QueuedEvent } from "./queued-request.ts"

/** Preserve an unacknowledged event and retry it before sending any successor. */
export class IngestionSequence {
  private tail: Promise<void> = Promise.resolve()
  private readonly pending: QueuedEvent[] = []
  private pendingBytes = 0
  private readonly sizes = new Map<QueuedEvent, number>()
  previousId: string | null = null

  constructor(private readonly send: (event: QueuedEvent) => Promise<unknown>) {}

  private async deliverPending() {
    const event = this.pending[0]
    if (!event) return
    const result = await this.send(event)
    this.previousId = event.id
    this.pending.shift()
    this.pendingBytes -= this.sizes.get(event) ?? 0
    this.sizes.delete(event)
    return result
  }

  request<T>(input: Omit<QueuedEvent, "id" | "previousId">): Promise<T> {
    // Capture the payload at invocation time, including across an outage.
    const serialized = JSON.stringify(input)
    const bytes = Buffer.byteLength(serialized)
    if (this.pending.length >= 1000 || this.pendingBytes + bytes > 32 * 1024 * 1024) {
      return Promise.reject(new Error("Datool pending delivery buffer is full; flush retained events before sending more"))
    }
    const snapshot = JSON.parse(serialized) as typeof input
    const event = { ...snapshot, id: crypto.randomUUID(), previousId: this.pending.at(-1)?.id ?? this.previousId }
    this.pending.push(event)
    this.sizes.set(event, bytes)
    this.pendingBytes += bytes
    const result = this.tail.then(async () => {
      while (this.pending.length && this.pending[0] !== event) await this.deliverPending()
      if (!this.pending.length) throw new Error("Ingestion event was already drained")
      return await this.deliverPending() as T
    })
    this.tail = result.then(() => {}, () => {})
    return result
  }

  async flush(): Promise<void> {
    const boundary = this.pending.at(-1)
    const result = this.tail.then(async () => {
      while (boundary && this.pending.includes(boundary)) await this.deliverPending()
    })
    this.tail = result.then(() => {}, () => {})
    await result
  }
}
