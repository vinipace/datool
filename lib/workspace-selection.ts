"use client"

import * as React from "react"
import { authClient } from "@/lib/auth-client"

export const ACTIVE_ORGANIZATION_EVENT = "datool-active-organization"

export function navigateWorkspace(destination: string) {
  window.location.assign(destination)
}

export async function selectOrganization(organizationId: string) {
  const result = await authClient.organization.setActive({ organizationId })
  if (result.error) {
    throw new Error(result.error.message ?? "Unable to select organization.")
  }
  try {
    window.localStorage.setItem(
      ACTIVE_ORGANIZATION_EVENT,
      `${organizationId}:${Date.now()}`,
    )
  } catch {
    // Storage may be unavailable; the current tab still navigates safely.
  }
}

export function useOrganizationSessionSync(organizationId: string) {
  React.useEffect(() => {
    let disposed = false
    let checking = false
    async function checkSession() {
      if (checking || document.visibilityState === "hidden") return
      checking = true
      try {
        const result = await authClient.getSession({
          fetchOptions: { cache: "no-store" },
        })
        if (!disposed && !result.error && result.data?.session.activeOrganizationId !== organizationId) {
          window.location.replace("/")
        }
      } catch {
        // A transient connection failure is not an organization change.
      } finally {
        checking = false
      }
    }
    function onPageShow(event: PageTransitionEvent) {
      if (event.persisted) void checkSession()
    }
    function onOrganizationChanged(event: StorageEvent) {
      if (
        event.key === ACTIVE_ORGANIZATION_EVENT &&
        event.newValue &&
        !event.newValue.startsWith(`${organizationId}:`)
      ) {
        window.location.assign("/")
      }
    }
    window.addEventListener("storage", onOrganizationChanged)
    window.addEventListener("focus", checkSession)
    window.addEventListener("pageshow", onPageShow)
    document.addEventListener("visibilitychange", checkSession)
    // Cover a switch that completed before this tab mounted its listener.
    void checkSession()
    return () => {
      disposed = true
      window.removeEventListener("storage", onOrganizationChanged)
      window.removeEventListener("focus", checkSession)
      window.removeEventListener("pageshow", onPageShow)
      document.removeEventListener("visibilitychange", checkSession)
    }
  }, [organizationId])
}
