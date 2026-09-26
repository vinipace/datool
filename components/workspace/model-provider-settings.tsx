"use client"

import { DATOOL_PROVIDER } from "@/src/lib/execution-credits"

import { useCallback, useState } from "react"
import { ArrowLeft, Pencil, Plus, Trash2 } from "lucide-react"
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
  MODEL_PROVIDER_IDS,
  modelProviders,
  type ModelProvider,
  type ProviderStatus,
} from "@/src/lib/model-providers"

type Settings = { providers: ProviderStatus[] }

export function ModelProviderSettings({
  projectId,
  canManage,
}: {
  projectId: string
  canManage: boolean
}) {
  const path = `/api/projects/${encodeURIComponent(projectId)}/providers`
  const load = useCallback(
    (signal: AbortSignal) => workspaceRequest<Settings>(path, { signal }),
    [path]
  )
  const state = useRemote(load, [projectId])
  return (
    <ProviderSettingsLayout description="Connect AI providers to run LLM scorers in this project.">
      {state.error && (
        <Notice variant="error" role="alert">
          {state.error.message}{" "}
          <Button variant="outline" size="sm" onClick={state.refresh}>
            Retry providers
          </Button>
        </Notice>
      )}
      <ProviderEditor
        key={`${projectId}:${JSON.stringify(state.data)}`}
        initial={state.data}
        path={path}
        canManage={canManage}
        loading={state.isLoading}
        unavailable={state.isLoading || Boolean(state.error)}
      />
    </ProviderSettingsLayout>
  )
}

