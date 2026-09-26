"use client"

import { useState } from "react"
import { Button } from "@payloadcms/ui"
import { authClient } from "@/lib/auth-client"

// Payload owns the admin CSS; avoid importing product Tailwind into its root layout.
export function AdminLogin() {
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  return (
    <div>
      <p>
        Sign in with your Datool Google account. CMS access requires an editor
        invitation.
      </p>
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError(undefined)
          try {
            const result = await authClient.signIn.social({
              provider: "google",
              callbackURL: "/cms",
              errorCallbackURL: "/cms/login",
            })
            if (result.error) throw new Error(result.error.message)
          } catch (error) {
            setError(
              error instanceof Error ? error.message : "Unable to sign in."
            )
            setBusy(false)
          }
        }}
      >
        {busy ? "Connecting…" : "Continue with Google"}
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
