import { expect, test } from "bun:test"
import {
  createStaleWhileRevalidate,
  swrCacheKey,
  type SwrStore,
} from "@/src/server/cache/stale-while-revalidate"

function fixture() {
  let now = 1000,
    loads = 0
  const values = new Map<string, string>(),
    locks = new Map<string, string>()
  const deferred: (() => Promise<void>)[] = []
  const store: SwrStore = {
    get: async (key) => values.get(key) ?? null,
    lock: async (key, token) => {
      if (locks.has(key)) return false
      locks.set(key, token)
      return true
    },
    publish: async (key, token, value) => {
      if (locks.get(key) === token) values.set(key, value)
    },
    unlock: async (key, token) => {
      if (locks.get(key) === token) locks.delete(key)
    },
  }
  const cache = createStaleWhileRevalidate(store, () => now)
  const options = {
    namespace: "tests-v1",
    scope: "project-a",
    key: { query: "count" },
    freshMs: 100,
    maxAgeMs: 1000,
    load: async () => ++loads,
    defer: (work: () => Promise<void>) => {
      deferred.push(work)
    },
  }
  return {
    cache,
    options,
    store,
    values,
    locks,
    deferred,
    advance: (ms: number) => {
      now += ms
    },
    loads: () => loads,
  }
}
test("fresh, stale and hard-expired entries have distinct behavior", async () => {
  const f = fixture()
  expect(await f.cache(f.options)).toEqual({ data: 1, state: "miss" })
  expect(await f.cache(f.options)).toEqual({ data: 1, state: "fresh" })
  f.advance(100)
  expect(await f.cache(f.options)).toEqual({ data: 1, state: "stale" })
  expect(f.loads()).toBe(1)
  await f.deferred.shift()!()
  expect(await f.cache(f.options)).toEqual({ data: 2, state: "fresh" })
  f.advance(1000)
  expect(await f.cache(f.options)).toEqual({ data: 3, state: "miss" })
})
test("failed revalidation does not extend stale life; expired failures propagate", async () => {
  const f = fixture()
  await f.cache(f.options)
  f.advance(100)
  const broken = {
    ...f.options,
    load: async (): Promise<number> => {
      throw new Error("offline")
    },
  }
  expect((await f.cache(broken)).data).toBe(1)
  await f.deferred.shift()!()
  f.advance(900)
  const error = await f.cache(broken).catch((error) => error)
  expect(error).toBeInstanceOf(Error)
  expect(error.message).toBe("offline")
})
test("force refresh and scope, query and namespace changes do not reuse old values", async () => {
  const f = fixture()
  await f.cache(f.options)
  expect((await f.cache({ ...f.options, force: true })).data).toBe(2)
  expect((await f.cache({ ...f.options, scope: "project-b" })).state).toBe(
    "miss"
  )
  expect((await f.cache({ ...f.options, key: { query: "cost" } })).state).toBe(
    "miss"
  )
  expect((await f.cache({ ...f.options, namespace: "tests-v2" })).state).toBe(
    "miss"
  )
})
test("concurrent background refreshes share a lease across processes", async () => {
  const f = fixture()
  await f.cache(f.options)
  f.advance(100)
  let release!: (value: number) => void
  let loads = 0
  const load = () => {
    loads++
    return new Promise<number>((resolve) => {
      release = resolve
    })
  }
  const second = createStaleWhileRevalidate(f.store, () => 1100)
  await f.cache({ ...f.options, load })
  await second({ ...f.options, load })
  const jobs = f.deferred.map((work) => work())
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(loads).toBe(1)
  release(9)
  await Promise.all(jobs)
  expect((await f.cache(f.options)).data).toBe(9)
})
test("Redis failures, absent store and malformed entries fall back to the loader", async () => {
  const f = fixture()
  const broken: SwrStore = {
    get: async () => {
      throw Error()
    },
    lock: async () => {
      throw Error()
    },
    publish: async () => {
      throw Error()
    },
    unlock: async () => {
      throw Error()
    },
  }
  expect((await createStaleWhileRevalidate(broken)(f.options)).data).toBe(1)
  expect((await createStaleWhileRevalidate(null)(f.options)).state).toBe(
    "bypass"
  )
  f.values.set(
    swrCacheKey(f.options.namespace, f.options.scope, f.options.key),
    "{broken"
  )
  expect((await f.cache(f.options)).state).toBe("miss")
})
test("object key order is stable but array order and tenant scope remain significant", () => {
  expect(swrCacheKey("n", "p", { a: 1, b: 2 })).toBe(
    swrCacheKey("n", "p", { b: 2, a: 1 })
  )
  expect(swrCacheKey("n", "p", [1, 2])).not.toBe(swrCacheKey("n", "p", [2, 1]))
})

test("expiry during a skipped background refresh never serves the old value", async () => {
  const f = fixture()
  await f.cache(f.options)
  f.advance(100)
  let release!: (locked: boolean) => void
  f.store.lock = () =>
    new Promise((resolve) => {
      release = resolve
    })
  await f.cache(f.options)
  const background = f.deferred.shift()!()
  f.advance(900)
  const foreground = f.cache(f.options)
  await new Promise((resolve) => setTimeout(resolve, 0))
  release(false)
  await background
  expect(await foreground).toEqual({ data: 2, state: "miss" })
})

test("entry size limits skip Redis storage without truncating or changing returned data", async () => {
  const f = fixture()
  let reads = 0
  const options = { ...f.options, maxEntryBytes: 100, load: async () => ({ text: "x".repeat(1000), version: ++reads }) }
  const first = await f.cache(options)
  expect(first.data.text).toHaveLength(1000)
  expect(first.data.version).toBe(1)
  expect(f.values.size).toBe(0)
  const second = await f.cache(options)
  expect(second.data.text).toHaveLength(1000)
  expect(second.data.version).toBe(2)
  expect(f.values.size).toBe(0)
  // An ordinary small result remains shareable under the same configured limit.
  const small = { ...f.options, maxEntryBytes: 100, load: async () => "small" }
  await f.cache(small)
  expect((await f.cache(small)).state).toBe("fresh")
})
