import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { createPromptAutosave } from "../src/lib/tracer/prompt-autosave"
import {
  defaultPrompt,
  type ManagedPrompt,
  type PromptInput,
} from "../src/lib/tracer/prompts"

const initial: ManagedPrompt = {
  ...defaultPrompt,
  id: "prompt",
  name: "Support",
  slug: "support",
  model: "openai/gpt-4.1-mini",
  messages: [{ role: "system", content: "Be concise." }],
  revision: 4,
  version: null,
  publishedVersion: 2,
  publishedAt: "2026-09-17",
  hasDraft: false,
  createdAt: "2026-09-17",
  updatedAt: "2026-09-17",
}
const response = (input: PromptInput, saved = initial): ManagedPrompt => ({
  ...saved,
  ...input,
  revision: saved.revision + 1,
  hasDraft: true,
})
const pause = () => new Promise((resolve) => setTimeout(resolve, 30))

test("debounces edits and preserves the published version", async () => {
  const writes: PromptInput[] = []
  const store = createPromptAutosave({
    initial,
    delay: 5,
    save: async (input, saved) => {
      writes.push(input)
      return response(input, saved)
    },
  })
  store.update({ description: "A" })
  store.update({ description: "A complete description" })
  await pause()
  expect(writes).toHaveLength(1)
  expect(store.getSnapshot().saved?.description).toBe("A complete description")
  expect(store.getSnapshot().saved?.publishedVersion).toBe(2)
  expect(store.pending()).toBe(false)
})

test("edits during an in-flight save use the next revision and never replace newer text", async () => {
  const revisions: number[] = []
  let resolveFirst!: (value: ManagedPrompt) => void
  let first!: PromptInput
  const store = createPromptAutosave({
    initial,
    save: async (input, saved) => {
      revisions.push(saved!.revision)
      if (revisions.length === 1) {
        first = input
        return new Promise((resolve) => {
          resolveFirst = resolve
        })
      }
      return response(input, saved)
    },
  })
  store.update({ description: "First" })
  const flight = store.flush()
  store.update({ description: "Latest" })
  store.updateMetadata('{"team":"support"}')
  resolveFirst(response(first))
  await flight
  expect(revisions).toEqual([4, 5])
  expect(store.getSnapshot().draft.description).toBe("Latest")
  expect(store.getSnapshot().saved?.description).toBe("Latest")
  expect(store.getSnapshot().saved?.metadata).toEqual({ team: "support" })
  expect(store.pending()).toBe(false)
})

test("a revert during an in-flight save is persisted", async () => {
  let resolveFirst!: (value: ManagedPrompt) => void
  let first!: PromptInput
  let count = 0
  const store = createPromptAutosave({
    initial,
    save: async (input, saved) => {
      if (++count === 1) {
        first = input
        return new Promise((resolve) => {
          resolveFirst = resolve
        })
      }
      return response(input, saved)
    },
  })
  store.update({ name: "Changed" })
  const flight = store.flush()
  store.update({ name: initial.name })
  resolveFirst(response(first))
  await flight
  expect(count).toBe(2)
  expect(store.getSnapshot().saved?.name).toBe(initial.name)
})

test("invalid metadata stays local until corrected; formatting changes do not save", async () => {
  let count = 0
  const store = createPromptAutosave({
    initial,
    save: async (input, saved) => {
      count++
      return response(input, saved)
    },
  })
  store.updateMetadata("[]")
  await store.flush()
  expect(count).toBe(0)
  expect(store.getSnapshot().status).toBe("incomplete")
  store.updateMetadata('{ "team": "support" }')
  await store.flush()
  store.updateMetadata('{\n  "team": "support"\n}')
  await store.flush()
  expect(count).toBe(1)
  expect(store.pending()).toBe(false)
})

test("new incomplete drafts create once then update the same record", async () => {
  const ids: (string | undefined)[] = []
  const store = createPromptAutosave({
    save: async (input, saved) => {
      ids.push(saved?.id)
      return response(
        input,
        saved ?? {
          ...initial,
          publishedVersion: null,
          publishedAt: null,
          revision: 0,
        }
      )
    },
  })
  store.update({ name: "Work" })
  await store.flush()
  expect(ids).toEqual([])
  store.update({ slug: "work" })
  await store.flush()
  store.update({ description: "Still incomplete" })
  await store.flush()
  expect(ids).toEqual([undefined, "prompt"])
  expect(store.getSnapshot().saved?.model).toBe("")
  expect(store.getSnapshot().saved?.publishedVersion).toBeNull()
})

test("a failed save retains edits and stops retries until explicitly retried", async () => {
  let count = 0
  const store = createPromptAutosave({
    initial,
    delay: 5,
    save: async (input, saved) => {
      if (++count === 1) throw new Error("Conflict")
      return response(input, saved)
    },
  })
  store.update({ description: "Keep this" })
  await assert.rejects(store.flush(), /Conflict/)
  store.update({ description: "Keep newer text too" })
  await pause()
  expect(count).toBe(1)
  expect(store.getSnapshot().draft.description).toBe("Keep newer text too")
  await store.flush()
  expect(store.getSnapshot().saved?.description).toBe("Keep newer text too")
  expect(store.getSnapshot().error).toBeNull()
})
