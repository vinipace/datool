import { afterEach, expect, test } from "bun:test"
import assert from "node:assert/strict"
import {
  DashboardRequestError,
  retryDashboardMetricRead,
} from "@/src/lib/tracer/dashboard-read-retry"
import { dashboardRequest } from "@/components/tracer/dashboard-utils"
import { ReadBudgetError } from "@/src/server/semantic/read-budget"
import { semanticErrorToTracerError } from "@/src/server/semantic/errors"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
const busy = (retryAfter = "1") =>
  new DashboardRequestError("Busy", 429, "READ_BUSY", retryAfter)
const fakeClock = () => {
  let now = Date.parse("2026-09-22T12:00:00Z")
  const delays: number[] = []
  return {
    delays,
    now: () => now,
    random: () => 0.5,
    wait: async (ms: number) => {
      delays.push(ms)
      now += ms
    },
  }
}

test("busy metric reads recover, respect Retry-After, and keep exponential backoff", async () => {
  const clock = fakeClock()
  let calls = 0
  const value = await retryDashboardMetricRead(
    async () => {
      if (++calls < 4) throw busy("2")
      return "ready"
    },
    undefined,
    clock
  )
  expect(value).toBe("ready")
  expect(calls).toBe(4)
  expect(clock.delays).toEqual([2125, 2125, 2125])
})

test("persistent busy reads stop after five attempts and oversized Retry-After is not ignored", async () => {
  const clock = fakeClock()
  let calls = 0
  await assert.rejects(
    retryDashboardMetricRead(
      async () => {
        calls++
        throw busy("0")
      },
      undefined,
      clock
    ),
    { message: "Busy" }
  )
  expect(calls).toBe(5)
  expect(clock.delays).toEqual([625, 1125, 2125, 4125])
  const long = fakeClock()
  await assert.rejects(
    retryDashboardMetricRead(
      async () => {
        throw busy("60")
      },
      undefined,
      long
    ),
    { message: "Busy" }
  )
  expect(long.delays).toEqual([])
})

test("HTTP-date Retry-After and elapsed query time count toward the retry deadline", async () => {
  const clock = fakeClock()
  let calls = 0
  await retryDashboardMetricRead(
    async () => {
      if (++calls === 1) throw busy(new Date(clock.now() + 3000).toUTCString())
      return true
    },
    undefined,
    clock
  )
  expect(clock.delays).toEqual([3125])
  const slow = fakeClock()
  calls = 0
  await assert.rejects(
    retryDashboardMetricRead(
      async () => {
        calls++
        await slow.wait(7000)
        throw busy()
      },
      undefined,
      slow
    ),
    { message: "Busy" }
  )
  expect(calls).toBe(2)
  const suspended = fakeClock()
  calls = 0
  await assert.rejects(
    retryDashboardMetricRead(
      async () => {
        calls++
        throw busy()
      },
      undefined,
      { ...suspended, wait: () => suspended.wait(20000) }
    ),
    { message: "Busy" }
  )
  expect(calls).toBe(1)
})

test("other failures are never retried", async () => {
  for (const error of [
    new Error("Network"),
    new DashboardRequestError("Unauthorized", 401),
    new DashboardRequestError("Rate limited", 429, "RATE_LIMITED"),
    new DashboardRequestError("Timeout", 504, "READ_TIMEOUT"),
  ]) {
    const clock = fakeClock()
    await assert.rejects(
      retryDashboardMetricRead(
        async () => {
          throw error
        },
        undefined,
        clock
      ),
      (caught) => caught === error
    )
    expect(clock.delays).toEqual([])
  }
})

test("cancelling during backoff prevents any later request", async () => {
  const controller = new AbortController()
  let calls = 0
  const pending = retryDashboardMetricRead(async () => {
    calls++
    setTimeout(() => controller.abort(), 20)
    throw busy()
  }, controller.signal)
  await assert.rejects(pending, { name: "AbortError" })
  expect(calls).toBe(1)
})

test("busy dashboard mutations are not replayed", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return Response.json(
      { error: { code: "READ_BUSY", message: "Busy" } },
      { status: 429, headers: { "Retry-After": "0" } }
    )
  }) as typeof fetch
  await assert.rejects(
    dashboardRequest("/api/dashboards", "POST", { name: "New dashboard" }),
    { message: "Busy" }
  )
  expect(calls).toBe(1)
})

test("semantic busy errors preserve the one-second retry hint", () => {
  const error = semanticErrorToTracerError(
    new ReadBudgetError("READ_BUSY", "Busy")
  )
  expect(error.status).toBe(429)
  expect(error.details).toEqual({ retryAfterSeconds: 1 })
})
