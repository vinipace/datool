import { describe, test, expect } from "bun:test"
import assert from "node:assert/strict"
import { createChannelAutosave } from "@/src/lib/build/channel-autosave"
import { resolveChatBubbleSettings } from "@/src/lib/build/chat-bubble"
import type { ChannelConnection } from "@/src/lib/build/channels"

const connection = { id: "channel", label: "Chat Bubble" } as ChannelConnection
const initial = {
  label: "Chat Bubble",
  origins: "",
  bubble: resolveChatBubbleSettings({}),
}

describe("channel autosave", () => {
  test("serializes edits made during a save and keeps the newest draft visible", async () => {
    let release!: () => void
    const first = new Promise<void>((resolve) => {
      release = resolve
    })
    let writes = 0
    let active = 0
    let maxActive = 0
    let persisted = ""
    const store = createChannelAutosave(initial, connection, async (draft) => {
      active++
      maxActive = Math.max(maxActive, active)
      if (++writes === 1) await first
      persisted = draft.label
      active--
      return { ...connection, label: draft.label }
    })
    store.update({ ...initial, label: "First edit" })
    const saving = store.flush()
    store.update({ ...initial, label: "Newest edit" })
    release()
    await saving
    expect(persisted).toBe("Newest edit")
    expect(store.getSnapshot().draft.label).toBe("Newest edit")
    expect(maxActive).toBe(1)
    expect(store.pending()).toBe(false)
    expect(store.getSnapshot().status).toBe("saved")
  })

  test("retains a failed draft and retries it without losing edits", async () => {
    let fail = true
    const store = createChannelAutosave(initial, connection, async (draft) => {
      if (fail) throw new Error("Offline")
      return { ...connection, label: draft.label }
    })
    store.update({ ...initial, label: "Keep this" })
    await assert.rejects(store.flush(), /Offline/)
    expect(store.getSnapshot().draft.label).toBe("Keep this")
    expect(store.pending()).toBe(true)
    expect(store.getSnapshot().status).toBe("error")
    fail = false
    await store.flush()
    expect(store.getSnapshot().connection.label).toBe("Keep this")
    expect(store.getSnapshot().status).toBe("saved")
  })
})
