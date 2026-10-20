import { describe, expect, test } from "bun:test"
import assert from "node:assert/strict"
import { createAgentAutosave } from "@/src/lib/build/agent-autosave"
import {
  agentConfigurationSchema,
  type ManagedAgent,
} from "@/src/lib/build/contracts"

const agent: ManagedAgent = {
  id: "agent",
  projectId: "project",
  name: "Assistant",
  slug: "assistant",
  description: null,
  status: "active",
  currentRevision: 1,
  appliedRevision: 1,
  configuration: agentConfigurationSchema.parse({}),
  createdAt: "2026-10-20T00:00:00Z",
  updatedAt: "2026-10-20T00:00:00Z",
  archivedAt: null,
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("agent autosave", () => {
  test("autosaves edits in revision order and preserves newer edits during a write", async () => {
    const started = deferred()
    const release = deferred()
    const revisions: number[] = []
    let persisted = agent
    const store = createAgentAutosave(
      agent,
      async (draft, saved) => {
        expect(saved?.currentRevision).toBe(persisted.currentRevision)
        revisions.push(saved!.currentRevision)
        if (revisions.length === 1) {
          started.resolve()
          await release.promise
        }
        persisted = {
          ...persisted,
          ...draft,
          currentRevision: persisted.currentRevision + 1,
          appliedRevision: persisted.currentRevision + 1,
        }
        return persisted
      },
      0
    )
    store.update({ ...store.getSnapshot().draft, name: "First edit" })
    await started.promise
    store.update({ ...store.getSnapshot().draft, name: "Newest edit" })
    release.resolve()
    await store.flush()
    expect(revisions).toEqual([1, 2])
    expect(persisted.name).toBe("Newest edit")
    expect(store.getSnapshot().draft.name).toBe("Newest edit")
    expect(store.getSnapshot().saved?.appliedRevision).toBe(3)
    expect(store.pending()).toBe(false)
  })

  test("applies a definition saved during another write without losing the second change", async () => {
    const release = deferred()
    let writes = 0
    const store = createAgentAutosave(agent, async (_draft, saved, changes) => {
      expect(changes).toEqual({})
      if (++writes === 1) await release.promise
      return {
        ...saved!,
        currentRevision: saved!.currentRevision + 1,
        appliedRevision: saved!.currentRevision + 1,
      }
    })
    store.definitionsChanged()
    const saving = store.flush()
    store.definitionsChanged()
    release.resolve()
    await saving
    expect(writes).toBe(2)
    expect(store.getSnapshot().saved?.appliedRevision).toBe(3)
    expect(store.pending()).toBe(false)
  })

  test("retains failed changes and retries with the last acknowledged revision", async () => {
    let fail = true
    const store = createAgentAutosave(agent, async (draft, saved) => {
      expect(saved?.currentRevision).toBe(1)
      if (fail) throw new Error("Offline")
      return { ...saved!, ...draft, currentRevision: 2, appliedRevision: 2 }
    })
    store.update({ ...store.getSnapshot().draft, description: "Keep this" })
    await assert.rejects(store.flush(), /Offline/)
    expect(store.getSnapshot().draft.description).toBe("Keep this")
    expect(store.getSnapshot().status).toBe("error")
    expect(store.pending()).toBe(true)
    fail = false
    await store.flush()
    expect(store.getSnapshot().saved?.description).toBe("Keep this")
    expect(store.getSnapshot().status).toBe("saved")
  })

  test("keeps incomplete edits local, including those made during a save", async () => {
    const release = deferred()
    let writes = 0
    const store = createAgentAutosave(agent, async (draft, saved) => {
      writes++
      await release.promise
      return {
        ...saved!,
        ...draft,
        currentRevision: saved!.currentRevision + 1,
      }
    })
    store.update({ ...store.getSnapshot().draft, name: "Valid edit" })
    const saving = store.flush()
    store.update({ ...store.getSnapshot().draft, name: "" })
    release.resolve()
    await saving
    expect(writes).toBe(1)
    expect(store.getSnapshot().draft.name).toBe("")
    expect(store.getSnapshot().status).toBe("invalid")
    expect(store.pending()).toBe(true)
    store.update({ ...store.getSnapshot().draft, name: "Corrected" })
    await store.flush()
    expect(store.getSnapshot().saved?.name).toBe("Corrected")
    expect(writes).toBe(2)
  })

  test("requires explicit creation before starting autosave", async () => {
    let writes = 0
    const store = createAgentAutosave(
      undefined,
      async (draft) => {
        writes++
        return { ...agent, ...draft }
      },
      0
    )
    store.update({
      ...store.getSnapshot().draft,
      name: "New agent",
      slug: "new-agent",
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(writes).toBe(0)
    await store.flush()
    expect(writes).toBe(1)
    expect(store.getSnapshot().saved?.name).toBe("New agent")
  })
})
