"use client"

import { useCallback, useState } from "react"
import { HardDrive, Pencil, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select } from "@/components/ui/select"
import { FormRow } from "@/components/ui/form-row"
import { Notice } from "@/components/ui/notice"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  ProviderSettingsLayout,
  ProviderSettingsTable,
} from "@/components/ui/provider-settings"
import { useRemote } from "@/components/tracer/hooks"
import { workspaceRequest } from "@/lib/workspace-api"
import {
  storageProviderNames,
  type StorageConnection,
  type StorageConnectionInput,
} from "@/src/lib/build/storage"

type Settings = { items: StorageConnection[] }
export function StorageProviderSettings({
  organizationId,
  canManage,
}: {
  organizationId: string
  canManage: boolean
}) {
  const path = `/api/organizations/${encodeURIComponent(organizationId)}/storage-connections`
  const load = useCallback(
    (signal: AbortSignal) => workspaceRequest<Settings>(path, { signal }),
    [path]
  )
  const state = useRemote(load, [organizationId])
  const [editing, setEditing] = useState<StorageConnection | "new" | null>(null)
  const [removing, setRemoving] = useState<StorageConnection | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function mutate(method: "PUT" | "DELETE", body: unknown) {
    if (pending || !canManage) return
    setPending(true)
    setError(null)
    try {
      await workspaceRequest<Settings>(path, {
        method,
        body: JSON.stringify(body),
      })
      setEditing(null)
      setRemoving(null)
      state.refresh()
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to save storage."
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <ProviderSettingsLayout description="Choose where agent drives persist their files. Docker with local volumes works on your own server without cloud credentials. S3 and GCS drives can be used with any sandbox provider.">
      {state.error && (
        <Notice variant="error" role="alert">
          {state.error.message}{" "}
          <Button variant="outline" size="sm" onClick={state.refresh}>
            Retry storage
          </Button>
        </Notice>
      )}
      <ProviderSettingsTable
        label="Storage providers"
        detailHeading="Location"
        loading={state.isLoading}
        unavailable={Boolean(state.error)}
        emptyMessage="Local volumes are available without configuration."
        rows={[
          {
            id: "local",
            name: "Local volumes",
            description: "Persistent Docker volumes on your server",
            icon: <HardDrive className="size-6" />,
            kind: "Local",
            status: "Built in",
            secret: "Not required",
            detail: "Docker host",
          },
          {
            id: "modal",
            name: "Modal volumes",
            description: "Native volumes for Datool and Modal sandboxes",
            icon: <HardDrive className="size-6" />,
            kind: "Cloud",
            status: "Built in",
            secret: "Sandbox credentials",
            detail: "Sandbox workspace",
          },
          ...(state.data?.items ?? []).map((connection) => ({
            id: connection.id,
            name: connection.name,
            description: storageProviderNames[connection.config.provider],
            icon: <HardDrive className="size-6" />,
            kind: "Cloud",
            status: "Configured",
            secret: "••••••••",
            detail: (
              <span
                title={`${connection.config.bucket}/${connection.config.prefix}`}
              >
                {connection.config.bucket}/{connection.config.prefix}
              </span>
            ),
            actions: canManage && (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit ${connection.name}`}
                  onClick={() => {
                    setError(null)
                    setEditing(connection)
                  }}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${connection.name}`}
                  onClick={() => {
                    setError(null)
                    setRemoving(connection)
                  }}
                >
                  <Trash2 />
                </Button>
              </>
            ),
          })),
        ]}
      />
      {canManage && (
        <Button
          size="sm"
          disabled={state.isLoading || Boolean(state.error)}
          onClick={() => {
            setError(null)
            setEditing("new")
          }}
        >
          <Plus />
          Add storage provider
        </Button>
      )}
      <Dialog
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open && !pending) setEditing(null)
        }}
      >
        <DialogContent
          showCloseButton={!pending}
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault()
          }}
          onInteractOutside={(event) => {
            if (pending) event.preventDefault()
          }}
          className="max-h-[90dvh] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>
              {editing === "new"
                ? "Add storage provider"
                : "Edit storage provider"}
            </DialogTitle>
            <DialogDescription>
              Credentials stay on the server. A connection's bucket and prefix
              cannot change after creation.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <StorageForm
              key={editing === "new" ? "new" : editing.id}
              connection={editing === "new" ? null : editing}
              pending={pending}
              error={error}
              save={(input) => mutate("PUT", input)}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open && !pending) setRemoving(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {removing?.name}?</DialogTitle>
            <DialogDescription>
              Connections used by a drive cannot be removed. Stored objects will
              not be deleted.
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
              onClick={() => setRemoving(null)}
            >
              Cancel
            </Button>
            <Button
              loading={pending}
              onClick={() => void mutate("DELETE", { id: removing?.id })}
            >
              Remove connection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ProviderSettingsLayout>
  )
}
function StorageForm({
  connection,
  pending,
  error,
  save,
}: {
  connection: StorageConnection | null
  pending: boolean
  error: string | null
  save: (input: StorageConnectionInput) => Promise<void>
}) {
  const [provider, setProvider] = useState<"s3" | "gcs">(
    connection?.config.provider ?? "s3"
  )
  const [rotate, setRotate] = useState(!connection)
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const value = (key: string) => String(data.get(key) ?? "").trim()
    const config =
      connection?.config ??
      (provider === "s3"
        ? {
            provider,
            bucket: value("bucket"),
            prefix: value("prefix"),
            region: value("region"),
            ...(value("endpoint") ? { endpoint: value("endpoint") } : {}),
          }
        : {
            provider,
            bucket: value("bucket"),
            prefix: value("prefix"),
            projectId: value("projectId"),
          })
    const credentials: Record<string, string> | undefined = rotate
      ? provider === "s3"
        ? {
            accessKeyId: value("accessKeyId"),
            secretAccessKey: value("secretAccessKey"),
            ...(value("sessionToken")
              ? { sessionToken: value("sessionToken") }
              : {}),
          }
        : {
            clientEmail: value("clientEmail"),
            privateKey: value("privateKey").replaceAll("\\n", "\n"),
          }
      : undefined
    void save({
      ...(connection
        ? { id: connection.id, expectedRevision: connection.revision }
        : {}),
      name: value("name"),
      config,
      credentials,
    })
  }
  return (
    <form onSubmit={submit} className="space-y-5">
      <fieldset disabled={pending} className="space-y-4">
        {error && (
          <Notice variant="error" role="alert">
            {error}
          </Notice>
        )}
        <FormRow
          label="Name"
          htmlFor="storage-name"
          layout="vertical"
          variant="plain"
        >
          <Input
            id="storage-name"
            name="name"
            defaultValue={connection?.name}
            required
            maxLength={120}
            autoFocus
          />
        </FormRow>
        <FormRow
          label="Provider"
          htmlFor="storage-provider"
          layout="vertical"
          variant="plain"
        >
          <Select
            id="storage-provider"
            value={provider}
            disabled={Boolean(connection)}
            onChange={(event) =>
              setProvider(event.target.value as "s3" | "gcs")
            }
          >
            <option value="s3">S3-compatible storage</option>
            <option value="gcs">Google Cloud Storage</option>
          </Select>
        </FormRow>
        <FormRow
          label="Bucket"
          htmlFor="storage-bucket"
          layout="vertical"
          variant="plain"
        >
          <Input
            id="storage-bucket"
            name="bucket"
            defaultValue={connection?.config.bucket}
            required
            readOnly={Boolean(connection)}
          />
        </FormRow>
        <FormRow
          label="Prefix"
          htmlFor="storage-prefix"
          layout="vertical"
          variant="plain"
        >
          <Input
            id="storage-prefix"
            name="prefix"
            defaultValue={connection?.config.prefix ?? "datool"}
            readOnly={Boolean(connection)}
          />
        </FormRow>
        {provider === "s3" ? (
          <>
            <FormRow
              label="Region"
              htmlFor="storage-region"
              layout="vertical"
              variant="plain"
            >
              <Input
                id="storage-region"
                name="region"
                defaultValue={
                  connection?.config.provider === "s3"
                    ? connection.config.region
                    : "us-east-1"
                }
                required
                readOnly={Boolean(connection)}
              />
            </FormRow>
            <FormRow
              label="Endpoint (optional)"
              htmlFor="storage-endpoint"
              layout="vertical"
              variant="plain"
              description="Leave blank for AWS S3. For MinIO or another S3-compatible service, use its endpoint URL."
            >
              <Input
                id="storage-endpoint"
                name="endpoint"
                type="url"
                defaultValue={
                  connection?.config.provider === "s3"
                    ? connection.config.endpoint
                    : ""
                }
                readOnly={Boolean(connection)}
              />
            </FormRow>
          </>
        ) : (
          <FormRow
            label="Google Cloud project"
            htmlFor="storage-projectId"
            layout="vertical"
            variant="plain"
          >
            <Input
              id="storage-projectId"
              name="projectId"
              defaultValue={
                connection?.config.provider === "gcs"
                  ? connection.config.projectId
                  : ""
              }
              required
              readOnly={Boolean(connection)}
            />
          </FormRow>
        )}
        {connection && !rotate && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRotate(true)}
          >
            Replace credentials
          </Button>
        )}
        {rotate &&
          (provider === "s3" ? (
            <>
              <FormRow
                label="Access key ID"
                htmlFor="storage-accessKeyId"
                layout="vertical"
                variant="plain"
              >
                <Input
                  id="storage-accessKeyId"
                  name="accessKeyId"
                  type="password"
                  autoComplete="new-password"
                  required
                />
              </FormRow>
              <FormRow
                label="Secret access key"
                htmlFor="storage-secretAccessKey"
                layout="vertical"
                variant="plain"
              >
                <Input
                  id="storage-secretAccessKey"
                  name="secretAccessKey"
                  type="password"
                  autoComplete="new-password"
                  required
                />
              </FormRow>
              <FormRow
                label="Session token (optional)"
                htmlFor="storage-sessionToken"
                layout="vertical"
                variant="plain"
              >
                <Input
                  id="storage-sessionToken"
                  name="sessionToken"
                  type="password"
                  autoComplete="new-password"
                />
              </FormRow>
            </>
          ) : (
            <>
              <FormRow
                label="Service account email"
                htmlFor="storage-clientEmail"
                layout="vertical"
                variant="plain"
              >
                <Input
                  id="storage-clientEmail"
                  name="clientEmail"
                  type="email"
                  required
                />
              </FormRow>
              <FormRow
                label="Private key"
                htmlFor="storage-privateKey"
                layout="vertical"
                variant="plain"
              >
                <Textarea
                  id="storage-privateKey"
                  name="privateKey"
                  required
                  autoComplete="off"
                  rows={4}
                />
              </FormRow>
            </>
          ))}
      </fieldset>
      <DialogFooter>
        <Button type="submit" loading={pending}>
          Verify and save
        </Button>
      </DialogFooter>
    </form>
  )
}
