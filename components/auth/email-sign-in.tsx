"use client"

import { useId, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import { authClient } from "@/lib/auth-client"
import { authErrorMessage } from "@/lib/auth-error"

export function EmailSignIn({
  callbackURL,
  errorCallbackURL,
}: {
  callbackURL: string
  errorCallbackURL: string
}) {
  const id = useId()
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [sentEmail, setSentEmail] = useState<string>()
  const [error, setError] = useState<string>()

  return (
    <form
      className="mt-6 grid gap-3"
      onSubmit={async (event) => {
        event.preventDefault()
        if (busy) return
        setBusy(true)
        setError(undefined)
        setSentEmail(undefined)
        const address = email.trim().toLowerCase()
        try {
          const result = await authClient.signIn.magicLink({
            email: address,
            callbackURL,
            newUserCallbackURL: callbackURL,
            errorCallbackURL,
          })
          if (result.error) {
            setError(
              result.error.status === 429
                ? "Too many requests. Please wait a minute before trying again."
                : authErrorMessage(result.error, "sign-in")
            )
          } else {
            setSentEmail(address)
          }
        } catch (error) {
          setError(authErrorMessage(error, "sign-in"))
        } finally {
          setBusy(false)
        }
      }}
    >
      <label htmlFor={id} className="text-sm font-medium">
        Email address
      </label>
      <Input
        id={id}
        name="email"
        type="email"
        autoComplete="email"
        placeholder="you@company.com"
        required
        value={email}
        disabled={busy}
        onChange={(event) => {
          setEmail(event.target.value)
          setSentEmail(undefined)
          setError(undefined)
        }}
      />
      <Button type="submit" size="lg" loading={busy} className="w-full">
        {busy ? "Sending link…" : "Send sign-in link"}
      </Button>
      {error && (
        <Notice role="alert" variant="error">
          {error}
        </Notice>
      )}
      {sentEmail && (
        <Notice role="status" variant="success">
          Check your inbox. We sent a sign-in link to{" "}
          <span className="font-medium break-all">{sentEmail}</span>. The link
          expires in 10 minutes.
        </Notice>
      )}
    </form>
  )
}
