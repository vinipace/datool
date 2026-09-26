"use client"

import { useState } from "react"
import { Button } from "@payloadcms/ui"
import { authClient } from "@/lib/auth-client"

export function AdminLogout() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  return (
    <div>
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError(undefined)
          try {
            const result = await authClient.signOut()
            if (result.error) throw new Error(result.error.message)
            window.location.assign("/cms/login")
          } catch {
            setError("Unable to sign out. Please try again.")
            setBusy(false)
          }
        }}
      >
        Sign out of Datool
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
