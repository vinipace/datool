"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { authClient } from "@/lib/auth-client"
import {
  projectHref,
  workspaceRequest,
  type WorkspaceOrganization,
  type WorkspaceProject,
} from "@/lib/workspace-api"
import { navigateWorkspace, selectOrganization } from "@/lib/workspace-selection"

export function CreateWorkspaceDialog({
  kind,
  organization,
  open,
  onOpenChange,
  onCreated,
  returnFocusRef,
}: {
  kind: "organization" | "project"
  organization: WorkspaceOrganization
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: () => void
  returnFocusRef?: React.RefObject<HTMLButtonElement | null>
}) {
  const [name, setName] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const inputId = React.useId()

  async function create(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !name.trim()) return
    setBusy(true)
    setError("")
    const slug =
      name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")
        .slice(0, 64) || kind
    try {
      let href: string
      if (kind === "organization") {
        const result = await authClient.organization.create({
          name: name.trim(),
          slug,
        })
        if (result.error) throw result.error
        if (!result.data)
          throw new Error("Organization creation returned no organization.")
        await selectOrganization(result.data.id)
        href = "/projects"
      } else {
        const result = await workspaceRequest<{ project: WorkspaceProject }>(
          `/api/organizations/${encodeURIComponent(organization.id)}/projects`,
          {
            method: "POST",
            body: JSON.stringify({ name: name.trim(), slug }),
          }
        )
        href = projectHref(organization, result.project)
      }
      onCreated?.()
      onOpenChange(false)
      setName("")
      navigateWorkspace(href)
    } catch (cause) {
      setError(
        cause && typeof cause === "object" && "message" in cause
          ? String(cause.message)
          : `Unable to create ${kind}. Try again.`
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          onOpenChange(value)
          setError("")
        }
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        onEscapeKeyDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (!busy) onOpenChange(false)
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocusRef?.current) {
            event.preventDefault()
            returnFocusRef.current.focus()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Create {kind}</DialogTitle>
          <DialogDescription>
            {kind === "project"
              ? `Add a project to ${organization.name}.`
              : "Organize your projects in a new workspace."}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={create}>
          <div className="grid gap-2">
            <label className="text-sm" htmlFor={inputId}>
              {kind === "project" ? "Project" : "Organization"} name
            </label>
            <Input
              id={inputId}
              autoFocus
              required
              maxLength={120}
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              placeholder={
                kind === "project" ? "My project" : "My organization"
              }
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!name.trim()}>
              Create {kind}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
