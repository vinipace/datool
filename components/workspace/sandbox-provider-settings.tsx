"use client"

import { useCallback, useState } from "react"
import { ArrowLeft, Box, Boxes, Pencil, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import { ModelProviderLogo } from "@/components/ui/model-provider-logo"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  ProviderPicker,
  ProviderSettingsLayout,
  ProviderSettingsTable,
} from "@/components/ui/provider-settings"
import { useRemote } from "@/components/tracer/hooks"
import { workspaceRequest } from "@/lib/workspace-api"
import {
  sandboxProviderIds,
  sandboxProviderNames,
  type SandboxProviderId,
  type SandboxProviderSettings as Settings,
  type SandboxProviderStatus,
} from "@/src/lib/sandbox-providers"

const descriptions = {
  datool:
    "Run scorers using your organization’s shared execution credits. No API key needed.",
  local: "Run scorers in an isolated Docker container on your Datool server.",
  vercel: "Run scorers in an isolated Vercel Sandbox using your account.",
  modal: "Run scorers in a Modal sandbox using your workspace credentials.",
}
const fields = {
  datool: [],
  local: [],
  vercel: [
    { key: "apiKey", label: "API token", secret: true },
    { key: "teamId", label: "Team ID", secret: false },
    { key: "projectId", label: "Vercel project ID", secret: false },
  ],
  modal: [
    { key: "tokenId", label: "Token ID", secret: true },
    { key: "tokenSecret", label: "Token secret", secret: true },
  ],
} as const

function ProviderIcon({ id }: { id: SandboxProviderId }) {
  if (id === "datool")
    return <ModelProviderLogo provider="datool" className="size-6" />
  if (id === "vercel")
    return <ModelProviderLogo provider="vercel" className="size-6" />
  const Icon = id === "local" ? Box : Boxes
  return <Icon aria-hidden="true" className="size-6 text-foreground-muted" />
}

export function SandboxProviderSettings({
  projectId,
  canManage,
}: {
  projectId: string
  canManage: boolean
}) {
  const path = `/api/projects/${encodeURIComponent(projectId)}/sandbox-providers`
  const load = useCallback(
    (signal: AbortSignal) => workspaceRequest<Settings>(path, { signal }),
    [path]
  )
  const state = useRemote(load, [projectId])
  return (
    <ProviderSettingsLayout description="Configure sandboxes for JavaScript and Python scorers in this project. Datool Sandbox uses execution credits. Your own providers use their configured fallback order.">
      {state.error && (
        <Notice variant="error" role="alert">
          {state.error.message}{" "}
          <Button size="sm" variant="outline" onClick={state.refresh}>
            Retry providers
          </Button>
        </Notice>
      )}
      <ProviderEditor
        key={`${projectId}:${JSON.stringify(state.data)}`}
        initial={state.data}
        path={path}
        canManage={canManage}
        unavailable={state.isLoading || Boolean(state.error)}
        loading={state.isLoading}
      />
    </ProviderSettingsLayout>
  )
}

