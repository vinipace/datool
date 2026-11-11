"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { ProviderSettingsTable } from "@/components/ui/provider-settings"
import { workspaceRequest } from "@/lib/workspace-api"
import type { ProviderConnectionInfo } from "@/src/lib/provider-connections"
import {
  sandboxProviderFields,
  sandboxProviderNames,
  type SandboxProviderId,
} from "@/src/lib/sandbox-providers"
import { modelProviders, type ModelProvider } from "@/src/lib/model-providers"

/** Imported accounts remain editable until administrators retire their assignments. */
export function ProviderConnections<T>({
  kind,
  path,
  connections,
  canManage,
  onChange,
}: {
  kind: "model" | "sandbox"
  path: string
  connections: ProviderConnectionInfo[]
  canManage: boolean
  onChange: (settings: T) => void
}) {
  const [selected, setSelected] = useState<{
    connection: ProviderConnectionInfo
    action: "edit" | "default" | "inherit" | "remove"
  } | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const imported = connections.filter(
    (row) => !row.isDefault || row.projects.length > 0
  )
  if (!imported.length) return null
  const fields =
    kind === "model"
      ? [{ key: "apiKey", label: "API key", secret: true }]
      : selected
        ? sandboxProviderFields[
            selected.connection.provider as SandboxProviderId
          ]
        : []
  const label = (row: ProviderConnectionInfo) =>
    kind === "model"
      ? modelProviders[row.provider as ModelProvider].name
      : sandboxProviderNames[row.provider as SandboxProviderId]
  async function submit() {
    if (!selected || pending || !canManage) return
    setPending(true)
    setError(null)
    try {
      const { action, connection } = selected
      if (action === "edit" || action === "remove")
        await workspaceRequest(path, {
          method: action === "edit" ? "PUT" : "DELETE",
          body: JSON.stringify({
            provider: connection.provider,
            connectionId: connection.connectionId,
            ...(action === "edit" ? values : {}),
          }),
        })
      else
        await workspaceRequest(
          `${path.substring(0, path.lastIndexOf("/"))}/provider-connections/${connection.connectionId}`,
          { method: "PATCH", body: JSON.stringify({ kind, action }) }
        )
      onChange(await workspaceRequest<T>(path))
      setSelected(null)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to update provider connection."
      )
    } finally {
      setPending(false)
    }
  }
  function choose(
    connection: ProviderConnectionInfo,
    action: NonNullable<typeof selected>["action"]
  ) {
    setSelected({ connection, action })
    setValues({ ...connection.metadata })
    setError(null)
  }
  return (
    <>
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Imported connections</h2>
        <p className="text-sm text-foreground-muted">
          Existing project assignments are preserved. Edit these accounts or
          switch their projects to a shared default.
        </p>
      </div>
      <ProviderSettingsTable
        label="Imported connections"
        loading={false}
        unavailable={false}
        detailHeading="Project assignments"
        emptyMessage="No imported connections."
        rows={imported.map((row) => ({
          id: row.connectionId,
          icon: null,
          name: row.name,
          description: label(row),
          kind: row.isDefault ? "Shared default" : "Imported",
          status: "Saved",
          secret: "••••••••",
          detail:
            row.projects.map((p) => p.name).join(", ") || "No assignments",
          actions: canManage && (
            <>
              <Button
                variant="ghost-muted"
                size="sm"
                disabled={pending}
                onClick={() => choose(row, "edit")}
              >
                Edit
              </Button>
              {!row.isDefault && (
                <Button
                  variant="ghost-muted"
                  size="sm"
                  disabled={pending}
                  onClick={() => choose(row, "default")}
                >
                  Make shared
                </Button>
              )}
              {row.projects.length > 0 ? (
                <Button
                  variant="ghost-muted"
                  size="sm"
                  disabled={pending}
                  onClick={() => choose(row, "inherit")}
                >
                  Use shared default
                </Button>
              ) : (
                <Button
                  variant="ghost-muted"
                  size="sm"
                  disabled={pending}
                  onClick={() => choose(row, "remove")}
                >
                  Remove
                </Button>
              )}
            </>
          ),
        }))}
      />
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open && !pending) setSelected(null)
        }}
      >
        <DialogContent showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>
              {selected?.action === "edit"
                ? "Edit connection"
                : selected?.action === "default"
                  ? "Make shared default?"
                  : selected?.action === "inherit"
                    ? "Use shared default?"
                    : "Remove connection?"}
            </DialogTitle>
            <DialogDescription>
              {selected?.action === "inherit"
                ? `These projects will use the organization's shared ${label(selected.connection)} connection: ${selected.connection.projects.map((p) => p.name).join(", ")}. Changing sandbox accounts can change access to native volumes; use the account that owns existing volumes.`
                : selected?.action === "default"
                  ? "Projects without an imported assignment will use this connection. Existing assignments are preserved."
                  : selected?.action === "remove"
                    ? "This connection will be removed from the organization."
                    : "Credentials are encrypted. Changes apply to every project using this connection."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            {selected?.action === "edit" &&
              fields.map((field) => (
                <div key={field.key} className="space-y-2">
                  <label
                    className="block text-sm font-medium"
                    htmlFor={`connection-${field.key}`}
                  >
                    {field.label}
                  </label>
                  <Input
                    id={`connection-${field.key}`}
                    type={field.secret ? "password" : "text"}
                    required
                    autoComplete="new-password"
                    maxLength={4096}
                    value={values[field.key] ?? ""}
                    disabled={pending}
                    onChange={(event) =>
                      setValues({ ...values, [field.key]: event.target.value })
                    }
                  />
                </div>
              ))}
            {error && (
              <Notice variant="error" role="alert">
                {error}
              </Notice>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setSelected(null)}
              >
                Cancel
              </Button>
              <Button type="submit" loading={pending} disabled={!canManage}>
                {selected?.action === "edit" ? "Save changes" : "Confirm"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
