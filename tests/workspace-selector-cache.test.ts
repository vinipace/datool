import { afterEach, expect, test } from "bun:test"
import { QueryObserver } from "@tanstack/react-query"
import {
  createWorkspaceSelectorClient,
  workspaceSelectorKeys as keys,
} from "@/lib/workspace-selector-cache"

const clients: ReturnType<typeof createWorkspaceSelectorClient>[] = []
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
function client() {
  const value = createWorkspaceSelectorClient()
  clients.push(value)
  return value
}
afterEach(() => {
  for (const value of clients.splice(0)) value.clear()
})

test("reopening a selector reuses its pending request and successful empty result", async () => {
  const cache = client()
  const pending = Promise.withResolvers<string[]>()
  let requests = 0
  const options = {
    queryKey: keys.organizations,
    queryFn: () => {
      requests++
      return pending.promise
    },
  }
  const observer = new QueryObserver(cache, { ...options, enabled: false })
  const unsubscribe = observer.subscribe(() => {})
  expect(requests).toBe(0)
  observer.setOptions({ ...options, enabled: true })
  expect(observer.getCurrentResult().isLoading).toBe(true)
  observer.setOptions({ ...options, enabled: false })
  observer.setOptions({ ...options, enabled: true })
  expect(requests).toBe(1)
  pending.resolve([])
  await settle()
  for (let i = 0; i < 3; i++) {
    observer.setOptions({ ...options, enabled: false })
    observer.setOptions({ ...options, enabled: true })
    expect(observer.getCurrentResult().data).toEqual([])
    expect(observer.getCurrentResult().isLoading).toBe(false)
  }
  expect(requests).toBe(1)
  unsubscribe()
})

test("stale revalidation and refresh errors preserve rows, and retry recovers", async () => {
  const cache = client()
  const queryKey = keys.projectSearch("one", "")
  cache.setQueryData(queryKey, ["Existing"], { updatedAt: Date.now() - 61_000 })
  const pending = Promise.withResolvers<string[]>()
  const options = { queryKey, queryFn: () => pending.promise }
  const observer = new QueryObserver(cache, { ...options, enabled: false })
  const unsubscribe = observer.subscribe(() => {})
  observer.setOptions({ ...options, enabled: true })
  expect(observer.getCurrentResult().data).toEqual(["Existing"])
  expect(observer.getCurrentResult().isLoading).toBe(false)
  expect(observer.getCurrentResult().isFetching).toBe(true)
  pending.reject(new Error("Offline"))
  await settle()
  expect(observer.getCurrentResult().data).toEqual(["Existing"])
  expect(observer.getCurrentResult().error?.message).toBe("Offline")
  observer.setOptions({ queryKey, queryFn: async () => ["Updated"] })
  await observer.refetch()
  expect(observer.getCurrentResult().data).toEqual(["Updated"])
  expect(observer.getCurrentResult().error).toBe(null)
  unsubscribe()
})

test("search resets reuse the unfiltered page without mixing organizations or queries", async () => {
  const cache = client()
  let requests = 0
  const options = (organizationId: string, search: string) => ({
    queryKey: keys.projectSearch(organizationId, search),
    queryFn: async () => {
      requests++
      return [`${organizationId}:${search.trim() || "All"}`]
    },
  })
  const observer = new QueryObserver(cache, options("one", ""))
  const unsubscribe = observer.subscribe(() => {})
  await settle()
  observer.setOptions(options("one", "Filtered"))
  expect(observer.getCurrentResult().data).toBeUndefined()
  await settle()
  expect(observer.getCurrentResult().data).toEqual(["one:Filtered"])
  observer.setOptions({ ...options("one", ""), enabled: false })
  observer.setOptions(options("one", ""))
  expect(observer.getCurrentResult().data).toEqual(["one:All"])
  expect(observer.getCurrentResult().isLoading).toBe(false)
  expect(requests).toBe(2)
  observer.setOptions(options("two", ""))
  expect(observer.getCurrentResult().data).toBeUndefined()
  await settle()
  expect(observer.getCurrentResult().data).toEqual(["two:All"])
  observer.setOptions(options("one", " Filtered "))
  expect(observer.getCurrentResult().data).toEqual(["one:Filtered"])
  expect(requests).toBe(3)
  unsubscribe()
})

test("creation invalidates every cached search for its organization only", async () => {
  const cache = client()
  const all = keys.projectSearch("one", "")
  const search = keys.projectSearch("one", "Filtered")
  const other = keys.projectSearch("two", "")
  for (const queryKey of [all, search, other, keys.organizations]) {
    cache.setQueryData(queryKey, ["Existing"])
  }
  await cache.invalidateQueries({ queryKey: keys.projects("one") })
  expect(cache.getQueryState(all)?.isInvalidated).toBe(true)
  expect(cache.getQueryState(search)?.isInvalidated).toBe(true)
  expect(cache.getQueryState(other)?.isInvalidated).toBe(false)
  expect(cache.getQueryState(keys.organizations)?.isInvalidated).toBe(false)
  const observer = new QueryObserver(cache, {
    queryKey: all,
    queryFn: async () => ["Existing", "Created"],
  })
  const unsubscribe = observer.subscribe(() => {})
  expect(observer.getCurrentResult().data).toEqual(["Existing"])
  await settle()
  expect(observer.getCurrentResult().data).toEqual(["Existing", "Created"])
  expect(client().getQueryData(all)).toBeUndefined()
  unsubscribe()
})
