import { rejects } from "node:assert/strict"
import { expect, test } from "bun:test"
import { createStaleWhileRevalidate, type SwrStore } from "@/src/server/cache/stale-while-revalidate"
import { createSharedReadCache } from "@/src/server/tracer/shared-read-cache"

function fixture() {
  let now = 0, loads = 0, score = 1
  const values = new Map<string, string>()
  const store: SwrStore = {
    get: async key => values.get(key) ?? null,
    lock: async () => true,
    publish: async (key, _token, value) => { values.set(key, value) },
    unlock: async () => {},
  }
  const read = createSharedReadCache({ cache: createStaleWhileRevalidate(store, () => now) })
  const input = { projectId: "project", key: "/api/evals/run?limit=50", load: async () => {
    loads++
    return { status: "running", score }
  } }
  return { read, input, loads: () => loads, advance: (ms: number) => { now += ms }, change: () => { score++ } }
}

test("shared reads coalesce viewers and retain validators across quiet refreshes", async () => {
  const f = fixture()
  const first = await f.read(f.input)
  expect(first.unchanged).toBe(false)
  const viewers = await Promise.all(Array.from({ length: 12 }, () => f.read(f.input)))
  expect(viewers.every(result => result.etag === first.etag)).toBe(true)
  expect(f.loads()).toBe(1)
  expect((await f.read({ ...f.input, etag: first.etag })).unchanged).toBe(true)
  f.advance(2000)
  const polls = await Promise.all(Array.from({ length: 12 }, () => f.read({ ...f.input, etag: first.etag })))
  expect(polls.every(result => result.unchanged)).toBe(true)
  expect(f.loads()).toBe(2)
})

test("independent score changes expire within two seconds and change the content validator", async () => {
  const f = fixture(), first = await f.read(f.input)
  f.change()
  f.advance(1999)
  expect((await f.read({ ...f.input, etag: first.etag })).unchanged).toBe(true)
  f.advance(1)
  const changed = await f.read({ ...f.input, etag: first.etag })
  expect(changed.unchanged).toBe(false)
  expect(changed.etag).not.toBe(first.etag)
  if (!changed.unchanged) expect(changed.data.score).toBe(2)
})

test("project, filter, cursor and evidence shape cannot share validators", async () => {
  const f = fixture(), first = await f.read(f.input)
  for (const input of [
    { ...f.input, projectId: "other" },
    { ...f.input, key: "/api/evals/run?cursor=next&limit=50" },
    { ...f.input, key: "/api/evals/run?includeEvidence=true&limit=50" },
    { ...f.input, key: "/api/evals?filter=status=completed" },
  ]) {
    const result = await f.read({ ...input, etag: first.etag })
    expect(result.unchanged).toBe(false)
    expect(result.etag).not.toBe(first.etag)
  }
})

test("forced reads do not join stale loads; errors and disabled or absent caches fail open", async () => {
  const f = fixture(), first = await f.read(f.input)
  f.change()
  for (const options of [{ force: true }, { enabled: false }]) {
    const result = await f.read({ ...f.input, ...options, etag: first.etag })
    expect(result.state).toBe("bypass")
    expect(result.etag).toBeUndefined()
    if (!result.unchanged) expect(result.data.score).toBe(2)
  }
  const withoutStore = createSharedReadCache({ cache: createStaleWhileRevalidate(null) })
  const unavailable = createSharedReadCache({ cache: createStaleWhileRevalidate(null), available: () => false })
  for (const read of [withoutStore, unavailable]) {
    const result = await read({ ...f.input, etag: first.etag })
    expect(result.state).toBe("bypass")
    expect(result.unchanged).toBe(false)
    expect(result.etag).toBeUndefined()
  }
  f.advance(2000)
  await rejects(f.read({ ...f.input, etag: first.etag, load: async () => { throw new Error("Missing run") } }), /Missing run/)
  const recovered = await f.read({ ...f.input, etag: first.etag })
  expect(recovered.unchanged).toBe(false)
})

test("a post-mutation force read bypasses an older in-flight shared read", async () => {
  const f = fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<{ status: string; score: number }>()
  const pending = f.read({ ...f.input, load: async () => { entered.resolve(); return release.promise } })
  await entered.promise
  f.change()
  const fresh = await f.read({ ...f.input, force: true })
  expect(fresh.state).toBe("bypass")
  if (!fresh.unchanged) expect(fresh.data.score).toBe(2)
  f.advance(1000)
  release.resolve({ status: "running", score: 1 })
  await pending
  // A slow load cannot extend its entry's age from its completion time.
  f.advance(1000)
  const after = await f.read(f.input)
  if (!after.unchanged) expect(after.data.score).toBe(2)
})
