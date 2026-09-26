import { expect, test } from "bun:test"
import { createScorerDraftStore } from "../src/lib/tracer/scorer-draft-store"
import { defaultScorer } from "../src/lib/tracer/scorers"

function fixture() {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
  const open = (
    key = "project:scorer",
    revision = 1,
    initial = defaultScorer
  ) => {
    const store = createScorerDraftStore(key, initial, revision, () => storage)
    store.hydrate()
    return store
  }
  return { values, open, storage }
}

test("incomplete scorer drafts survive remounts and stay isolated by identity", () => {
  const { open } = fixture()
  const store = open()
  store.update((d) => ({
    ...d,
    name: "Draft",
    slug: "invalid draft!",
    model: "",
    messages: [],
  }))
  expect(open().getSnapshot().draft).toMatchObject({
    name: "Draft",
    slug: "invalid draft!",
    messages: [],
  })
  expect(open().getSnapshot().dirty).toBe(true)
  expect(open("another-project:scorer").getSnapshot().dirty).toBe(false)
  expect(open("project:another-scorer").getSnapshot().draft.name).toBe("")
})

test("reverting or saving clears local drafts; later edits during a save survive", () => {
  const { open, values } = fixture()
  const store = open()
  store.update((d) => ({ ...d, name: "Draft" }))
  store.update(defaultScorer)
  expect(values.size).toBe(0)
  store.update((d) => ({ ...d, name: "First" }))
  const submitted = store.getSnapshot().draft
  store.update((d) => ({ ...d, name: "Second" }))
  expect(store.saved(submitted, 2)).toBe(false)
  expect(open().getSnapshot()).toMatchObject({
    dirty: true,
    revision: 2,
    draft: { name: "Second" },
  })
  expect(store.saved(store.getSnapshot().draft, 3)).toBe(true)
  expect(values.size).toBe(0)
})

test("restored drafts keep their original revision rather than overwriting newer server edits", () => {
  const { open } = fixture()
  open().update((d) => ({ ...d, name: "Local edit" }))
  expect(
    open("project:scorer", 5, {
      ...defaultScorer,
      name: "Remote edit",
    }).getSnapshot()
  ).toMatchObject({ revision: 1, dirty: true, draft: { name: "Local edit" } })
})

test("corrupt or blocked storage does not crash, and failed writes preserve in-memory edits", () => {
  const { open, values } = fixture()
  values.set("project:scorer", "not JSON")
  expect(open().getSnapshot().ready).toBe(true)
  const store = createScorerDraftStore("key", defaultScorer, undefined, () => {
    throw Error("blocked")
  })
  store.hydrate()
  store.update((d) => ({ ...d, name: "Keep me" }))
  expect(store.getSnapshot().draft.name).toBe("Keep me")
  expect(store.getSnapshot().storageError).toContain("could not store")
})

test("completed saves cannot resurrect stale drafts; newly created drafts move to their saved identity", () => {
  const { open, values } = fixture()
  const store = open()
  store.update((d) => ({ ...d, name: "Saved elsewhere" }))
  expect(
    open("project:scorer", 2, store.getSnapshot().draft).getSnapshot().dirty
  ).toBe(false)
  expect(values.size).toBe(0)
  store.update((d) => ({ ...d, name: "Still editing" }))
  expect(store.move("project:new-id")).toBe(true)
  expect(values.has("project:scorer")).toBe(false)
  expect(open("project:new-id").getSnapshot().draft.name).toBe("Still editing")
})
