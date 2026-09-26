"use client"

import { useState } from "react"
import Link from "next/link"
import { AuthShell } from "@/components/auth/auth-shell"
import { GoogleSignIn } from "@/components/auth/google-sign-in"
import { Notice } from "@/components/ui/notice"
import { Button } from "@/components/ui/button"
import { authClient } from "@/lib/auth-client"
import {
  navigateWorkspace,
  selectOrganization,
} from "@/lib/workspace-selection"

export type InvitationView =
  | { kind: "sign-in" }
  | { kind: "wrong-account"; email: string }
  | { kind: "unavailable" }
  | { kind: "ready"; email: string; organizationName: string; role: string }
export function InvitationPage({
  id,
  invitation,
}: {
  id: string
  invitation: InvitationView
}) {
  const [busy, setBusy] = useState<"accept" | "reject" | "sign-out" | null>(
    null
  )
  const [error, setError] = useState("")
  const [declined, setDeclined] = useState(false)
  const destination = `/invite/${encodeURIComponent(id)}`
  async function respond(action: "accept" | "reject") {
    if (busy) return
    setBusy(action)
    setError("")
    try {
      if (action === "accept") {
        const result = await authClient.organization.acceptInvitation({
          invitationId: id,
        })
        if (result.error) throw new Error(result.error.message)
        await selectOrganization(result.data.invitation.organizationId)
        navigateWorkspace("/projects")
      } else {
        const result = await authClient.organization.rejectInvitation({
          invitationId: id,
        })
        if (result.error) throw new Error(result.error.message)
        setDeclined(true)
      }
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to respond to this invitation. Try again."
      )
    } finally {
      setBusy(null)
    }
  }
  async function switchAccount() {
    setBusy("sign-out")
    setError("")
    try {
      const result = await authClient.signOut()
      if (result.error) throw new Error(result.error.message)
      navigateWorkspace(destination)
    } catch {
      setError("Unable to sign out. Try again.")
      setBusy(null)
    }
  }
  return (
    <AuthShell
      title={
        declined
          ? "Invitation declined"
          : invitation.kind === "ready"
            ? `Join ${invitation.organizationName}`
            : "Your Datool invitation"
      }
      description={
        declined
          ? "You haven’t joined this organization."
          : "Join your team’s existing workspace."
      }
    >
      <div className="space-y-4 pt-4">
        {error ? (
          <Notice variant="error" role="alert">
            {error}
          </Notice>
        ) : null}
        {declined ? (
          <Button asChild variant="outline">
            <Link href="/projects">Back to Datool</Link>
          </Button>
        ) : invitation.kind === "sign-in" ? (
          <>
            <p className="text-sm text-foreground-muted">
              Sign in with the Google account matching the email address that
              received this invitation. You’ll review the invitation before
              joining.
            </p>
            <GoogleSignIn callbackURL={destination} />
          </>
        ) : invitation.kind === "wrong-account" ? (
          <>
            <Notice variant="warning">
              You’re signed in as {invitation.email}. This invitation requires
              the verified email address it was sent to.
            </Notice>
            <Button
              onClick={() => void switchAccount()}
              loading={busy === "sign-out"}
            >
              Use a different account
            </Button>
          </>
        ) : invitation.kind === "unavailable" ? (
          <>
            <Notice>
              This invitation has expired, was canceled, or has already been
              used. Ask an organization admin to send a new invitation.
            </Notice>
            <Button asChild variant="outline">
              <Link href="/projects">Back to Datool</Link>
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-foreground-muted">
              You’re signed in as {invitation.email}. You’ll join as{" "}
              <strong className="text-foreground">{invitation.role}</strong> and
              have access to this organization’s projects. You don’t need a
              separate subscription.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button
                onClick={() => void respond("accept")}
                disabled={!!busy}
                loading={busy === "accept"}
              >
                Accept invitation
              </Button>
              <Button
                variant="outline"
                onClick={() => void respond("reject")}
                disabled={!!busy}
                loading={busy === "reject"}
              >
                Decline
              </Button>
            </div>
          </>
        )}
      </div>
    </AuthShell>
  )
}
