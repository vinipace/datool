export type QueuedReply = {
  id: string; userId: string; projectId: string; ticketId: string; conversationId: string;
  text: string; createdAt: number; status: "queued" | "sending" | "blocked" | "submitted";
  attempts: number; nextAttemptAt: number; error?: string; reason?: string; serverMessageId?: string;
}
export class ReplyBlockedError extends Error {
  constructor(message: string, readonly reason: string) { super(message) }
}
type Storage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> }
type NewReply = Pick<QueuedReply, "id" | "userId" | "projectId" | "ticketId" | "conversationId" | "text">

/** Storage writes complete before the composer clears. Transport attempts keep
 * one immutable client ID across offline use, retries, and process restarts. */
export class DurableOutbox {
  private writes: Promise<unknown> = Promise.resolve()
  private running: Promise<void> | null = null
  private listeners = new Set<() => void>()
  constructor(private storage: Storage, private key: string) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private async read(): Promise<QueuedReply[]> {
    const raw = await this.storage.getItem(this.key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (parsed.version !== 1 || !Array.isArray(parsed.items) || parsed.items.some((item: QueuedReply) => !item || typeof item.id !== "string" || typeof item.userId !== "string" || typeof item.text !== "string" || !["queued", "sending", "blocked", "submitted"].includes(item.status))) throw new Error("Your saved outbox could not be read. It has been preserved on this device.")
    return parsed.items
  }
  async list(userId: string) { await this.writes; return (await this.read()).filter(item => item.userId === userId) }
  private update(change: (items: QueuedReply[]) => QueuedReply[]) {
    const next = this.writes.then(async () => {
      const items = change(await this.read())
      await this.storage.setItem(this.key, JSON.stringify({ version: 1, items }))
      for (const listener of this.listeners) listener()
    })
    this.writes = next.catch(() => undefined)
    return next
  }
  async enqueue(reply: NewReply) {
    if (!reply.text.trim()) throw new Error("Write a reply first.")
    await this.update(items => {
      const existing = items.find(item => item.id === reply.id && item.userId === reply.userId)
      if (existing) {
        if (existing.text !== reply.text || existing.conversationId !== reply.conversationId || existing.projectId !== reply.projectId) throw new Error("This reply ID is already in use.")
        return items
      }
      if (items.filter(item => item.status !== "submitted").length >= 500) throw new Error("Your outbox is full. Send or remove pending replies before adding more.")
      const keep = items.filter(item => item.status !== "submitted" || item.createdAt > Date.now() - 7 * 86400_000)
      return [...keep, { ...reply, status: "queued", createdAt: Date.now(), attempts: 0, nextAttemptAt: 0 }]
    })
  }
  retry(userId: string, id: string) {
    return this.update(items => items.map(item => item.userId === userId && item.id === id && item.status !== "submitted" && item.status !== "sending" ? { ...item, status: "queued", error: undefined, reason: undefined, nextAttemptAt: 0 } : item))
  }
  remove(userId: string, id: string) {
    return this.update(items => items.filter(item => item.userId !== userId || item.id !== id || item.status === "sending"))
  }
  async clearSubmitted(userId: string) {
    await this.update(items => items.filter(item => item.userId !== userId || item.status !== "submitted"))
  }
  drain(userId: string, send: (reply: QueuedReply) => Promise<{ messageId?: string }>, canSend: () => boolean) {
    if (this.running) return this.running
    this.running = this.run(userId, send, canSend).finally(() => { this.running = null })
    return this.running
  }
  private async run(userId: string, send: (reply: QueuedReply) => Promise<{ messageId?: string }>, canSend: () => boolean) {
    for (let count = 0; count < 50 && canSend(); count++) {
      const items = await this.list(userId)
      // Keep order inside each conversation; a failed first reply holds later
      // replies for that conversation without blocking other customers.
      const first = new Map<string, QueuedReply>()
      for (const item of items) if (item.status !== "submitted" && !first.has(item.projectId + ":" + item.conversationId)) first.set(item.projectId + ":" + item.conversationId, item)
      const reply = [...first.values()].find(item => item.status !== "blocked" && item.nextAttemptAt <= Date.now())
      if (!reply) return
      const attempts = reply.attempts + 1
      let claimed = false
      await this.update(items => items.map(item => {
        if (item.id !== reply.id || item.userId !== userId || item.status === "submitted" || item.status === "blocked") return item
        claimed = true
        return { ...item, status: "sending", attempts, error: undefined }
      }))
      // Removing a queued reply may win the race between selection and the
      // durable claim. Never send an item that was removed before that claim.
      if (!claimed) continue
      try {
        const result = await send(reply)
        await this.update(items => items.map(item => item.id === reply.id && item.userId === userId ? { ...item, status: "submitted", error: undefined, reason: undefined, serverMessageId: result.messageId } : item))
      } catch (error) {
        const blocked = error instanceof ReplyBlockedError
        await this.update(items => items.map(item => item.id === reply.id && item.userId === userId ? { ...item,
          status: blocked ? "blocked" : "queued", error: error instanceof Error ? error.message : "Could not send. Your reply is saved.",
          reason: blocked ? error.reason : undefined, nextAttemptAt: Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6)),
        } : item))
      }
    }
  }
}
