import { afterEach, expect, test } from "bun:test"
import {
  emitProductEvent,
  type ProductEvent,
} from "../src/server/product-events"

const event: ProductEvent = {
  type: "subscription.activated",
  organizationName: "Test <@everyone> & team",
  subscriptionId: "sub_fixture",
  plan: "core",
  amountPaid: 2900,
  currency: "usd",
  livemode: false,
}
const originalToken = process.env.SLACK_BOT_TOKEN
const originalChannel = process.env.SLACK_SUBSCRIPTIONS_CHANNEL
const originalFetch = globalThis.fetch
const originalError = console.error
afterEach(() => {
  globalThis.fetch = originalFetch
  console.error = originalError
  if (originalToken === undefined)
    delete process.env.SLACK_BOT_TOKEN
  else process.env.SLACK_BOT_TOKEN = originalToken
  if (originalChannel === undefined)
    delete process.env.SLACK_SUBSCRIPTIONS_CHANNEL
  else process.env.SLACK_SUBSCRIPTIONS_CHANNEL = originalChannel
})
function configure() {
  process.env.SLACK_BOT_TOKEN = "fixture-secret"
  process.env.SLACK_SUBSCRIPTIONS_CHANNEL = "CFIXTURE"
}
test("internal notifications are optional and perform no network call when disabled", async () => {
  delete process.env.SLACK_BOT_TOKEN
  delete process.env.SLACK_SUBSCRIPTIONS_CHANNEL
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    throw new Error("unexpected request")
  }) as typeof fetch
  expect(await emitProductEvent(event)).toBe("disabled")
  process.env.SLACK_BOT_TOKEN = "fixture-secret"
  expect(await emitProductEvent(event)).toBe("disabled")
  expect(calls).toBe(0)
})
test("subscription reaction formats paid activation and escapes Slack mentions", async () => {
  configure()
  const calls: [unknown, RequestInit | undefined][] = []
  globalThis.fetch = (async (url, init) => {
    calls.push([url, init])
    return Response.json({ ok: true, channel: "CFIXTURE", ts: "1.01" })
  }) as typeof fetch
  expect(await emitProductEvent(event)).toBe("sent")
  const [url, init] = calls[0]
  expect(url).toBe("https://slack.com/api/chat.postMessage")
  expect(init?.signal).toBeInstanceOf(AbortSignal)
  const payload = JSON.parse(init?.body as string)
  expect(payload.text).toContain("$29.00")
  expect(payload.text).toContain("Stripe test mode")
  expect(payload.text).toContain("&lt;@everyone&gt; &amp; team")
  expect(payload.text).toContain(
    "https://dashboard.stripe.com/test/subscriptions/sub_fixture"
  )
  expect(payload).toMatchObject({
    channel: "CFIXTURE",
    unfurl_links: false,
    unfurl_media: false,
  })
})
test("Slack HTTP errors, API errors and timeouts cannot fail a product action or expose secrets", async () => {
  configure()
  const logs: unknown[][] = []
  console.error = (...args: unknown[]) => {
    logs.push(args)
  }
  const responses = [
    new Response("fixture-secret", { status: 429 }),
    Response.json({ ok: false, error: "fixture-secret" }),
  ]
  globalThis.fetch = (async () => {
    const response = responses.shift()
    if (!response) throw new Error("fixture-secret")
    return response
  }) as typeof fetch
  for (let i = 0; i < 3; i++)
    expect(await emitProductEvent(event)).toBe("failed")
  expect(logs).toHaveLength(3)
  expect(JSON.stringify(logs)).not.toContain("fixture-secret")
  expect(JSON.stringify(logs)).not.toContain(event.organizationName)
})
