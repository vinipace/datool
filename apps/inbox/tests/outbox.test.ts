import { expect, test } from "bun:test"
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DurableOutbox, ReplyBlockedError, type QueuedReply } from "../src/lib/outbox-core"

async function storage() {
  const path = await mkdtemp(join(tmpdir(), "datool-outbox-"))
  return {
    async getItem(key: string) { return readFile(join(path, key), "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error }) },
    async setItem(key: string, value: string) { await writeFile(join(path, key + ".tmp"), value); await rename(join(path, key + ".tmp"), join(path, key)) },
    close: () => rm(path, { recursive: true, force: true }),
  }
}
const reply = (id: string, conversationId = "conversation", userId = "operator") => ({ id, conversationId, userId, projectId: "project", ticketId: "ticket", text: `Reply ${id}` })

test("offline replies persist across process recreation and ambiguous retries reuse the original message ID", async () => {
  const disk = await storage()
  try {
    const first = new DurableOutbox(disk, "queue")
    await first.enqueue(reply("one"))
    const reloaded = new DurableOutbox(disk, "queue")
    expect((await reloaded.list("operator"))[0]!.text).toBe("Reply one")
    const attempts: string[] = []
    const transport = async (item: QueuedReply) => {
      attempts.push(item.id)
      if (attempts.length === 1) throw new Error("Response lost after server accepted the reply")
      return { messageId: "server-message" }
    }
    await reloaded.drain("operator", transport, () => false)
    expect(attempts).toHaveLength(0)
    await reloaded.drain("operator", transport, () => true)
    expect((await reloaded.list("operator"))[0]!.status).toBe("queued")
    const restarted = new DurableOutbox(disk, "queue")
    await restarted.retry("operator", "one")
    await restarted.drain("operator", transport, () => true)
    expect(attempts).toEqual(["one", "one"])
    expect((await restarted.list("operator"))[0]!.status).toBe("submitted")
  } finally { await disk.close() }
})

test("a blocked conversation preserves reply order without stopping other conversations or leaking another account's queue", async () => {
  const disk = await storage()
  try {
    const queue = new DurableOutbox(disk, "queue")
    await Promise.all([queue.enqueue(reply("one")), queue.enqueue(reply("two")), queue.enqueue(reply("three", "different")), queue.enqueue(reply("private", "different", "other-user"))])
    const sent: string[] = []
    await Promise.all([queue.drain("operator", async item => { if (item.id === "one") throw new ReplyBlockedError("Another teammate owns this conversation", "ownership"); sent.push(item.id); return {} }, () => true), queue.drain("operator", async () => { throw new Error("Concurrent drain must not run") }, () => true)])
    expect(sent).toEqual(["three"])
    expect((await queue.list("operator")).find(item => item.id === "two")!.status).toBe("queued")
    expect((await queue.list("other-user"))[0]!.status).toBe("queued")
    await queue.retry("operator", "one")
    await queue.drain("operator", async item => { sent.push(item.id); return {} }, () => true)
    expect(sent).toEqual(["three", "one", "two"])
  } finally { await disk.close() }
})

test("storage failures reject enqueue and corrupted outboxes are preserved instead of silently erased", async () => {
  const failed = new DurableOutbox({ getItem: async () => null, setItem: async () => { throw new Error("Disk full") } }, "queue")
  await expect(failed.enqueue(reply("one"))).rejects.toThrow("Disk full")
  const disk = await storage()
  try {
    await disk.setItem("queue", "corrupted saved data")
    const queue = new DurableOutbox(disk, "queue")
    await expect(queue.enqueue(reply("one"))).rejects.toThrow()
    expect(await disk.getItem("queue")).toBe("corrupted saved data")
  } finally { await disk.close() }
})

test("removing a queued reply before its durable send claim prevents submission", async () => {
  const disk = await storage()
  try {
    await new DurableOutbox(disk, "queue").enqueue(reply("remove-me"))
    let release!: () => void, selected!: () => void, reads = 0
    const gate = new Promise<void>(resolve => { release = resolve })
    const selection = new Promise<void>(resolve => { selected = resolve })
    const queue = new DurableOutbox({ ...disk, getItem: async key => {
      const value = await disk.getItem(key)
      if (++reads === 1) { selected(); await gate }
      return value
    } }, "queue")
    const submissions: string[] = []
    const drain = queue.drain("operator", async item => { submissions.push(item.id); return {} }, () => true)
    await selection
    await queue.remove("operator", "remove-me")
    release()
    await drain
    expect(submissions).toEqual([])
    expect(await queue.list("operator")).toEqual([])
  } finally { await disk.close() }
})
