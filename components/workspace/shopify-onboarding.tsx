"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Notice } from "@/components/ui/notice"
import { RadioCard } from "@/components/ui/radio-card"
import { Checkbox } from "@/components/ui/checkbox"
import Link from "next/link"
import { SHOPIFY_PRIVACY_VERSION } from "@/src/lib/shopify-privacy"
import { authClient } from "@/lib/auth-client"
import { workspaceRequest } from "@/lib/workspace-api"
import {
  selectOrganization,
  navigateWorkspace,
} from "@/lib/workspace-selection"

type Organization = {
  id: string
  name: string
  projects: { id: string; name: string }[]
}
export function ShopifyOnboarding({
  shop,
  source,
  organizations,
  projectId,
}: {
  shop: string
  source: "datool" | "shopify"
  organizations: Organization[]
  projectId?: string
}) {
  const [options, setOptions] = useState(organizations)
  const [organizationId, setOrganizationId] = useState(
    organizations.find((o) => o.projects.some((p) => p.id === projectId))?.id ??
      ""
  )
  const [project, setProject] = useState(projectId ?? "")
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [privacyAccepted, setPrivacyAccepted] = useState(false)
  const selected = options.find((o) => o.id === organizationId)
  async function connect() {
    if (busy || !privacyAccepted) return
    setBusy(true)
    setError("")
    try {
      let id = organizationId
      if (!id) {
        const result = await authClient.organization.create({
          name: name.trim(),
          slug: `shopify-${crypto.randomUUID().slice(0, 12)}`,
        })
        if (result.error || !result.data)
          throw new Error(
            result.error?.message ?? "Unable to create organization."
          )
        id = result.data.id
        setOptions((old) => [
          ...old,
          { id, name: result.data!.name, projects: [] },
        ])
        setOrganizationId(id)
      }
      const result = await workspaceRequest<{ url: string }>(
        "/api/shopify/claim",
        {
          method: "POST",
          body: JSON.stringify({
            organizationId: id,
            privacyPolicyVersion: SHOPIFY_PRIVACY_VERSION,
            ...(project ? { projectId: project } : {}),
          }),
        }
      )
      await selectOrganization(id)
      navigateWorkspace(result.url)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to connect Shopify."
      )
      setBusy(false)
    }
  }
  return (
    <main className="mx-auto max-w-xl space-y-6 px-4 py-10 sm:px-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Connect Shopify to Datool</h1>
        <p className="text-sm text-foreground-muted">{shop}</p>
      </div>
      <Notice>
        {source === "datool"
          ? "Your store will keep your current billing setup."
          : "Already paying Datool? Choose that organization to keep your current billing. New Shopify subscriptions are managed through Shopify."}
      </Notice>
      {error ? (
        <Notice variant="error" role="alert">
          {error}
        </Notice>
      ) : null}
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault()
          void connect()
        }}
      >
        <fieldset className="space-y-3" disabled={busy}>
          <legend className="mb-3 text-sm font-medium">
            Choose an organization
          </legend>
          {options
            .filter(
              (o) => !projectId || o.projects.some((p) => p.id === projectId)
            )
            .map((o) => (
              <RadioCard
                key={o.id}
                name="shopify-organization"
                value={o.id}
                checked={organizationId === o.id}
                onChange={() => {
                  setOrganizationId(o.id)
                  setProject(projectId ?? "")
                }}
              >
                {o.name}
              </RadioCard>
            ))}
          {!projectId ? (
            <RadioCard
              name="shopify-organization"
              value="new"
              checked={!organizationId}
              onChange={() => {
                setOrganizationId("")
                setProject("")
              }}
            >
              Create an organization
            </RadioCard>
          ) : null}
        </fieldset>
        {!organizationId && !projectId ? (
          <div className="space-y-2">
            <Label htmlFor="shopify-organization-name">Organization name</Label>
            <Input
              id="shopify-organization-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              required
              disabled={busy}
              autoComplete="organization"
            />
          </div>
        ) : null}
        {selected && !projectId ? (
          <fieldset className="space-y-3" disabled={busy}>
            <legend className="mb-3 text-sm font-medium">
              Choose a project
            </legend>
            {selected.projects.map((p) => (
              <RadioCard
                key={p.id}
                name="shopify-project"
                value={p.id}
                checked={project === p.id}
                onChange={() => setProject(p.id)}
              >
                {p.name}
              </RadioCard>
            ))}
            <RadioCard
              name="shopify-project"
              value="new"
              checked={!project}
              onChange={() => setProject("")}
            >
              Create a Shopify project
            </RadioCard>
          </fieldset>
        ) : null}
        <Label
          htmlFor="shopify-privacy-acceptance"
          className="flex items-start gap-3 leading-relaxed"
        >
          <Checkbox
            id="shopify-privacy-acceptance"
            checked={privacyAccepted}
            onChange={(event) => setPrivacyAccepted(event.target.checked)}
            required
            disabled={busy}
          />
          <span>
            I am authorized to accept Datool's{" "}
            <Link
              href="/docs/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              privacy policy
            </Link>{" "}
            and{" "}
            <Link
              href="/docs/retention"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              retention schedule
            </Link>{" "}
            for this store.
          </span>
        </Label>
        <Button
          type="submit"
          loading={busy}
          disabled={
            busy ||
            !privacyAccepted ||
            (!organizationId && (!name.trim() || !!projectId))
          }
        >
          Connect store
        </Button>
        <p className="text-sm text-foreground-muted">
          Connecting does not create a charge. Any new Shopify subscription
          requires your approval in Shopify.
        </p>
      </form>
    </main>
  )
}

export function ShopifyBillingReturn({
  organizationId,
  organizationName,
  shop,
}: {
  organizationId: string
  organizationName: string
  shop: string
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function open() {
    setBusy(true)
    setError("")
    try {
      await selectOrganization(organizationId)
      navigateWorkspace("/billing?checkout=success")
    } catch {
      setError("Unable to open billing. Please try again.")
      setBusy(false)
    }
  }
  return (
    <main className="mx-auto max-w-xl space-y-5 px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold">Return to Datool</h1>
      <p className="text-sm text-foreground-muted">
        Open {organizationName} to verify the subscription for {shop}.
      </p>
      {error ? (
        <Notice variant="error" role="alert">
          {error}
        </Notice>
      ) : null}
      <Button loading={busy} disabled={busy} onClick={() => void open()}>
        Open billing
      </Button>
    </main>
  )
}
