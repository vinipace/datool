"use client"

import { useId, useState } from "react"
import { authClient } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"

export function PasswordSignIn({ callbackURL }: { callbackURL: string }) {
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  if (!expanded)
    return (
      <Button
        variant="ghost"
        className="mt-4 w-full"
        onClick={() => setExpanded(true)}
      >
        Sign in with a password
      </Button>
    )
  return (
    <form
      className="mt-6 grid gap-3"
      onSubmit={async (event) => {
        event.preventDefault()
        if (busy) return
        const form = new FormData(event.currentTarget)
        setBusy(true)
        setError(undefined)
        try {
          const result = await authClient.signIn.email({
            email: String(form.get("email")).trim().toLowerCase(),
            password: String(form.get("password")),
            callbackURL,
          })
          if (result.error) {
            setError(
              result.error.status === 429
                ? "Too many requests. Please wait a minute before trying again."
                : "Unable to sign in. Check your email and password, or use another sign-in method."
            )
          } else {
            window.location.assign(callbackURL)
          }
        } catch {
          setError("Unable to sign in. Please try again.")
        } finally {
          setBusy(false)
        }
      }}
    >
      <label htmlFor={`${id}-email`} className="text-sm font-medium">
        Email address
      </label>
      <Input
        id={`${id}-email`}
        name="email"
        type="email"
        autoComplete="username"
        required
        disabled={busy}
      />
      <label htmlFor={`${id}-password`} className="text-sm font-medium">
        Password
      </label>
      <Input
        id={`${id}-password`}
        name="password"
        type="password"
        autoComplete="current-password"
        required
        maxLength={128}
        disabled={busy}
      />
      <Button type="submit" size="lg" loading={busy} className="w-full">
        Sign in
      </Button>
      {error && (
        <Notice role="alert" variant="error">
          {error}
        </Notice>
      )}
    </form>
  )
}
