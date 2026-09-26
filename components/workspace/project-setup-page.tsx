"use client"

import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import Link from "next/link"
import { OnboardingShell } from "@/components/auth/onboarding-shell"
import { RequestStory } from "@/components/cms/landing-visuals"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import { useHydrated } from "@/lib/use-hydrated"
import {
  projectHref,
  workspaceRequest,
  type WorkspaceOrganization,
  type WorkspaceProject,
} from "@/lib/workspace-api"
import {
  navigateWorkspace,
  useOrganizationSessionSync,
} from "@/lib/workspace-selection"

/** First-project setup happens before the project workspace can be entered. */
export function ProjectSetupPage({
  organization,
  canManage = true,
}: {
  organization: WorkspaceOrganization
  canManage?: boolean
}) {
  useOrganizationSessionSync(organization.id)
  const nameId = useId()
  const hydrated = useHydrated()
  const nameInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (hydrated) nameInput.current?.focus()
  }, [hydrated])
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function createProject(event: FormEvent) {
    event.preventDefault()
    if (busy || !canManage || !name.trim()) return
    setBusy(true)
    setError("")
    try {
      const result = await workspaceRequest<{ project: WorkspaceProject }>(
        `/api/organizations/${encodeURIComponent(organization.id)}/projects`,
        { method: "POST", body: JSON.stringify({ name: name.trim() }) }
      )
      navigateWorkspace(projectHref(organization, result.project))
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to create your project. Please try again."
      )
      setBusy(false)
    }
  }

  return (
    <OnboardingShell
      title="Create your first project"
      description={`Give your work in ${organization.name} a home. A project brings your traces, evaluations, and datasets together.`}
      footer={<p>Organization: {organization.name}</p>}
      aside={<RequestStory />}
      hideAsideOnMobile
    >
      {canManage ? (
        <form onSubmit={createProject} className="space-y-5">
          {error ? (
            <Notice variant="error" role="alert">
              {error}
            </Notice>
          ) : null}
          <div className="space-y-2">
            <label htmlFor={nameId} className="text-sm font-medium">
              Project name
            </label>
            <Input
              id={nameId}
              ref={nameInput}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Customer support assistant"
              autoFocus
              required
              maxLength={160}
              disabled={!hydrated || busy}
            />
            <p className="text-xs text-foreground-muted">
              You can rename it anytime.
            </p>
          </div>
          <Button
            type="submit"
            className="w-full"
            loading={busy}
            disabled={!name.trim()}
          >
            Create project
          </Button>
        </form>
      ) : (
        <Notice>
          Ask an organization owner or admin to create your first project.
        </Notice>
      )}
      <Button asChild variant="link" className="mt-6 h-auto self-start p-0">
        <Link href="/organizations">Switch organization</Link>
      </Button>
    </OnboardingShell>
  )
}
