import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  analyticsConsentKey,
  initializeAnalytics,
  trackCheckout,
  trackPageView,
  trackPurchase,
  trackSignup,
} from "../lib/site-analytics"

describe("consented website analytics transport", () => {
  const originals = new Map<string, PropertyDescriptor | undefined>()
  let storage: Map<string, string>
  let sent: unknown[][]
  let cookie: string
  beforeEach(() => {
    storage = new Map()
    sent = []
    cookie = "datool_signup=google"
    const fake = {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      location: { origin: "https://www.trydatool.com" },
      document: {
        referrer: "https://www.google.com/search?q=private",
        get cookie() {
          return cookie
        },
        set cookie(value: string) {
          cookie = value.includes("Max-Age=0") ? "" : value
        },
      },
      window: {
        gtag: (...args: unknown[]) => {
          sent.push(args)
          ;(
            args[2] as { event_callback?: () => void } | undefined
          )?.event_callback?.()
        },
      },
    }
    for (const [key, value] of Object.entries(fake)) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
      Object.defineProperty(globalThis, key, { configurable: true, value })
    }
  })
  afterEach(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  test("declining analytics never sends page views or conversions and never blocks checkout", async () => {
    initializeAnalytics("G-TEST")
    trackPageView("/")
    trackSignup()
    await trackCheckout("pro", 19900)
    await trackPurchase({
      transaction_id: "paid",
      value: 199,
      currency: "USD",
      plan: "pro",
    })
    expect(sent).toEqual([])
    expect(cookie).toBe("datool_signup=google")
  })
  test("the Google tag receives Arguments commands when no tag already exists", () => {
    storage.set(analyticsConsentKey, "granted")
    Reflect.deleteProperty(window, "gtag")
    initializeAnalytics("G-TEST")
    trackPageView("/docs")
    const queue = (window as unknown as { dataLayer: IArguments[] }).dataLayer
    expect(queue).toHaveLength(3)
    for (const command of queue) {
      expect(Object.prototype.toString.call(command)).toBe("[object Arguments]")
      expect(Array.isArray(command)).toBe(false)
    }
    expect(Array.from(queue[1])).toMatchObject([
      "config",
      "G-TEST",
      { send_page_view: false },
    ])
    expect(Array.from(queue[2])).toMatchObject([
      "event",
      "page_view",
      { page_location: "https://www.trydatool.com/docs" },
    ])
  })
  test("only public paths are measured and query strings, fragments and referrer queries stay private", () => {
    storage.set(analyticsConsentKey, "granted")
    for (const path of [
      "/p/secret/traces",
      "/chat/private",
      "/sign-in?token=secret",
      "/billing?checkout=success",
    ])
      trackPageView(path)
    expect(sent).toEqual([])
    trackPageView("/docs?token=secret#private")
    expect(sent).toEqual([
      [
        "event",
        "page_view",
        {
          page_location: "https://www.trydatool.com/docs",
          page_title: "Datool /docs",
          page_referrer: "https://www.google.com",
        },
      ],
    ])
  })
  test("a new-account marker produces one signup, without user identifiers", () => {
    storage.set(analyticsConsentKey, "granted")
    trackSignup()
    trackSignup()
    expect(sent).toEqual([["event", "sign_up", { method: "google" }]])
  })
  test("checkout flushes its event and repeated purchase receipts are deduplicated", async () => {
    storage.set(analyticsConsentKey, "granted")
    await trackCheckout("pro", 19900)
    const receipt = {
      transaction_id: "opaque-hash",
      value: 199,
      currency: "USD",
      plan: "pro" as const,
    }
    await trackPurchase(receipt)
    await trackPurchase(receipt)
    expect(sent.map((args) => args[1])).toEqual(["begin_checkout", "purchase"])
    expect(sent[0][2]).toMatchObject({
      value: 199,
      currency: "USD",
      items: [{ item_id: "pro", quantity: 1 }],
    })
    expect(sent[1][2]).toMatchObject({
      transaction_id: "opaque-hash",
      value: 199,
    })
  })
})
