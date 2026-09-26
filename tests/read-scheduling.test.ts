import { setTimeout as sleep } from "node:timers/promises"
import { expect, test } from "bun:test"
import { createReadScheduler } from "@/src/lib/tracer/read-scheduler"
import { acquireRead } from "@/src/server/semantic/read-budget"

test("automatic reads are marked background and queued manual refreshes retain their reason", async () => {
  const reasons: string[] = []
  let finish: (value: number) => void = () => {}
  const scheduler = createReadScheduler({
    intervalMs: 5,
    load: () =>
      new Promise<number>((resolve) => {
        finish = resolve
      }),
    onStart: (reason) => reasons.push(reason),
    onValue: () => {},
    onError: () => {},
  })
  try {
    scheduler.refresh()
    expect(reasons).toEqual(["refresh"])
    finish(1)
    await sleep(20)
    expect(reasons).toEqual(["refresh", "background"])
    scheduler.refresh()
    scheduler.refresh()
    finish(2)
    await Promise.resolve()
    await Promise.resolve()
    expect(reasons).toEqual(["refresh", "background", "refresh"])
  } finally {
    scheduler.stop()
    finish(3)
  }
})

test("single-flight refreshes coalesce and stopping aborts the active request", async () => {
  let finish: (n: number) => void = () => {},
    calls = 0,
    active: AbortSignal | undefined
  const values: number[] = []
  const scheduler = createReadScheduler({
    load: (signal) => {
      active = signal
      calls++
      return new Promise<number>((resolve) => {
        finish = resolve
      })
    },
    onValue: (value) => values.push(value),
    onError: () => {},
  })
  scheduler.refresh()
  scheduler.refresh()
  scheduler.refresh()
  expect(calls).toBe(1)
  finish(1)
  await Promise.resolve()
  await Promise.resolve()
  expect(calls).toBe(2)
  expect(values).toEqual([1])
  scheduler.stop()
  expect(active?.aborted).toBe(true)
  finish(2)
  await Promise.resolve()
  expect(values).toEqual([1])
})

test("hidden views do not poll, visible views resume, terminal views stop polling", async () => {
  let visible = false,
    calls = 0,
    poll = true
  const scheduler = createReadScheduler({
    load: async () => ++calls,
    onValue: () => {},
    onError: () => {},
    intervalMs: 5,
    visible: () => visible,
    shouldPoll: () => poll,
  })
  scheduler.refresh()
  await sleep(25)
  expect(calls).toBe(1)
  visible = true
  scheduler.resume()
  await sleep(2)
  expect(calls).toBe(2)
  poll = false
  await sleep(25)
  expect(calls).toBe(2)
  scheduler.stop()
})

test("admission is tenant-bounded and release is idempotent", () => {
  const a = acquireRead("test-a"),
    b = acquireRead("test-a")
  expect(() => acquireRead("test-a")).toThrow("busy")
  const c = acquireRead("test-b")
  a()
  a()
  const d = acquireRead("test-a")
  b()
  c()
  d()
})

test("terminal views do not resume polling on visibility changes", async () => {
  let calls = 0
  const scheduler = createReadScheduler({
    load: async () => ++calls,
    onValue: () => {},
    onError: () => {},
    shouldPoll: () => false,
  })
  scheduler.refresh()
  await Promise.resolve()
  scheduler.resume()
  await Promise.resolve()
  expect(calls).toBe(1)
  scheduler.stop()
})

test("bounded waiting admits a released slot and preserves another project progress", async () => {
  const { acquireReadAsync } = await import("@/src/server/semantic/read-budget")
  const a = acquireRead("queue-a"),
    b = acquireRead("queue-a")
  const waiters = Array.from({ length: 8 }, () => acquireReadAsync("queue-a"))
  const overflow = await acquireReadAsync("queue-a").then(
    () => false,
    () => true
  )
  expect(overflow).toBe(true)
  const other = await acquireReadAsync("queue-b")
  other()
  a()
  const first = await waiters[0]
  first()
  b()
  for (const waiting of waiters.slice(1)) {
    const release = await waiting
    release()
  }
  const c = acquireRead("queue-c"),
    d = acquireRead("queue-c")
  expect(
    await acquireReadAsync("queue-c", 1).then(
      () => false,
      () => true
    )
  ).toBe(true)
  c()
  d()
  const recovered = await acquireReadAsync("queue-c")
  recovered()
})