function ProviderEditor({
  initial,
  path,
  canManage,
  loading,
  unavailable,
}: {
  initial: Settings | null
  path: string
  canManage: boolean
  loading: boolean
  unavailable: boolean
}) {
  const [settings, setSettings] = useState(initial)
  const [editing, setEditing] = useState<"picker" | ModelProvider | null>(null)
  const [removing, setRemoving] = useState<ModelProvider | null>(null)
  const [apiKey, setApiKey] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const provider = settings?.providers.find(
    (entry) => entry.id === editing && entry.configured
  )
  const editingInfo =
    editing && editing !== "picker" ? modelProviders[editing] : null
  const removingName = removing ? modelProviders[removing].name : ""
  const disabled = unavailable || pending || !canManage
  function close() {
    if (!pending) {
      setEditing(null)
      setApiKey("")
      setError(null)
    }
  }
  async function update(remove: boolean) {
    const target = remove ? removing : editing
    if (
      !target ||
      target === "picker" ||
      disabled ||
      (!remove && !apiKey.trim())
    )
      return
    setPending(true)
    setError(null)
    setSuccess(null)
    try {
      const next = await workspaceRequest<Settings>(path, {
        method: remove ? "DELETE" : "PUT",
        body: JSON.stringify({
          provider: target,
          ...(!remove ? { apiKey: apiKey.trim() } : {}),
        }),
      })
      setSettings(next)
      setApiKey("")
      setEditing(null)
      setRemoving(null)
      setSuccess(
        remove
          ? `API key removed. Scorers using ${modelProviders[target].name} can no longer run.`
          : "API key saved for this project."
      )
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to save provider settings."
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      <ProviderSettingsTable
        label="AI providers"
        detailHeading="Last updated"
        loading={loading}
        unavailable={unavailable}
        emptyMessage="No AI providers configured. Add a provider to run LLM scorers."
        rows={(settings?.providers ?? [])
          .filter((provider) => provider.configured)
          .map((provider) => ({
            id: provider.id,
            name: provider.name,
            description: modelProviders[provider.id].description,
            icon: (
              <ModelProviderLogo
                provider={modelProviders[provider.id].logo}
                className="size-6"
              />
            ),
            kind: modelProviders[provider.id].kind,
            status: "Saved",
            secret: "••••••••",
            detail: provider.updatedAt ? (
              <time
                dateTime={provider.updatedAt}
                className="text-foreground-muted"
              >
                {new Intl.DateTimeFormat("en", {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                }).format(new Date(provider.updatedAt))}
              </time>
            ) : (
              "—"
            ),
            actions: canManage && (
              <>
                <Button
                  size="icon-sm"
                  variant="ghost-muted"
                  disabled={disabled}
                  aria-label={`Edit ${provider.name}`}
                  onClick={() => {
                    setApiKey("")
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
                  aria-label={`Remove ${provider.name}`}
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
            if (pending) return
            if (open) {
              setEditing("picker")
              setApiKey("")
              setError(null)
            } else close()
          }}
        >
          <DialogTrigger asChild>
            <Button variant="secondary" disabled={disabled}>
              <Plus />
              Add provider
            </Button>
          </DialogTrigger>
          <DialogContent
            className={editing === "picker" ? "max-w-2xl" : undefined}
            showCloseButton={!pending}
          >
            <DialogHeader>
              <DialogTitle>
                {editing === "picker"
                  ? "Add AI provider"
                  : `${provider ? "Edit" : "Configure"} ${editingInfo?.name ?? ""}`}
              </DialogTitle>
              <DialogDescription>
                {editing === "picker"
                  ? "Choose a provider to connect to this project."
                  : editingInfo?.description}
              </DialogDescription>
            </DialogHeader>
            {editing === "picker" ? (
              <ProviderPicker
                options={MODEL_PROVIDER_IDS.filter(
                  (id) => id !== DATOOL_PROVIDER
                ).map((id) => ({
                  id,
                  name: modelProviders[id].name,
                  icon: (
                    <ModelProviderLogo
                      provider={modelProviders[id].logo}
                      className="size-6"
                    />
                  ),
                  configured: Boolean(
                    settings?.providers.some(
                      (entry) => entry.id === id && entry.configured
                    )
                  ),
                }))}
                onSelect={(id) => {
                  if (MODEL_PROVIDER_IDS.includes(id as ModelProvider))
                    setEditing(id as ModelProvider)
                }}
              />
            ) : (
              <form
                className="space-y-5"
                onSubmit={(event) => {
                  event.preventDefault()
                  void update(false)
                }}
              >
                <p className="text-sm text-foreground-muted">
                  Use your{" "}
                  <a
                    className="underline"
                    href={editingInfo?.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {editingInfo?.keyLabel}
                  </a>
                  . Keys are encrypted and used only on the server.
                </p>
                <div className="space-y-2">
                  <label
                    className="block text-sm font-medium"
                    htmlFor="model-provider-api-key"
                  >
                    {editingInfo?.keyLabel}
                  </label>
                  <Input
                    id="model-provider-api-key"
                    autoFocus
                    type="password"
                    autoComplete="new-password"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    value={apiKey}
                    maxLength={4096}
                    disabled={pending}
                    placeholder={
                      provider
                        ? "Enter a replacement key"
                        : "Enter your API key"
                    }
                    onChange={(event) => setApiKey(event.target.value)}
                  />
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
                    className="sm:mr-auto"
                    onClick={() => {
                      setEditing("picker")
                      setApiKey("")
                      setError(null)
                    }}
                  >
                    <ArrowLeft />
                    Providers
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={close}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    loading={pending}
                    disabled={!apiKey.trim()}
                  >
                    {provider ? "Save changes" : "Add provider"}
                  </Button>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
        </Dialog>
      ) : (
        <p className="text-sm text-foreground-muted">
          Only organization owners and admins can configure AI providers.
        </p>
      )}
      <p className="text-xs text-foreground-muted">
        Provider keys are encrypted and scoped to this project.
      </p>
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!pending) {
            if (!open) setRemoving(null)
            setError(null)
          }
        }}
      >
        <DialogContent showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>Remove {removingName}?</DialogTitle>
            <DialogDescription>
              Removing this key prevents this project's scorers using{" "}
              {removingName} from running.
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
              onClick={() => void update(true)}
            >
              Confirm removal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
