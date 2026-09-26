"use client"

import { useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { authClient } from "@/lib/auth-client"
import type { WorkspaceOrganization } from "@/lib/workspace-api"
import { organizationDetailsSchema } from "@/src/lib/organization-settings"
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
import { SettingsShell } from "./settings-shell"

export function OrganizationSettingsPage({
  organization,
  canManage,
  embedded = false,
}: {
  organization: WorkspaceOrganization
  canManage: boolean
  embedded?: boolean
}) {
  const router = useRouter()
  const [saved, setSaved] = useState(organization)
  const [name, setName] = useState(organization.name)
  const [slug, setSlug] = useState(organization.slug)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState(false)
  const details = { name: name.trim(), slug: slug.trim().toLowerCase() }
  const dirty = details.name !== saved.name || details.slug !== saved.slug
  const valid = organizationDetailsSchema.safeParse(details).success

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canManage || pending || !dirty || !valid) return
    setPending(true)
    setError("")
    setSuccess(false)
    try {
      const result = await authClient.organization.update({
        organizationId: organization.id,
        data: details,
      })
      if (result.error)
        throw new Error(
          result.error.message || "Unable to save organization settings."
        )
      if (!result.data)
        throw new Error("Unable to confirm the saved organization. Try again.")
      const updated = {
        id: result.data.id,
        name: result.data.name,
        slug: result.data.slug,
      }
      setSaved(updated)
      setName(updated.name)
      setSlug(updated.slug)
      setSuccess(true)
      router.refresh()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to save organization settings. Try again."
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <SettingsShell
      title="General"
      backHref="/projects"
      organization={saved}
      embedded={embedded}
    >
      <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
        <Card>
          <CardHeader>
            <CardTitle>Organization details</CardTitle>
            <CardDescription>
              Manage your organization’s name and identifier.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-5">
            <form className="space-y-5" onSubmit={(event) => void save(event)}>
              {!canManage && (
                <Notice>
                  Only organization owners and admins can change these settings.
                </Notice>
              )}
              <div className="space-y-2">
                <label
                  htmlFor="organization-name"
                  className="text-sm font-medium"
                >
                  Organization name
                </label>
                <Input
                  id="organization-name"
                  value={name}
                  required
                  maxLength={160}
                  disabled={!canManage || pending}
                  onChange={(event) => {
                    setName(event.target.value)
                    setSuccess(false)
                    setError("")
                  }}
                />
              </div>
              <div className="space-y-2">
                <label
                  htmlFor="organization-slug"
                  className="text-sm font-medium"
                >
                  Organization slug
                </label>
                <Input
                  id="organization-slug"
                  value={slug}
                  required
                  maxLength={120}
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-describedby="organization-slug-help"
                  disabled={!canManage || pending}
                  onChange={(event) => {
                    setSlug(event.target.value.toLowerCase())
                    setSuccess(false)
                    setError("")
                  }}
                />
                <p
                  id="organization-slug-help"
                  className="text-xs text-foreground-muted"
                >
                  A unique identifier using lowercase letters, numbers, and
                  hyphens.
                </p>
              </div>
              {error && (
                <Notice variant="error" role="alert">
                  {error}
                </Notice>
              )}
              {success && (
                <Notice variant="success" role="status">
                  Organization settings saved.
                </Notice>
              )}
              {canManage && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    loading={pending}
                    disabled={!dirty || !valid}
                  >
                    {pending ? "Saving…" : "Save changes"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending || !dirty}
                    onClick={() => {
                      setName(saved.name)
                      setSlug(saved.slug)
                      setError("")
                      setSuccess(false)
                    }}
                  >
                    Reset changes
                  </Button>
                </div>
              )}
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Organization ID</CardTitle>
            <CardDescription>
              This permanent identifier stays the same when you rename your
              organization.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-5">
            <Input
              aria-label="Organization ID"
              value={organization.id}
              readOnly
              className="font-mono text-xs"
            />
          </CardContent>
        </Card>
      </div>
    </SettingsShell>
  )
}
