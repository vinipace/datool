"use client"

import Script from "next/script"
import Link from "next/link"
import { useEffect, useState } from "react"
import { usePathname } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  analyticsConsentKey,
  analyticsConsentCookie,
  initializeAnalytics,
  publicAnalyticsPath,
  trackPageView,
  trackSignup,
} from "@/lib/site-analytics"

export function SiteAnalytics() {
  const path = usePathname()
  const [measurementId, setMeasurementId] = useState<string | null>(null)
  const [consent, setConsent] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void fetch("/api/site-analytics", {
      credentials: "omit",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((config) => {
        try {
          setConsent(localStorage.getItem(analyticsConsentKey) || "unknown")
        } catch {
          setConsent("denied")
        }
        if (
          typeof config?.measurementId === "string" &&
          /^G-[A-Z0-9]+$/.test(config.measurementId)
        )
          setMeasurementId(config.measurementId)
      })
      .catch(() => {
        /* An unavailable analytics config must never affect the page. */
      })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    if (measurementId && consent === "granted")
      initializeAnalytics(measurementId)
  }, [measurementId, consent])
  useEffect(() => {
    if (ready && consent === "granted") {
      trackPageView(path)
      trackSignup()
    }
  }, [ready, path, consent])
  function choose(value: "granted" | "denied") {
    try {
      localStorage.setItem(analyticsConsentKey, value)
    } catch {
      return
    }
    if (measurementId)
      (window as unknown as Record<string, unknown>)[
        `ga-disable-${measurementId}`
      ] = value === "denied"
    document.cookie = `${analyticsConsentCookie}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`
    setConsent(value)
  }
  if (!measurementId) return null
  return (
    <>
      {consent === "granted" && (
        <Script
          id="datool-google-analytics"
          src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`}
          strategy="afterInteractive"
          onReady={() => setReady(true)}
        />
      )}
      {consent === "unknown" && publicAnalyticsPath(path) && (
        <section
          aria-label="Analytics preferences"
          className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-2xl flex-col gap-3 rounded-lg border border-border bg-background p-4 text-foreground shadow-lg sm:flex-row sm:items-center"
        >
          <p className="flex-1 text-sm text-foreground-muted">
            Allow usage analytics to help us improve Datool? We only load Google
            Analytics with your permission.{" "}
            <Link href="/docs/privacy#website-analytics" className="underline">
              Privacy details
            </Link>
          </p>
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => choose("denied")}
            >
              Decline
            </Button>
            <Button size="sm" onClick={() => choose("granted")}>
              Allow analytics
            </Button>
          </div>
        </section>
      )}
      {(consent === "granted" || consent === "denied") &&
        publicAnalyticsPath(path) && (
          <Button
            size="sm"
            variant="outline"
            className="fixed bottom-4 left-4 z-40"
            onClick={() => setConsent("unknown")}
          >
            Analytics preferences
          </Button>
        )}
    </>
  )
}
