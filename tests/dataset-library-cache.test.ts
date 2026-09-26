import { expect, test } from "bun:test"
import {
  DatasetLibraryCache,
  getDatasetLibraryCache,
  type FolderTarget,
} from "@/src/lib/tracer/dataset-library-cache"
import type {
  CreatedLibraryEntry,
  DatasetLibraryEntry,
  DatasetLibraryPage,
} from "@/src/lib/tracer/dataset-library"

const root: FolderTarget = { id: null, name: "" }
const row = (
  name: string,
  kind: "dataset" | "folder" = "dataset"
): DatasetLibraryEntry => ({
  id: `saved:${name}`,
  name,
  kind,
  description: null,
  itemCount: kind === "folder" ? null : 0,
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:00.000Z",
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function setup(initial: DatasetLibraryEntry[] = []) {
  const creates: ReturnType<typeof deferred<CreatedLibraryEntry>>[] = []
  const moves: ReturnType<typeof deferred<{ id: string; name: string }>>[] = []
  const reads: ReturnType<typeof deferred<DatasetLibraryPage>>[] = []
  const createInputs: unknown[] = []
  let deferReads = false
  let readCount = 0
  const cache = new DatasetLibraryCache({
    library: async () => {
      readCount++
      if (deferReads) {
        const response = deferred<DatasetLibraryPage>()
        reads.push(response)
        return response.promise
      }
      return {
        items: initial,
        nextCursor: null,
      }
    },
    addEntry: (input) => {
      createInputs.push(input)
      const response = deferred<CreatedLibraryEntry>()
      creates.push(response)
      return response.promise
    },
    moveEntry: () => {
      const response = deferred<{ id: string; name: string }>()
      moves.push(response)
      return response.promise
    },
  })
  return {
    cache,
    creates,
    moves,
    reads,
    createInputs,
    delayReads: () => {
      deferReads = true
    },
    readCount: () => readCount,
  }
}
const names = (cache: DatasetLibraryCache, target = root) =>
  cache.page(target).items.map((entry) => entry.name)
const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

test("nested create appears synchronously and subsequent input can use its pending parent", async () => {
  const { cache, creates, createInputs, readCount } = setup()
  await cache.load()
  cache.create("Foo/Bar/Core", root)
  expect(names(cache)).toEqual(["Foo"])
  const foo = cache.page(root).items[0]
  const bar = cache.page(foo).items[0]
  expect(names(cache, bar)).toEqual(["Foo/Bar/Core"])
  expect(cache.page(foo).isLoading).toBe(false)
  cache.create("Next", bar)
  expect(names(cache, bar)).toEqual(["Foo/Bar/Core", "Foo/Bar/Next"])
  expect(createInputs[1]).toEqual({
    kind: "dataset",
    name: "Foo/Bar/Next",
    folderId: null,
  })
  const savedFoo = row("Foo", "folder"),
    savedBar = row("Foo/Bar", "folder")
  creates[1].resolve({ ...row("Foo/Bar/Next"), folders: [savedFoo, savedBar] })
  creates[0].resolve({ ...row("Foo/Bar/Core"), folders: [savedFoo, savedBar] })
  await settle()
  expect(cache.page(root).items[0].id).toBe(savedFoo.id)
  expect(names(cache, savedBar)).toEqual(["Foo/Bar/Core", "Foo/Bar/Next"])
  expect(
    cache.page(savedBar).items.every((entry) => !cache.isPending(entry))
  ).toBe(true)
  expect(readCount()).toBe(1) // No reload needed to make the mutation visible.
})

test("failed create removes only its rows and preserves the next successful create, with retry", async () => {
  const { cache, creates } = setup()
  await cache.load()
  cache.create("Foo/Failed", root)
  cache.create("Foo/Kept", root)
  creates[1].resolve({ ...row("Foo/Kept"), folders: [row("Foo", "folder")] })
  creates[0].reject(new Error("Offline"))
  await settle()
  expect(names(cache)).toEqual(["Foo"])
  expect(names(cache, row("Foo", "folder"))).toEqual(["Foo/Kept"])
  expect(cache.failures[0].message).toContain("Offline")
  cache.failures[0].retry()
  expect(cache.failures.length).toBe(0)
  expect(names(cache, row("Foo", "folder"))).toEqual(["Foo/Failed", "Foo/Kept"])
  creates[2].resolve({ ...row("Foo/Failed"), folders: [row("Foo", "folder")] })
  await settle()
})

test("moving a loaded subtree is immediate and does not block independent writes", async () => {
  const foo = row("Foo", "folder"),
    bar = row("Foo/Bar", "folder"),
    core = row("Foo/Bar/Core"),
    dest = row("Destination", "folder"),
    other = row("Other")
  const { cache, moves, creates } = setup([foo, bar, core, dest, other])
  await cache.load()
  await cache.load()
  await cache.load()
  expect(cache.move(foo, dest)).toBe(true)
  expect(names(cache)).toEqual(["Destination", "Other"])
  expect(names(cache, dest)).toEqual(["Destination/Foo"])
  expect(names(cache, { ...bar, name: "Destination/Foo/Bar" })).toEqual([
    "Destination/Foo/Bar/Core",
  ])
  expect(cache.canMove(other, dest)).toBe(true)
  cache.create("New", root)
  moves[0].reject(new Error("Move rejected"))
  creates[0].resolve({ ...row("New"), folders: [] })
  await settle()
  expect(names(cache)).toEqual(["Destination", "Foo", "New", "Other"])
  expect(names(cache, bar)).toEqual(["Foo/Bar/Core"])
  expect(names(cache, dest)).toEqual([])
})

test("a late read cannot put a moved folder or previously unseen descendants back", async () => {
  const foo = row("Foo", "folder"),
    dest = row("Destination", "folder")
  const { cache, moves, reads, delayReads } = setup([foo, dest])
  await cache.load()
  delayReads()
  const staleRoot = cache.refresh()
  expect(cache.load()).toBe(staleRoot)
  reads[0].resolve({ items: [foo, dest], nextCursor: dest.id })
  await settle()
  cache.move(foo, dest)
  moves[0].resolve({ id: foo.id, name: "Destination/Foo" })
  await settle()
  reads[1].resolve({ items: [row("Foo/Unseen")], nextCursor: null })
  await staleRoot
  expect(names(cache)).toEqual(["Destination"])
  expect(names(cache, dest)).toEqual(["Destination/Foo"])
  expect(names(cache, { ...foo, name: "Destination/Foo" })).toEqual([
    "Destination/Foo/Unseen",
  ])
})

test("a late empty read cannot remove a just-created row", async () => {
  const { cache, creates, reads, delayReads } = setup()
  await cache.load()
  delayReads()
  const stale = cache.refresh()
  cache.create("Fresh/", root)
  creates[0].resolve({ ...row("Fresh", "folder"), folders: [] })
  await settle()
  reads[0].resolve({ items: [], nextCursor: null })
  await stale
  expect(names(cache)).toEqual(["Fresh"])
  expect(cache.page(row("Fresh", "folder")).isLoading).toBe(false)
  await cache.load()
  expect(reads.length).toBe(1)
})

test("folder reopen reuses cached children and refresh failures retain their content", async () => {
  const folder = row("Foo", "folder")
  const { cache, reads, delayReads, readCount } = setup([
    folder,
    row("Foo/Core"),
  ])
  await cache.load()
  await cache.load()
  await cache.load()
  expect(readCount()).toBe(1)
  expect(cache.page(folder).isLoading).toBe(false)
  delayReads()
  const refresh = cache.refresh()
  expect(names(cache, folder)).toEqual(["Foo/Core"])
  reads[0].reject(new Error("Offline"))
  await refresh
  expect(names(cache, folder)).toEqual(["Foo/Core"])
  expect(cache.page(folder).error?.message).toBe("Offline")
})

test("path conflicts and dependent moves are blocked without disabling sibling operations", async () => {
  const folder = row("Foo", "folder"),
    dest = row("Destination", "folder"),
    one = row("Foo/One"),
    two = row("Foo/Two")
  const { cache, moves } = setup([folder, dest, one, two])
  await cache.load()
  await cache.load()
  expect(() => cache.create("Foo/One", root)).toThrow("already exists")
  expect(() => cache.create("Foo/One/Sub", root)).toThrow("already a dataset")
  expect(cache.canMove(folder, folder)).toBe(false)
  cache.move(one, dest)
  expect(cache.canMove(two, dest)).toBe(true)
  expect(cache.canMove(folder, dest)).toBe(false)
  moves[0].resolve({ id: one.id, name: "Destination/One" })
  await settle()
  cache.move(folder, dest)
  expect(() => cache.create("Foo/Later", root)).toThrow("still moving")
  moves[1].resolve({ id: folder.id, name: "Destination/Foo" })
  await settle()
})

test("refresh retires removed records and failed first reads remain retryable", async () => {
  const { cache, reads, delayReads } = setup()
  delayReads()
  const first = cache.load()
  expect(cache.page(root).isLoading).toBe(true)
  reads[0].reject(new Error("Offline"))
  await first
  expect(cache.page(root).data).toBe(null)
  expect(cache.page(root).error?.message).toBe("Offline")
  const retry = cache.load()
  reads[1].resolve({ items: [row("Gone")], nextCursor: null })
  await retry
  const refresh = cache.refresh()
  reads[2].resolve({ items: [], nextCursor: null })
  await refresh
  expect(names(cache)).toEqual([])
  expect(cache.page(root).data).not.toBe(null)
})

test("a move cannot reuse a path until an earlier move has finished", async () => {
  const foo = row("Foo", "folder"),
    other = row("Other", "folder"),
    nested = row("Other/Foo", "folder"),
    target = row("Target", "folder")
  const { cache, moves } = setup([foo, other, nested, target])
  await cache.load()
  await cache.load()
  cache.move(foo, target)
  expect(cache.canMove(nested, root)).toBe(false)
  moves[0].resolve({ id: foo.id, name: "Target/Foo" })
  await settle()
  expect(cache.canMove(nested, root)).toBe(true)
})

test("retrying a failed relative create follows its folder after a successful move", async () => {
  const foo = row("Foo", "folder"),
    target = row("Target", "folder")
  const { cache, creates, moves, createInputs } = setup([foo, target])
  await cache.load()
  cache.create("Core", foo)
  creates[0].reject(new Error("Offline"))
  await settle()
  cache.move(foo, target)
  moves[0].resolve({ id: foo.id, name: "Target/Foo" })
  await settle()
  cache.failures[0].retry()
  expect(createInputs[1]).toEqual({
    kind: "dataset",
    name: "Target/Foo/Core",
    folderId: null,
  })
  creates[1].resolve({
    ...row("Target/Foo/Core"),
    folders: [target, { ...foo, name: "Target/Foo" }],
  })
  await settle()
  expect(names(cache, { ...foo, name: "Target/Foo" })).toEqual([
    "Target/Foo/Core",
  ])
})

test("the initial tree includes unopened and empty folders and supports local search", async () => {
  const folder = row("Foo", "folder"),
    child = row("Foo/Nested", "folder"),
    empty = row("Empty", "folder")
  const { cache, readCount } = setup([
    folder,
    child,
    empty,
    { ...row("Foo/Nested/Core"), description: "Refund quality" },
  ])
  await cache.load()
  expect(cache.page(child).items.map((entry) => entry.name)).toEqual([
    "Foo/Nested/Core",
  ])
  expect(cache.page(child).isLoading).toBe(false)
  expect(cache.page(empty).items).toEqual([])
  expect(cache.page(empty).isLoading).toBe(false)
  expect(cache.page(root, "refund").items.map((entry) => entry.name)).toEqual([
    "Foo/Nested/Core",
  ])
  expect(cache.page(root, "nested/core").items).toHaveLength(1)
  await cache.load()
  expect(readCount()).toBe(1)
})

test("batches are fetched automatically and installed only when the tree is complete", async () => {
  const { cache, reads, delayReads, readCount } = setup()
  delayReads()
  const loading = cache.load()
  expect(cache.load()).toBe(loading)
  const folder = row("Foo", "folder")
  reads[0].resolve({ items: [folder], nextCursor: folder.id })
  await settle()
  expect(readCount()).toBe(2)
  expect(cache.page(root).data).toBe(null)
  reads[1].resolve({ items: [row("Foo/Core")], nextCursor: null })
  await loading
  expect(cache.page(folder).isLoading).toBe(false)
  expect(names(cache, folder)).toEqual(["Foo/Core"])
})

test("failed later batches preserve the previous complete tree and retry starts fresh", async () => {
  const folder = row("Foo", "folder"),
    core = row("Foo/Core")
  const { cache, reads, delayReads } = setup([folder, core])
  await cache.load()
  delayReads()
  const refresh = cache.refresh()
  reads[0].resolve({ items: [row("New")], nextCursor: "next" })
  await settle()
  reads[1].reject(new Error("Offline"))
  await refresh
  expect(names(cache)).toEqual(["Foo"])
  expect(names(cache, folder)).toEqual(["Foo/Core"])
  expect(cache.page(folder).isLoading).toBe(false)
  const retry = cache.refresh()
  reads[2].resolve({ items: [row("New")], nextCursor: null })
  await retry
  expect(names(cache)).toEqual(["New"])
  expect(names(cache, folder)).toEqual([])
  expect(cache.page(root).error).toBe(null)
})

test("repeated cursors fail instead of leaving tree loading in an endless loop", async () => {
  const { cache, reads, delayReads } = setup()
  delayReads()
  const loading = cache.load()
  reads[0].resolve({ items: [], nextCursor: "same" })
  await settle()
  reads[1].resolve({ items: [], nextCursor: "same" })
  await loading
  expect(cache.page(root).error?.message).toContain("Please retry")
  expect(cache.page(root).isLoading).toBe(false)
})

test("project layout caches survive page remounts without crossing project or account scopes", async () => {
  let readCount = 0
  const api = {
    library: async () => {
      readCount++
      return { items: [row("Cached")], nextCursor: null }
    },
    addEntry: async () => ({ ...row("New"), folders: [] }),
    moveEntry: async () => ({ id: "unused", name: "Unused" }),
  }
  const scope = { projectId: "one" }
  const cache = getDatasetLibraryCache(scope, api)
  await cache.load()
  const remounted = getDatasetLibraryCache(scope, api)
  expect(remounted).toBe(cache)
  expect(remounted.page(root).isLoading).toBe(false)
  await remounted.load()
  expect(readCount).toBe(1)
  expect(
    getDatasetLibraryCache({ projectId: "two" }, api).page(root).data
  ).toBe(null)
  expect(
    getDatasetLibraryCache({ projectId: "one" }, api).page(root).data
  ).toBe(null)
})
