"use client"

import { useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import {
  projectWorkspaceHref,
  workspaceRequest,
  type WorkspaceOrganization,
  type WorkspaceProject,
} from "@/lib/workspace-api"

type SettingsProject = Pick<WorkspaceProject, "id" | "name" | "slug">

export function ProjectSettingsPage({
  organization,
  project,
  canManage,
}: {
  organization: WorkspaceOrganization
  project: SettingsProject
  canManage: boolean
}) {
  const router = useRouter()
  const [saved, setSaved] = useState(project)
  const [name, setName] = useState(project.name)
  const [slug, setSlug] = useState(project.slug)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const normalizedSlug = slug.trim().toLowerCase()
  const dirty = name.trim() !== saved.name || normalizedSlug !== saved.slug
  const valid =
    name.trim().length > 0 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedSlug)

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canManage || pending || !dirty || !valid) return
    setPending(true)
    setError(null)
    setSuccess(false)
    try {
      const result = await workspaceRequest<{ project: SettingsProject }>(
        `/api/projects/${encodeURIComponent(project.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ name: name.trim(), slug: normalizedSlug }),
        }
      )
      setSaved(result.project)
      setName(result.project.name)
      setSlug(result.project.slug)
      setSuccess(true)
      if (result.project.slug !== project.slug) {
        router.replace(
          `${projectWorkspaceHref(organization, result.project)}/settings`
        )
      } else {
        router.refresh()
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to save project settings. Try again."
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
        <Card>
          <CardHeader>
            <CardTitle>Project details</CardTitle>
            <CardDescription>
              Manage how this project appears in {organization.name}.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-5">
            <form className="space-y-5" onSubmit={(event) => void save(event)}>
              {!canManage && (
                <Notice>
                  Only organization owners and admins can change project
                  settings.
                </Notice>
              )}
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="project-name">
                  Project name
                </label>
                <Input
                  id="project-name"
                  value={name}
                  required
                  maxLength={160}
                  disabled={!canManage || pending}
                  onChange={(event) => {
                    setName(event.target.value)
                    setSuccess(false)
                  }}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="project-slug">
                  Project slug
                </label>
                <Input
                  id="project-slug"
                  value={slug}
                  required
                  maxLength={120}
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-describedby="project-slug-help"
                  disabled={!canManage || pending}
                  onChange={(event) => {
                    setSlug(event.target.value.toLowerCase())
                    setSuccess(false)
                  }}
                />
                <p
                  id="project-slug-help"
                  className="text-xs text-foreground-muted"
                >
                  Use lowercase letters, numbers and hyphens. Changing the slug
                  changes this project’s URL; existing links will stop working.
                </p>
              </div>
              {error && (
                <Notice variant="error" role="alert">
                  {error}
                </Notice>
              )}
              {success && (
                <Notice variant="success" role="status">
                  Project settings saved.
                </Notice>
              )}
              {canManage && (
                <Button
                  type="submit"
                  size="sm"
                  loading={pending}
                  disabled={!dirty || !valid}
                >
                  {pending ? "Saving…" : "Save changes"}
                </Button>
              )}
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Project ID</CardTitle>
            <CardDescription>
              Use this identifier when connecting an SDK or integration. It
              stays the same when you rename the project.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-5">
            <Input
              aria-label="Project ID"
              value={project.id}
              readOnly
              className="font-mono text-xs"
            />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