function ProviderEditor({
  initial,
  path,
  canManage,
  unavailable,
  loading,
}: {
  initial: Settings | null
  path: string
  canManage: boolean
  unavailable: boolean
  loading: boolean
}) {
  const [settings, setSettings] = useState(initial)
  const [editing, setEditing] = useState<SandboxProviderId | "picker" | null>(
    null
  )
  const [removing, setRemoving] = useState<SandboxProviderId | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  async function mutate(method: "PUT" | "PATCH" | "DELETE", body: unknown) {
    if (pending || unavailable || !canManage) return false
    setPending(true)
    setError(null)
    setSuccess(null)
    try {
      const next = await workspaceRequest<Settings>(path, {
        method,
        body: JSON.stringify(body),
      })
      setSettings(next)
      setSuccess(
        method === "PATCH"
          ? "Default sandbox provider updated."
          : method === "DELETE"
            ? "Provider removed from the execution order."
            : "Sandbox provider saved."
      )
      return true
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to save sandbox providers."
      )
      return false
    } finally {
      setPending(false)
    }
  }
  const disabled = unavailable || pending || !canManage
  const configured = (settings?.providers ?? [])
    .filter((provider) => provider.configured)
    .sort(
      (a, b) =>
        Number(b.id === settings?.defaultProvider) -
        Number(a.id === settings?.defaultProvider)
    )

  const selected =
    editing && editing !== "picker"
      ? (settings?.providers.find((provider) => provider.id === editing) ?? {
          id: editing,
          configured: false,
        })
      : null
  const close = () => {
    if (!pending) {
      setEditing(null)
      setError(null)
    }
  }
  return (
    <>
      <ProviderSettingsTable
        label="Sandbox providers"
        detailHeading="Execution order"
        loading={loading}
        unavailable={unavailable}
        emptyMessage="No sandbox providers configured. Add a provider to run code scorers."
        rows={configured.map((provider, index) => ({
          id: provider.id,
          name: sandboxProviderNames[provider.id],
          description:
            provider.id === "datool"
              ? "Organization execution credits"
              : provider.id === "local"
                ? "Docker"
                : provider.id === "vercel"
                  ? (provider.projectId ?? "Vercel Sandbox")
                  : "Modal workspace",
          icon: <ProviderIcon id={provider.id} />,
          kind: provider.id === "local" ? "Local" : "Cloud",
          status: "Configured",
          secret: ["local", "datool"].includes(provider.id)
            ? "Not required"
            : "••••••••",
          detail:
            provider.id === settings?.defaultProvider ? (
              <span className="font-medium">Default</span>
            ) : (
              <span className="text-foreground-muted">
                {settings?.executionOrder.includes(provider.id)
                  ? `Fallback ${index}`
                  : "Available"}
              </span>
            ),
          actions: canManage && (
            <>
              {provider.id !== settings?.defaultProvider && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={`Make ${sandboxProviderNames[provider.id]} default`}
                  onClick={() =>
                    void mutate("PATCH", { provider: provider.id })
                  }
                >
                  Make default
                </Button>
              )}
              <Button
                size="icon-sm"
                variant="ghost-muted"
                disabled={disabled || provider.id === "datool"}
                aria-label={`Edit ${sandboxProviderNames[provider.id]}`}
                onClick={() => {
                  setError(null)
                  setEditing(provider.id)
                }}
              >
                <Pencil />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost-muted"
                disabled={disabled}
                aria-label={`Remove ${sandboxProviderNames[provider.id]}`}
                onClick={() => {
                  setError(null)
                  setRemoving(provider.id)
                }}
              >
                <Trash2 />
              </Button>
            </>
          ),
        }))}
      />
      {error && !editing && !removing && (
        <Notice variant="error" role="alert">
          {error}
        </Notice>
      )}
      {success && (
        <Notice variant="success" role="status">
          {success}
        </Notice>
      )}
      {canManage ? (
        <Dialog
          open={editing !== null}
          onOpenChange={(open) => {
            if (!pending) {
              setEditing(open ? "picker" : null)
              setError(null)
            }
          }}
        >
          <DialogTrigger asChild>
            <Button variant="secondary" disabled={disabled}>
              <Plus />
              Add provider
            </Button>
          </DialogTrigger>
          <DialogContent
            className={selected ? undefined : "max-w-2xl"}
            showCloseButton={!pending}
            onEscapeKeyDown={(event) => {
              if (pending) event.preventDefault()
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {selected
                  ? `${selected.configured ? "Edit" : "Configure"} ${sandboxProviderNames[selected.id]}`
                  : "Add sandbox provider"}
              </DialogTitle>
              <DialogDescription>
                {selected
                  ? descriptions[selected.id]
                  : "Choose a provider to run your scorers."}
              </DialogDescription>
            </DialogHeader>
            {selected ? (
              <SandboxProviderForm
                key={selected.id}
                provider={selected}
                pending={pending}
                error={error}
                onBack={() => {
                  setEditing("picker")
                  setError(null)
                }}
                onCancel={close}
                onSave={async (body) => {
                  if (await mutate("PUT", body)) setEditing(null)
                }}
              />
            ) : (
              <ProviderPicker
                options={sandboxProviderIds.map((id) => ({
                  id,
                  name: sandboxProviderNames[id],
                  icon: <ProviderIcon id={id} />,
                  configured:
                    settings?.providers.some(
                      (provider) => provider.id === id && provider.configured
                    ) ?? false,
                }))}
                onSelect={(id) => setEditing(id as SandboxProviderId)}
              />
            )}
          </DialogContent>
        </Dialog>
      ) : (
        <p className="text-sm text-foreground-muted">
          Only organization owners and admins can configure sandbox providers.
        </p>
      )}
      <p className="text-xs text-foreground-muted">
        Scorer errors and timeouts stop the run. Credentials are encrypted;
        cloud providers receive the scorer code and trace being evaluated.
      </p>
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setRemoving(null)
            setError(null)
          }
        }}
      >
        <DialogContent showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>
              Remove {removing ? sandboxProviderNames[removing] : "provider"}?
            </DialogTitle>
            <DialogDescription>
              {removing === settings?.defaultProvider
                ? "The next configured provider will become the default. If none remain, code scorers will stop running."
                : "This provider will no longer be used as a fallback."}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Notice variant="error" role="alert">
              {error}
            </Notice>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                setRemoving(null)
                setError(null)
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={pending}
              onClick={async () => {
                if (await mutate("DELETE", { provider: removing }))
                  setRemoving(null)
              }}
            >
              Confirm removal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function SandboxProviderForm({
  provider,
  pending,
  error,
  onBack,
  onCancel,
  onSave,
}: {
  provider: SandboxProviderStatus
  pending: boolean
  error: string | null
  onBack: () => void
  onCancel: () => void
  onSave: (body: Record<string, string>) => Promise<void>
}) {
  const id = provider.id
  const baseline: Record<string, string> = {
    teamId: provider.teamId ?? "",
    projectId: provider.projectId ?? "",
  }
  const [values, setValues] = useState<Record<string, string>>(baseline)
  const dirty = fields[id].some(
    (field) => (values[field.key]?.trim() ?? "") !== (baseline[field.key] ?? "")
  )
  const complete = fields[id].every(
    (field) =>
      (field.secret && provider.configured) || values[field.key]?.trim()
  )
  const canSave =
    id === "local" || id === "datool" ? !provider.configured : dirty && complete
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault()
        if (pending || !canSave) return
        const body = Object.fromEntries(
          fields[id].flatMap((field) =>
            values[field.key]?.trim()
              ? [[field.key, values[field.key].trim()]]
              : []
          )
        )
        void onSave({ provider: id, ...body })
      }}
    >
      {id === "local" && (
        <p className="text-sm text-foreground-muted">
          Requires Docker and the scorer images on the Datool server. Containers
          have no network access and are removed after each run.
        </p>
      )}
      {id === "vercel" && (
        <p className="text-sm text-foreground-muted">
          Use a{" "}
          <a
            className="underline"
            href="https://vercel.com/docs/sandbox/concepts/authentication"
            target="_blank"
            rel="noreferrer"
          >
            Vercel access token
          </a>{" "}
          with access to the team and project below.
        </p>
      )}
      {id === "modal" && (
        <p className="text-sm text-foreground-muted">
          Create a{" "}
          <a
            className="underline"
            href="https://modal.com/settings"
            target="_blank"
            rel="noreferrer"
          >
            Modal API token
          </a>{" "}
          in your workspace settings.
        </p>
      )}
      <div className="space-y-4">
        {fields[id].map((field, index) => (
          <div className="space-y-2" key={field.key}>
            <label
              className="block text-sm font-medium"
              htmlFor={`sandbox-${id}-${field.key}`}
            >
              {field.label}
            </label>
            <Input
              id={`sandbox-${id}-${field.key}`}
              autoFocus={index === 0}
              type={field.secret ? "password" : "text"}
              autoComplete={field.secret ? "new-password" : "off"}
              autoCapitalize="none"
              spellCheck={false}
              maxLength={field.secret ? 4096 : 200}
              required={!field.secret || !provider.configured}
              disabled={pending}
              placeholder={
                field.secret && provider.configured
                  ? "Saved · leave blank to keep"
                  : field.label
              }
              value={values[field.key] ?? ""}
              onChange={(event) =>
                setValues({ ...values, [field.key]: event.target.value })
              }
            />
          </div>
        ))}
      </div>
      {error && (
        <Notice variant="error" role="alert">
          {error}
        </Notice>
      )}
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={onBack}
          className="sm:mr-auto"
        >
          <ArrowLeft />
          Providers
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        {!(["local", "datool"].includes(id) && provider.configured) && (
          <Button type="submit" disabled={!canSave} loading={pending}>
            {provider.configured ? "Save changes" : "Add provider"}
          </Button>
        )}
      </DialogFooter>
    </form>
  )
}
