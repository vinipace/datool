"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { authClient } from "@/lib/auth-client"
import { navigateWorkspace } from "@/lib/workspace-selection"

export function OnboardingAccount({ email }: { email: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function signOut() {
    setBusy(true)
    setError("")
    try {
      const result = await authClient.signOut()
      if (result.error) throw result.error
      navigateWorkspace("/sign-in")
    } catch {
      setError("Unable to sign out. Please try again.")
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0 break-words text-foreground-muted">
          Signed in as {email}
        </p>
        <Button
          variant="link"
          className="h-auto p-0"
          loading={busy}
          onClick={() => void signOut()}
        >
          Sign out
        </Button>
      </div>
      {error ? (
        <Notice variant="error" role="alert">
          {error}
        </Notice>
      ) : null}
    </div>
  )
}
