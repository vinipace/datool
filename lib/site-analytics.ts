import type { CloudPlan } from "@/src/lib/billing"

export const analyticsConsentKey = "datool.analytics-consent"
export const analyticsConsentCookie = "datool_analytics"
export const signupCookie = "datool_signup"
export type CheckoutReceipt = {
  transaction_id: string
  value: number
  currency: string
  plan: CloudPlan
}
type AnalyticsWindow = Window & {
  dataLayer?: unknown[]
  gtag?: (...args: unknown[]) => void
}

export function analyticsAllowed() {
  try {
    return localStorage.getItem(analyticsConsentKey) === "granted"
  } catch {
    return false
  }
}

/** Never send workspace identifiers, auth tokens, query strings or page titles. */
export function publicAnalyticsPath(path: string) {
  const pathname = path.split(/[?#]/, 1)[0]
  return (
    pathname === "/" ||
    pathname === "/pricing" ||
    pathname === "/faq" ||
    /^\/(docs|product|pages)(\/|$)/.test(pathname)
  )
}

export function analyticsTag() {
  if (typeof window === "undefined" || !analyticsAllowed()) return undefined
  return (window as AnalyticsWindow).gtag
}

export function initializeAnalytics(id: string) {
  if (!analyticsAllowed()) return
  const target = window as AnalyticsWindow
  target.dataLayer ??= []
  target.gtag ??= function (...args: unknown[]) {
    target.dataLayer!.push(args)
  }
  target.gtag("js", new Date())
  target.gtag("config", id, {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    page_location: `${location.origin}/`,
    page_referrer: "",
    page_title: "Datool",
  })
}

export function trackPageView(path: string) {
  if (!publicAnalyticsPath(path)) return
  const pathname = path.split(/[?#]/, 1)[0]
  let referrer = ""
  try {
    referrer = new URL(document.referrer).origin
  } catch {
    /* No referrer. */
  }
  analyticsTag()?.("event", "page_view", {
    page_location: new URL(pathname, location.origin).href,
    page_title: pathname === "/" ? "Datool" : `Datool ${pathname}`,
    page_referrer: referrer,
  })
}

export function trackSignup() {
  const tag = analyticsTag()
  const method = document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith(`${signupCookie}=`))
    ?.split("=")[1]
  if (!tag || (method !== "google" && method !== "email")) return
  document.cookie = `${signupCookie}=; Path=/; Max-Age=0; SameSite=Lax`
  tag("event", "sign_up", { method })
}

/** Flush before leaving for Stripe; blocked analytics must never block billing. */
async function readyAnalyticsTag() {
  // Billing may finish loading before the root's public configuration request.
  const deadline = Date.now() + 500
  while (analyticsAllowed() && !analyticsTag() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25))
  return analyticsTag()
}

async function conversion(name: string, parameters: Record<string, unknown>) {
  const tag = await readyAnalyticsTag()
  if (!tag) return
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 600)
    try {
      tag("event", name, {
        ...parameters,
        event_timeout: 500,
        event_callback: () => {
          clearTimeout(timer)
          resolve()
        },
      })
    } catch {
      clearTimeout(timer)
      resolve()
    }
  })
}

export function trackCheckout(plan: CloudPlan, amount?: number) {
  return conversion("begin_checkout", {
    currency: "USD",
    ...(amount !== undefined ? { value: amount / 100 } : {}),
    items: [{ item_id: plan, item_name: `Datool ${plan}`, quantity: 1 }],
  })
}

export async function trackPurchase(
  receipt: CheckoutReceipt | null | undefined
) {
  if (!receipt || !(await readyAnalyticsTag())) return
  const key = `datool.purchase:${receipt.transaction_id}`
  try {
    if (localStorage.getItem(key)) return
    localStorage.setItem(key, "sent")
  } catch {
    /* GA also deduplicates purchases by transaction_id. */
  }
  await conversion("purchase", {
    transaction_id: receipt.transaction_id,
    currency: receipt.currency,
    value: receipt.value,
    items: [
      {
        item_id: receipt.plan,
        item_name: `Datool ${receipt.plan}`,
        quantity: 1,
      },
    ],
  })
}
