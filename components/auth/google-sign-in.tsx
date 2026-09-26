"use client"
import Image from "next/image"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { authClient } from "@/lib/auth-client"
export function GoogleSignIn({
  callbackURL = "/",
  errorCallbackURL = "/sign-in",
  enabled: configuredEnabled,
}: {
  callbackURL?: string
  errorCallbackURL?: string
  enabled?: boolean | null
}) {
  const [loadedEnabled, setEnabled] = useState<boolean | null>(null)
  const enabled =
    configuredEnabled === undefined ? loadedEnabled : configuredEnabled
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (configuredEnabled !== undefined) return
    void fetch("/api/auth/config")
      .then((response) => {
        if (!response.ok)
          throw new Error("Unable to load sign-in configuration.")
        return response.json()
      })
      .then((data) => setEnabled(data.google === true))
      .catch(() => setEnabled(false))
  }, [configuredEnabled])
  if (enabled === null)
    return (
      <p role="status" className="mt-6 text-sm text-foreground-muted">
        Loading sign-in…
      </p>
    )
  if (!enabled)
    return (
      <Notice role="alert" variant="warning" className="mt-6">
        Google sign-in is currently unavailable. Please contact your
        administrator.
      </Notice>
    )
  return (
    <div className="mt-6">
      <Button
        type="button"
        size="lg"
        loading={busy}
        className="w-full"
        onClick={async () => {
          setBusy(true)
          setError(undefined)
          try {
            const result = await authClient.signIn.social({
              provider: "google",
              callbackURL,
              errorCallbackURL,
            })
            if (result.error) throw new Error(result.error.message)
          } catch (error) {
            setError(
              error instanceof Error ? error.message : "Google sign-in failed."
            )
            setBusy(false)
          }
        }}
      >
        {!busy && (
          // Official Google Identity brand asset: https://developers.google.com/identity/branding-guidelines
          <Image
            src="/google-logo.png"
            alt=""
            width={20}
            height={20}
            unoptimized
            className="size-5 shrink-0 object-contain"
          />
        )}
        {busy ? "Connecting to Google…" : "Continue with Google"}
      </Button>
      {error && (
        <Notice role="alert" variant="error" className="mt-2">
          {error}
        </Notice>
      )}
    </div>
  )
}
