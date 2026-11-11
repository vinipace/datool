"use client"

import * as React from "react"
import Link from "next/link"
import { HardDrive, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { FormRow } from "@/components/ui/form-row"
import { Input } from "@/components/ui/input"
import { InspectorSection } from "@/components/ui/inspector-section"
import { Notice } from "@/components/ui/notice"
import { Select } from "@/components/ui/select"
import { SettingsSection } from "@/components/ui/settings-section"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { CollectionPanel } from "@/components/tracer/collection-panel"
import {
  CollectionPage,
  CollectionSearch,
} from "@/components/tracer/collection-page"
import {
  CollectionRow,
  CollectionTable,
  CollectionTableBody,
} from "@/components/tracer/collection-table"
import { collectionTable } from "@/components/tracer/collection-table-styles"
import { useRemote } from "@/components/tracer/hooks"
import { useWorkspaceHref } from "@/components/tracer/workspace-path"
import {
  buildCall,
  buildOperations,
  formatBuildError,
} from "@/components/build/shared/build-api"
import type { AgentConfiguration } from "@/src/lib/build/contracts"
import {
  agentSandboxSchema,
  type AgentDrive,
  type AgentSandboxConfiguration,
} from "@/src/lib/build/sandbox"
import {
  storageProviderNames,
  cloudStorage,
  type StorageConnection,
} from "@/src/lib/build/storage"
import { DriveVersions } from "./drive-versions"

type Props = {
  configuration: AgentConfiguration
  onChange: (configuration: AgentConfiguration) => void
}

export function AgentSandbox({
  configuration,
  onChange,
  agentId,
  active = true,
}: Props & { agentId?: string; active?: boolean }) {
  const sandbox = configuration.sandbox
  const drives = useRemote(
    async (signal) => {
      const items: AgentDrive[] = []
      let after: string | undefined
      do {
        const page = await buildCall<{
          items: AgentDrive[]
          nextCursor: string | null
        }>(
          buildOperations.listDrives,
          { after, limit: 200, agentId },
          { signal }
        )
        items.push(...page.items)
        after = page.nextCursor ?? undefined
      } while (after)
      return items
    },
    [agentId],
    { enabled: active, intervalMs: 5000 }
  )
  const storage = useRemote(
    (signal) =>
      buildCall<{ items: StorageConnection[] }>(
        "build_list_storage_connections",
        {},
        { signal }
      ),
    [],
    { enabled: active }
  )
  const [storageId, setStorageId] = React.useState("")
  const [history, setHistory] = React.useState<AgentDrive | null>(null)
  const [added, setAdded] = React.useState<AgentDrive[]>([])
  const [search, setSearch] = React.useState("")
  const [open, setOpen] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [existingId, setExistingId] = React.useState("")
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [mountPath, setMountPath] = React.useState("")
  const [workingDirectory, setWorkingDirectory] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const catalog = [...(drives.data ?? []), ...added]
  const available = catalog.filter(
    (drive, index) =>
      (drive.provider === sandbox.provider || cloudStorage(drive.provider)) &&
      !drive.sdkContext &&
      !sandbox.drives.some((mount) => mount.driveId === drive.id) &&
      catalog.findIndex((item) => item.id === drive.id) === index
  )
  const rows = [
    ...sandbox.drives.map((mount) => ({
      ...mount,
      id: mount.driveId,
      drive: catalog.find((drive) => drive.id === mount.driveId),
      managed: false,
    })),
    ...catalog
      .filter(
        (drive, index) =>
          drive.sdkContext?.agentId === agentId &&
          drive.sdkContext &&
          !sandbox.drives.some((mount) => mount.driveId === drive.id) &&
          catalog.findIndex((item) => item.id === drive.id) === index
      )
      .map((drive) => ({
        id: drive.id,
        driveId: drive.id,
        mountPath: "/workspace",
        drive,
        managed: true,
      })),
  ].filter((row) =>
    [
      row.id,
      row.drive?.name,
      row.drive?.description,
      row.mountPath,
      row.drive?.sdkContext?.workspaceName,
    ].some((value) =>
      value?.toLowerCase().includes(search.trim().toLowerCase())
    )
  )

  function update(value: Partial<AgentSandboxConfiguration>) {
    onChange({ ...configuration, sandbox: { ...sandbox, ...value } })
  }
  function beginAdd() {
    let number = 1
    while (
      sandbox.drives.some((drive) => {
        const candidate = `/workspace/drive-${number}`
        return (
          drive.mountPath !== "/workspace" &&
          (drive.mountPath === candidate ||
            drive.mountPath.startsWith(`${candidate}/`) ||
            candidate.startsWith(`${drive.mountPath}/`))
        )
      })
    )
      number++
    setStorageId("")
    setEditingId(null)
    setExistingId("")
    setName("")
    setDescription("")
    setMountPath(`/workspace/drive-${number}`)
    setWorkingDirectory(!sandbox.drives.length)
    setError(
      sandbox.drives.some((drive) => drive.mountPath === "/workspace")
        ? "Move the existing /workspace mount into a subfolder in Advanced settings before adding another drive."
        : null
    )
    setOpen(true)
  }
  function edit(driveId: string) {
    const mount = sandbox.drives.find((mount) => mount.driveId === driveId)!
    const drive = catalog.find((drive) => drive.id === driveId)
    setEditingId(driveId)
    setExistingId("")
    setName(drive?.name ?? "Unavailable drive")
    setDescription(drive?.description ?? "")
    setMountPath(mount.mountPath)
    setWorkingDirectory(
      sandbox.workingDirectory === mount.mountPath ||
        sandbox.workingDirectory.startsWith(`${mount.mountPath}/`)
    )
    setError(null)
    setOpen(true)
  }
  function unmount(driveId: string) {
    const removed = sandbox.drives.find((drive) => drive.driveId === driveId)!
    const remaining = sandbox.drives.filter(
      (drive) => drive.driveId !== driveId
    )
    update({
      drives: remaining,
      ...(sandbox.workingDirectory === removed.mountPath ||
      sandbox.workingDirectory.startsWith(`${removed.mountPath}/`)
        ? { workingDirectory: remaining[0]?.mountPath ?? "/workspace" }
        : {}),
    })
  }
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (pending || (!editingId && sandbox.drives.length >= 4)) return
    setError(null)
    const driveId = editingId ?? (existingId || crypto.randomUUID())
    const old = sandbox.drives.find((mount) => mount.driveId === editingId)
    const previousWorking =
      old &&
      (sandbox.workingDirectory === old.mountPath ||
        sandbox.workingDirectory.startsWith(`${old.mountPath}/`))
    const next = agentSandboxSchema.safeParse({
      ...sandbox,
      drives: editingId
        ? sandbox.drives.map((mount) =>
            mount.driveId === editingId ? { driveId, mountPath } : mount
          )
        : [...sandbox.drives, { driveId, mountPath }],
      workingDirectory: workingDirectory
        ? mountPath +
          (previousWorking
            ? sandbox.workingDirectory.slice(old!.mountPath.length)
            : "")
        : previousWorking
          ? "/workspace"
          : sandbox.workingDirectory,
    })
    if (!next.success) {
      setError(next.error.issues[0]?.message ?? "Check the mount path.")
      return
    }
    setPending(true)
    try {
      if (!editingId && !existingId) {
        const drive = await buildCall<AgentDrive>(buildOperations.createDrive, {
          name: name.trim(),
          description: description.trim(),
          provider:
            storage.data?.items.find((item) => item.id === storageId)?.config
              .provider ?? sandbox.provider,
          ...(storageId ? { storageConnectionId: storageId } : {}),
        })
        next.data.drives = next.data.drives.map((mount) =>
          mount.driveId === driveId ? { ...mount, driveId: drive.id } : mount
        )
        setAdded((items) => [...items, drive])
        drives.refresh()
      }
      onChange({ ...configuration, sandbox: next.data })
      setOpen(false)
    } catch (error) {
      setError(formatBuildError(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <CollectionPanel label="Drives" compactToolbar>
        <CollectionPage
          className="contents"
          state={drives}
          loadingLabel="Loading drives"
          header={{
            children: (
              <CollectionSearch
                label="Search drives"
                value={search}
                onChange={setSearch}
              />
            ),
            actions: (
              <Button
                size="sm"
                aria-label="Add drive"
                disabled={sandbox.drives.length >= 4}
                onClick={beginAdd}
              >
                <Plus />
                <span className="hidden @min-[480px]/page:inline">
                  Add drive
                </span>
              </Button>
            ),
            showExport: false,
          }}
        >
          <CollectionTable
            fillHeight
            enableCardView={false}
            widths={[280, 240, 360, 220, 180, 170, 48]}
            columnIds={[
              "name",
              "workspace",
              "driveId",
              "mountPath",
              "provider",
              "createdAt",
              "actions",
            ]}
            actionColumnIds={["actions"]}
            persistenceKey={`build-agent-drives:${agentId ?? "agent"}`}
          >
            <thead className={collectionTable.head}>
              <tr>
                <th className={collectionTable.heading} aria-hidden />
                <th className={collectionTable.heading}>Name</th>
                <th className={collectionTable.heading}>Workspace</th>
                <th className={collectionTable.heading}>Drive ID</th>
                <th className={collectionTable.heading}>Mount path</th>
                <th className={collectionTable.heading}>Provider</th>
                <th className={collectionTable.heading}>Created</th>
                <th className={collectionTable.heading}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <CollectionTableBody
              rows={rows}
              empty={
                <tr>
                  <td
                    colSpan={8}
                    className="px-3 py-10 text-center text-sm text-foreground-muted"
                  >
                    {search ? "No matching drives" : "No drives mounted"}
                  </td>
                </tr>
              }
            >
              {(row, index) => (
                <CollectionRow
                  onClick={row.managed ? undefined : () => edit(row.id)}
                >
                  <td className={collectionTable.cell}>
                    <span className="text-foreground-muted">{index + 1}</span>
                  </td>
                  <td className={collectionTable.cell}>
                    {row.managed ? (
                      <span
                        className="flex min-w-0 items-center gap-2"
                        title={row.drive?.name}
                      >
                        <HardDrive className="size-4 shrink-0 text-foreground-muted" />
                        <span className="truncate">{row.drive?.name}</span>
                      </span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="max-w-full justify-start px-0"
                        onClick={(event) => {
                          event.stopPropagation()
                          edit(row.id)
                        }}
                      >
                        <HardDrive className="size-4 text-foreground-muted" />
                        <span className="truncate">
                          {row.drive?.name ?? "Unavailable drive"}
                        </span>
                      </Button>
                    )}
                  </td>
                  <td className={collectionTable.cell}>
                    {row.managed ? (
                      <span
                        className="flex items-center gap-2"
                        title={row.drive?.sdkContext?.workspace}
                      >
                        <span className="truncate">
                          {row.drive?.sdkContext?.workspaceName}
                        </span>
                        <span className="shrink-0 text-xs text-foreground-muted">
                          SDK-managed
                        </span>
                      </span>
                    ) : (
                      <span className="text-foreground-muted">Shared</span>
                    )}
                  </td>
                  <td className={collectionTable.cell}>
                    <span
                      className="block truncate font-mono text-foreground-muted"
                      title={row.id}
                    >
                      {row.id}
                    </span>
                  </td>
                  <td className={collectionTable.cell}>
                    <span
                      className="block truncate font-mono text-foreground-muted"
                      title={row.mountPath}
                    >
                      {row.mountPath}
                    </span>
                  </td>
                  <td className={collectionTable.cell}>
                    {
                      storageProviderNames[
                        row.drive?.provider ?? sandbox.provider
                      ]
                    }
                  </td>
                  <td className={collectionTable.cell}>
                    <span className="text-foreground-muted">
                      {row.drive
                        ? new Date(row.drive.createdAt).toLocaleDateString(
                            undefined,
                            { month: "short", day: "numeric", year: "numeric" }
                          )
                        : "—"}
                    </span>
                  </td>
                  <td className={collectionTable.cell}>
                    {row.drive && cloudStorage(row.drive.provider) && (
                      <Button
                        variant="ghost-muted"
                        size="sm"
                        aria-label={`Versions of ${row.drive.name}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          setHistory(row.drive!)
                        }}
                      >
                        {row.drive.syncPending ? "Sync pending" : "Versions"}
                      </Button>
                    )}
                    {!row.managed && (
                      <Button
                        variant="ghost-muted"
                        size="icon-sm"
                        aria-label={`Unmount ${row.drive?.name ?? "drive"}`}
                        title="Unmount drive"
                        onClick={(event) => {
                          event.stopPropagation()
                          unmount(row.id)
                        }}
                      >
                        <X />
                      </Button>
                    )}
                  </td>
                </CollectionRow>
              )}
            </CollectionTableBody>
          </CollectionTable>
        </CollectionPage>
      </CollectionPanel>
      {history && (
        <DriveVersions
          drive={history}
          onClose={() => {
            setHistory(null)
            drives.refresh()
          }}
        />
      )}
      <Sheet
        open={open && active}
        onOpenChange={(value) => {
          if (!pending) setOpen(value)
        }}
      >
        <SheetContent
          showCloseButton={!pending}
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault()
          }}
          onInteractOutside={(event) => {
            if (pending) event.preventDefault()
          }}
        >
          <SheetHeader className="shrink-0 border-b border-border px-6 py-5">
            <SheetTitle>{editingId ? "Drive details" : "Add drive"}</SheetTitle>
            <SheetDescription className="sr-only">
              Configure a persistent drive for this agent.
            </SheetDescription>
          </SheetHeader>
          <form
            onSubmit={(event) => void save(event)}
            className="flex min-h-0 flex-1 flex-col"
          >
            <fieldset
              disabled={pending}
              className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6"
            >
              {error ? (
                <Notice variant="error" role="alert">
                  {error}
                </Notice>
              ) : null}
              {!editingId && !existingId && (
                <FormRow
                  label="Storage"
                  htmlFor="drive-storage"
                  layout="vertical"
                  variant="plain"
                  description="Local volumes stay on the Docker host. Bucket-backed drives keep committed snapshots independently of compute."
                >
                  <Select
                    id="drive-storage"
                    value={storageId}
                    disabled={storage.isLoading}
                    onChange={(event) => setStorageId(event.target.value)}
                  >
                    <option value="">
                      {storageProviderNames[sandbox.provider]}
                    </option>
                    {storage.data?.items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} —{" "}
                        {storageProviderNames[item.config.provider]}
                      </option>
                    ))}
                  </Select>
                  {storage.error && (
                    <Notice variant="error" role="alert">
                      Storage connections could not be loaded.{" "}
                      <Button
                        type="button"
                        size="sm"
                        variant="link"
                        onClick={storage.refresh}
                      >
                        Retry
                      </Button>
                    </Notice>
                  )}
                  {storageId && (
                    <p className="text-xs text-foreground-muted">
                      Regular files and folders only; 16 MiB per file and 64 MiB
                      per drive. Keep installed dependencies on a native volume.
                    </p>
                  )}
                </FormRow>
              )}
              {!existingId ? (
                <>
                  <FormRow
                    label="Name"
                    htmlFor="drive-name"
                    layout="vertical"
                    variant="plain"
                  >
                    <Input
                      id="drive-name"
                      required
                      autoFocus
                      maxLength={120}
                      value={name}
                      readOnly={Boolean(editingId)}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </FormRow>
                  <FormRow
                    label="Description"
                    htmlFor="drive-description"
                    layout="vertical"
                    variant="plain"
                  >
                    <Textarea
                      id="drive-description"
                      rows={3}
                      maxLength={2000}
                      value={description}
                      readOnly={Boolean(editingId)}
                      onChange={(event) => setDescription(event.target.value)}
                    />
                  </FormRow>
                </>
              ) : null}
              <SettingsSection
                title="Advanced settings"
                defaultOpen={false}
                density="compact"
              >
                <div className="space-y-5">
                  {!editingId && available.length ? (
                    <FormRow
                      label="Drive"
                      htmlFor="drive-source"
                      layout="vertical"
                      variant="plain"
                    >
                      <Select
                        id="drive-source"
                        value={existingId}
                        onChange={(event) => setExistingId(event.target.value)}
                      >
                        <option value="">Create a new drive</option>
                        {available.map((drive) => (
                          <option key={drive.id} value={drive.id}>
                            {drive.name}
                          </option>
                        ))}
                      </Select>
                    </FormRow>
                  ) : null}
                  <FormRow
                    label="Mount path"
                    htmlFor="drive-mount-path"
                    layout="vertical"
                    variant="plain"
                  >
                    <Input
                      id="drive-mount-path"
                      required
                      className="font-mono"
                      value={mountPath}
                      onChange={(event) => setMountPath(event.target.value)}
                      spellCheck={false}
                    />
                  </FormRow>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={workingDirectory}
                      onChange={(event) =>
                        setWorkingDirectory(event.target.checked)
                      }
                    />
                    Use as working directory
                  </label>
                </div>
              </SettingsSection>
            </fieldset>
            <SheetFooter className="shrink-0 border-t border-border p-6">
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                loading={pending}
                disabled={!editingId && !existingId && !name.trim()}
              >
                {editingId ? "Save changes" : "Add drive"}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </>
  )
}

/** Sandbox configuration lives with the agent's other settings. */
export function AgentSandboxSettings({ configuration, onChange }: Props) {
  const sandbox = configuration.sandbox
  const workspaceHref = useWorkspaceHref()
  const storage = useRemote(
    (signal) =>
      buildCall<{ items: StorageConnection[] }>(
        "build_list_storage_connections",
        {},
        { signal }
      ),
    []
  )
  function update(value: Partial<AgentSandboxConfiguration>) {
    onChange({ ...configuration, sandbox: { ...sandbox, ...value } })
  }
  return (
    <>
      <InspectorSection label="Web access" variant="form" defaultOpen={false}>
        <FormRow
          label="Read web pages"
          htmlFor="agent-web-fetch"
          controlWidth="auto"
          description="Let the agent open public URLs and read their content."
        >
          <Switch
            id="agent-web-fetch"
            checked={configuration.web.fetchEnabled}
            onCheckedChange={(fetchEnabled) =>
              onChange({
                ...configuration,
                web: { ...configuration.web, fetchEnabled },
              })
            }
          />
        </FormRow>
        <FormRow
          label="Search the web"
          htmlFor="agent-web-search"
          controlWidth="auto"
          description="Find current information using your project's model provider. Search may add provider charges."
        >
          <Switch
            id="agent-web-search"
            checked={configuration.web.searchEnabled}
            onCheckedChange={(searchEnabled) =>
              onChange({
                ...configuration,
                web: { ...configuration.web, searchEnabled },
              })
            }
          />
        </FormRow>
      </InspectorSection>
      <InspectorSection label="Sandbox" variant="form" defaultOpen={false}>
        <FormRow
          label="Enable sandbox"
          htmlFor="agent-sandbox-enabled"
          controlWidth="auto"
          description="Run commands and read, write, edit, and search files. Mounted drives keep files between runs."
        >
          <Switch
            id="agent-sandbox-enabled"
            checked={sandbox.enabled}
            onCheckedChange={(enabled) => update({ enabled })}
          />
        </FormRow>
        <FormRow label="Provider" htmlFor="agent-sandbox-provider">
          <Select
            id="agent-sandbox-provider"
            value={sandbox.provider}
            disabled={sandbox.drives.length > 0}
            title={
              sandbox.drives.length
                ? "Unmount drives to change provider"
                : undefined
            }
            onChange={(event) =>
              update({
                provider: event.target
                  .value as AgentSandboxConfiguration["provider"],
              })
            }
          >
            <option value="datool">Datool Sandbox</option>
            <option value="modal">Modal</option>
            <option value="local">Local container</option>
          </Select>
        </FormRow>
        <FormRow
          label="SDK workspace storage"
          htmlFor="agent-sdk-storage"
          description="Used for new SDK workspaces. Existing workspaces keep their storage; changing it requires an explicit migration."
        >
          <Select
            id="agent-sdk-storage"
            value={sandbox.sdkStorageConnectionId ?? ""}
            disabled={storage.isLoading || Boolean(storage.error)}
            onChange={(event) =>
              update({
                sdkStorageConnectionId: event.target.value || undefined,
              })
            }
          >
            <option value="">{storageProviderNames[sandbox.provider]}</option>
            {sandbox.sdkStorageConnectionId &&
              !storage.data?.items.some(
                (item) => item.id === sandbox.sdkStorageConnectionId
              ) && (
                <option value={sandbox.sdkStorageConnectionId}>
                  Unavailable storage connection
                </option>
              )}
            {storage.data?.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
          {storage.error && (
            <Button variant="link" size="sm" onClick={storage.refresh}>
              Retry storage
            </Button>
          )}
        </FormRow>
        <Button asChild variant="link" size="sm">
          <Link href={workspaceHref("/settings/storage-providers")}>
            Configure storage providers
          </Link>
        </Button>
        <FormRow label="Environment" htmlFor="agent-sandbox-environment">
          <Select
            id="agent-sandbox-environment"
            value={sandbox.environment}
            onChange={(event) =>
              update({
                environment: event.target
                  .value as AgentSandboxConfiguration["environment"],
              })
            }
          >
            <option value="node">Node.js 22</option>
            <option value="python">Python 3.13</option>
          </Select>
        </FormRow>
        <FormRow
          label="Command internet access"
          htmlFor="agent-sandbox-network"
          controlWidth="auto"
        >
          <Switch
            id="agent-sandbox-network"
            checked={sandbox.networkAccess}
            onCheckedChange={(networkAccess) => update({ networkAccess })}
          />
        </FormRow>
        <FormRow label="Working directory" htmlFor="agent-sandbox-workdir">
          <Input
            id="agent-sandbox-workdir"
            className="font-mono"
            value={sandbox.workingDirectory}
            onChange={(event) =>
              update({ workingDirectory: event.target.value })
            }
            spellCheck={false}
          />
        </FormRow>
        <Button asChild variant="link" size="sm">
          <Link href={workspaceHref("/settings/sandbox-providers")}>
            Configure sandbox providers
          </Link>
        </Button>
        {configuration.guardrails.requireHumanForActions && sandbox.enabled ? (
          <Notice variant="warning">
            Command execution requires turning off human approval in Guardrails.
          </Notice>
        ) : null}
      </InspectorSection>
    </>
  )
}
