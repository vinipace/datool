"use client"

import * as React from "react"
import { Download, Info, Pencil, Plus, Upload, UserRound, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ChannelIcon } from "@/components/build/shared/channel-identity"
import { channelLabel } from "@/components/build/shared/channel-catalog"
import type { ChannelId } from "@/src/lib/build/channels"
import { useMutation, useRemote } from "@/components/tracer/hooks"
import { useWorkspaceStorageScope } from "@/components/tracer/workspace-path"
import { CollectionPanel } from "@/components/tracer/collection-panel"
import {
  CollectionPage,
  CollectionSearch,
} from "@/components/tracer/collection-page"
import { CollectionRow, CollectionTable, CollectionTableBody } from "@/components/tracer/collection-table"
import { collectionTable } from "@/components/tracer/collection-table-styles"
import { useTableView } from "@/components/tracer/use-table-view"
import { useCollectionPages } from "@/components/tracer/use-collection-pages"
import type { CollectionListOptions } from "@/components/tracer/api"
import { CollectionInspectorOverlay } from "@/components/tracer/collection-inspector-overlay"
import { InspectorSection } from "@/components/ui/inspector-section"
import { PanelActionLabel } from "@/components/ui/panel-action-label"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { buildApi, asList, asRecord } from "./build-api"
import { BuildEmpty, BuildState, BuildStatus, FormLabel } from "./build-page"
import { useWideViewport } from "./use-wide-viewport"

type Contact = {
  id?: string
  externalId?: string | null
  displayName?: string | null
  email?: string | null
  phone?: string | null
  status?: string | null
  metadata?: Record<string, unknown>
  lastSeenAt?: string | null
}

type Attribute = {
  key: string
  value: unknown
  source?: string | null
  updatedAt?: string | null
}

type ContactIdentity = {
  id: string
  channel: ChannelId
  identityKey: string
  externalId: string
  displayName: string | null
  connection: { id: string; label: string; status: string } | null
}

function listResult(value: unknown) {
  const record = asRecord(value)
  return {
    items: asList<Contact & { id: string }>(record.items ?? value),
    nextCursor:
      typeof record.nextCursor === "string" ? record.nextCursor : null,
  }
}

function parseImportText(value: string): Contact[] {
  const trimmed = value.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    const rows = Array.isArray(parsed) ? parsed : asList(parsed)
    return rows.filter(
      (row): row is Contact => !!row && typeof row === "object"
    )
  } catch {
    const lines = trimmed.split(/\r?\n/).filter(Boolean)
    const header =
      lines
        .shift()
        ?.split(",")
        .map((part) => part.trim().replace(/^"|"$/g, "")) ?? []
    return lines.map((line) => {
      const values: string[] = []
      let current = ""
      let quoted = false
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index]
        if (character === '"' && line[index + 1] === '"' && quoted) {
          current += '"'
          index += 1
        } else if (character === '"') {
          quoted = !quoted
        } else if (character === "," && !quoted) {
          values.push(current.trim())
          current = ""
        } else {
          current += character
        }
      }
      values.push(current.trim())
      return Object.fromEntries(
        header.map((key, index) => [key, values[index] ?? ""])
      ) as unknown as Contact
    })
  }
}

function formatDate(value?: string | null) {
  if (!value) return "—"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString()
}

function listContacts({
  filter,
  cursor,
  limit,
  signal,
}: CollectionListOptions) {
  const filters = JSON.parse(filter ?? "{}") as {
    search: string
    status: string
    agentId?: string
  }
  return buildApi
    .call<unknown>(
      "build_list_contacts",
      {
        cursor,
        limit,
        search: filters.search || undefined,
        status: filters.status || undefined,
        agentId: filters.agentId,
      },
      signal
    )
    .then(listResult)
}

export function ContactsPage({ fixedAgentId }: { fixedAgentId?: string }) {
  const scope = useWorkspaceStorageScope()
  const tableView = useTableView({
    settingsStorageKey: `datool:build-contacts:${scope}:settings`,
    orderStorageKey: "datool.build-contacts.columns",
  })
  const returnFocusRef = React.useRef<HTMLElement | null>(null)
  const [search, setSearch] = React.useState("")
  const [status, setStatus] = React.useState("")
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const closeContact = React.useCallback(() => {
    setSelectedId(null)
    returnFocusRef.current?.focus()
  }, [])
  const isWide = useWideViewport(900)
  const [showCreate, setShowCreate] = React.useState(false)
  const [showImport, setShowImport] = React.useState(false)
  const [importText, setImportText] = React.useState("")
  const [importError, setImportError] = React.useState<string | null>(null)
  const [form, setForm] = React.useState<Contact>({
    displayName: "",
    email: "",
    phone: "",
    externalId: "",
    status: "active",
  })
  const contacts = useCollectionPages(
    listContacts,
    JSON.stringify({ search, status, agentId: fixedAgentId }),
    0,
    { refreshLoadedPages: true }
  )
  const create = useMutation()
  const importMutation = useMutation()
  const exportMutation = useMutation()

  function openCreate() {
    setForm({
      displayName: "",
      email: "",
      phone: "",
      externalId: "",
      status: "active",
    })
    setShowCreate(true)
  }

  function closeImport() {
    if (importMutation.isPending) return
    setShowImport(false)
    setImportError(null)
  }

  async function saveContact(event: React.FormEvent) {
    event.preventDefault()
    const result = await create.run(() =>
      buildApi.call<Contact>("build_create_contact", {
        displayName: form.displayName || undefined,
        email: form.email || undefined,
        phone: form.phone || undefined,
        externalId: form.externalId || undefined,
        status: form.status || "active",
        metadata: form.metadata ?? {},
      })
    )
    setShowCreate(false)
    if (result.id) setSelectedId(result.id)
    contacts.refresh()
  }

  async function saveImport(event: React.FormEvent) {
    event.preventDefault()
    const rows = parseImportText(importText)
    if (!rows.length) {
      setImportError("Paste at least one contact to import.")
      return
    }
    const missingExternalId = rows.findIndex((row) => !row.externalId?.trim())
    if (missingExternalId >= 0) {
      setImportError(`Row ${missingExternalId + 1} is missing a primary external ID (externalId).`)
      return
    }
    setImportError(null)
    await importMutation.run(() =>
      buildApi.call("build_import_contacts", { source: "csv", rows })
    )
    setImportText("")
    closeImport()
    contacts.refresh()
  }

  async function exportContacts() {
    const result = await exportMutation.run(() =>
      buildApi.call<unknown>("build_export_contacts", {
        format: "csv",
        limit: 1000,
        agentId: fixedAgentId,
        search: search || undefined,
        status: status || undefined,
      })
    )
    const payload = asRecord(result).items
    if (typeof payload !== "string") return
    const blob = new Blob([payload], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "datool-contacts.csv"
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const hasFilters = Boolean(search.trim() || status)

  return (
    <>
      <CollectionPanel label="Contacts">
        <CollectionPage
          className="contents"
          state={contacts}
          loadingLabel="Loading contacts"
          pagination={contacts}
          toolbar={
            exportMutation.error || tableView.storageError ? (
              <Notice variant="error" role="alert" className="mb-2">
                {exportMutation.error?.message ?? tableView.storageError}
              </Notice>
            ) : null
          }
          header={{
            showExport: false,
            children: (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {fixedAgentId ? (
                  <span className="shrink-0 text-sm font-medium">Contacts</span>
                ) : null}
                <CollectionSearch
                  label="Search contacts"
                  value={search}
                  onChange={setSearch}
                />
                <Select
                  aria-label="Contact status"
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                  className="h-8 w-auto max-w-32 text-xs"
                >
                  <option value="">All statuses</option>
                  <option value="active">Active</option>
                  <option value="blocked">Blocked</option>
                  <option value="archived">Archived</option>
                </Select>
              </div>
            ),
            actions: !fixedAgentId ? (
              <Button size="sm" onClick={openCreate} aria-label="New contact">
                <Plus className="size-4" />
                <PanelActionLabel>New contact</PanelActionLabel>
              </Button>
            ) : undefined,
            menuActions: (
              <>
                {!fixedAgentId ? (
                  <DropdownMenuItem onSelect={() => setShowImport(true)}>
                    <Upload className="size-3.5" />
                    Import contacts
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  disabled={exportMutation.isPending}
                  onSelect={() => void exportContacts().catch(() => undefined)}
                >
                  <Download className="size-3.5" />
                  Export contacts CSV
                </DropdownMenuItem>
              </>
            ),
          }}
          isEmpty={!contacts.items.length}
          empty={
            <BuildEmpty
              title={hasFilters ? "No matching contacts" : "No contacts yet"}
              description={
                hasFilters
                  ? "Try another name, email, phone or status."
                  : fixedAgentId
                    ? "Contacts from this agent’s conversations, tickets and lead forms will appear here."
                    : "Create a contact or import a CSV to start your customer directory."
              }
              action={
                hasFilters ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSearch("")
                      setStatus("")
                    }}
                  >
                    Clear filters
                  </Button>
                ) : !fixedAgentId ? (
                  <Button onClick={openCreate}>
                    <Plus className="size-4" />
                    New contact
                  </Button>
                ) : undefined
              }
            />
          }
        >
          <CollectionTable
            fillHeight
            enableCardView
            settings={tableView.settings}
            onSettingsChange={tableView.onSettingsChange}
            columnOrderStore={tableView.columnOrderStore}
            widths={[280, 260, 180, 120, 240, 200]}
            columnIds={[
              "name",
              "email",
              "phone",
              "status",
              "externalId",
              "lastSeenAt",
            ]}
            reorderable
          >
            <thead className={collectionTable.head}>
              <tr>
                <th aria-hidden className={collectionTable.heading} />
                {[
                  "Name",
                  "Email",
                  "Phone",
                  "Status",
                  "Primary external ID",
                  "Last seen",
                ].map((label) => (
                  <th key={label} className={collectionTable.heading}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <CollectionTableBody rows={contacts.items}>
              {(contact) => (
                <CollectionRow
                  key={contact.id}
                  active={selectedId === contact.id}
                  rowLabel={contact.displayName || "Unnamed contact"}
                  tabIndex={0}
                  aria-label={`Open ${contact.displayName || "unnamed contact"}`}
                  onClick={(event) => {
                    returnFocusRef.current = event.currentTarget
                    setSelectedId(contact.id)
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.target === event.currentTarget &&
                      (event.key === "Enter" || event.key === " ")
                    ) {
                      event.preventDefault()
                      returnFocusRef.current = event.currentTarget
                      setSelectedId(contact.id)
                    }
                  }}
                >
                  <td aria-hidden className={collectionTable.cell} />
                  <td className={collectionTable.cell}>
                    <span className="flex min-w-0 items-center gap-2 font-medium">
                      <UserRound
                        aria-hidden
                        className="size-4 shrink-0 text-foreground-muted"
                      />
                      <span className="truncate">
                        {contact.displayName || "Unnamed contact"}
                      </span>
                    </span>
                  </td>
                  <td className={collectionTable.cell}>{contact.email || "—"}</td>
                  <td className={collectionTable.cell}>{contact.phone || "—"}</td>
                  <td className={collectionTable.cell}>
                    <BuildStatus status={contact.status} />
                  </td>
                  <td className={collectionTable.cell}>
                    <span className="text-foreground-muted">
                      {contact.externalId || "—"}
                    </span>
                  </td>
                  <td className={collectionTable.cell}>
                    <span className="text-foreground-muted">
                      {formatDate(contact.lastSeenAt)}
                    </span>
                  </td>
                </CollectionRow>
              )}
            </CollectionTableBody>
          </CollectionTable>
        </CollectionPage>
      </CollectionPanel>
      {selectedId ? (
        <CollectionInspectorOverlay
          title="Contact details"
          description="View this contact, their linked accounts and attributes."
          isWide={isWide}
          onClose={closeContact}
          onRestoreFocus={() => returnFocusRef.current?.focus()}
        >
          <ContactInspector
            key={selectedId}
            contactId={selectedId}
            onClose={closeContact}
            onUpdated={contacts.refresh}
          />
        </CollectionInspectorOverlay>
      ) : null}

      <Dialog
        open={showCreate}
        onOpenChange={(open) => {
          if (!create.isPending) setShowCreate(open)
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Create contact</DialogTitle>
            <DialogDescription>
              Add a customer identity that can be reused across conversations.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => void saveContact(event).catch(() => undefined)}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <FormLabel label="Name">
                <Input
                  autoFocus
                  value={form.displayName ?? ""}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      displayName: event.target.value,
                    }))
                  }
                />
              </FormLabel>
              <FormLabel label="Primary external ID" hint="Optional reference from your CRM or application." hintPlacement="below">
                <Input
                  value={form.externalId ?? ""}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      externalId: event.target.value,
                    }))
                  }
                  placeholder="crm_123"
                />
              </FormLabel>
              <FormLabel label="Email">
                <Input
                  type="email"
                  value={form.email ?? ""}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      email: event.target.value,
                    }))
                  }
                />
              </FormLabel>
              <FormLabel label="Phone">
                <Input
                  value={form.phone ?? ""}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      phone: event.target.value,
                    }))
                  }
                />
              </FormLabel>
              <FormLabel label="Status">
                <Select
                  value={form.status ?? "active"}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      status: event.target.value,
                    }))
                  }
                >
                  <option value="active">Active</option>
                  <option value="blocked">Blocked</option>
                  <option value="archived">Archived</option>
                </Select>
              </FormLabel>
            </div>
            {create.error ? (
              <Notice variant="error">{create.error.message}</Notice>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </Button>
              <Button type="submit" loading={create.isPending}>
                Create contact
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showImport}
        onOpenChange={(open) => {
          if (open) setShowImport(true)
          else closeImport()
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import contacts</DialogTitle>
            <DialogDescription>
              Paste a JSON array or CSV with an external ID and optional name,
              email, phone and status columns.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => void saveImport(event).catch(() => undefined)}
          >
            <Textarea
              autoFocus
              rows={10}
              value={importText}
              onChange={(event) => {
                setImportText(event.target.value)
                setImportError(null)
              }}
              placeholder={
                "displayName,externalId,email\nAda Lovelace,crm_123,ada@example.com"
              }
            />
            <p className="text-xs text-foreground-muted">
              External IDs let us merge repeated imports safely.
            </p>
            {importError ? (
              <Notice variant="error">{importError}</Notice>
            ) : null}
            {importMutation.error ? (
              <Notice variant="error">{importMutation.error.message}</Notice>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeImport}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={importMutation.isPending}
                disabled={!importText.trim()}
              >
                Import contacts
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ContactInspector({
  contactId,
  onClose,
  onUpdated,
}: {
  contactId: string
  onClose: () => void
  onUpdated: () => void
}) {
  const details = useRemote(
    (signal) =>
      buildApi.call<Contact>("build_get_contact", { id: contactId }, signal),
    [contactId]
  )
  const attributes = useRemote(
    (signal) =>
      buildApi
        .call<unknown>("build_list_contact_attributes", { contactId }, signal)
        .then(asList<Attribute>),
    [contactId]
  )
  const identities = useRemote(
    (signal) =>
      buildApi
        .call<unknown>("build_list_contact_identities", { contactId }, signal)
        .then(asList<ContactIdentity>),
    [contactId]
  )
  const update = useMutation()
  const attributeMutation = useMutation()
  const [editing, setEditing] = React.useState(false)
  const [name, setName] = React.useState("")
  const [status, setStatus] = React.useState("active")
  const [attribute, setAttribute] = React.useState({ key: "", value: "" })
  const contact = details.data

  async function save(event: React.FormEvent) {
    event.preventDefault()
    await update.run(() =>
      buildApi.call("build_update_contact", {
        id: contactId,
        displayName: name,
        status,
      })
    )
    setEditing(false)
    details.refresh()
    onUpdated()
  }

  async function saveAttribute(event: React.FormEvent) {
    event.preventDefault()
    if (!attribute.key.trim()) return
    let value: unknown = attribute.value
    try {
      value = JSON.parse(attribute.value)
    } catch {
      /* retain text */
    }
    await attributeMutation.run(() =>
      buildApi.call("build_set_contact_attribute", {
        contactId,
        key: attribute.key.trim(),
        value,
        source: "manual",
      })
    )
    setAttribute({ key: "", value: "" })
    attributes.refresh()
  }

  return (
    <aside
      aria-label="Contact details"
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
    >
      <header className="flex min-h-[53px] shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <UserRound
          aria-hidden
          className="size-4 shrink-0 text-foreground-muted"
        />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {contact?.displayName || "Contact details"}
        </h2>
        {contact ? <BuildStatus status={contact.status} /> : null}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Close contact"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <BuildState
          isLoading={details.isLoading}
          error={details.error}
          onRetry={details.refresh}
        >
          {contact ? (
            <>
              <div className="flex items-center justify-between gap-2 py-4">
                <h3 className="text-sm font-medium">Contact information</h3>
                {!editing ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setName(contact.displayName ?? "")
                      setStatus(contact.status ?? "active")
                      setEditing(true)
                    }}
                  >
                    <Pencil className="size-3.5" />
                    Edit contact
                  </Button>
                ) : null}
              </div>
              {editing ? (
                <form
                  className="grid gap-4 pb-4"
                  onSubmit={(event) => void save(event).catch(() => undefined)}
                >
                  <FormLabel label="Name">
                    <Input
                      autoFocus
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </FormLabel>
                  <FormLabel label="Status">
                    <Select
                      value={status}
                      onChange={(event) => setStatus(event.target.value)}
                    >
                      <option value="active">Active</option>
                      <option value="blocked">Blocked</option>
                      <option value="archived">Archived</option>
                    </Select>
                  </FormLabel>
                  {update.error ? (
                    <Notice variant="error">{update.error.message}</Notice>
                  ) : null}
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={update.isPending}
                      onClick={() => setEditing(false)}
                    >
                      Cancel
                    </Button>
                    <Button type="submit" size="sm" loading={update.isPending}>
                      Save changes
                    </Button>
                  </div>
                </form>
              ) : (
                <dl className="grid gap-4 pb-5 text-sm">
                  {[
                    ["Email", contact.email || "—"],
                    ["Phone", contact.phone || "—"],
                    ["Last seen", formatDate(contact.lastSeenAt)],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="grid grid-cols-[8rem_minmax(0,1fr)] items-baseline gap-3"
                    >
                      <dt className="text-xs text-foreground-muted">{label}</dt>
                      <dd className="min-w-0 break-words">{value}</dd>
                    </div>
                  ))}
                  <div className="grid grid-cols-[8rem_minmax(0,1fr)] items-baseline gap-3">
                    <dt className="flex items-center gap-1 text-xs text-foreground-muted">
                      Primary external ID
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button size="icon-sm" variant="ghost" aria-label="About primary external ID">
                            <Info className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-64">
                          The main reference for imports and integrations. It may be supplied by your application or generated by a channel. Each linked account has its own external ID below.
                        </TooltipContent>
                      </Tooltip>
                    </dt>
                    <dd className="min-w-0 break-all">{contact.externalId || "—"}</dd>
                  </div>
                </dl>
              )}
              <InspectorSection label="Connected accounts">
                <BuildState
                  isLoading={identities.isLoading}
                  error={identities.error}
                  onRetry={identities.refresh}
                >
                  {identities.data?.length ? (
                    <ul aria-label="Connected accounts" className="space-y-2">
                      {identities.data.map((item) => (
                        <li key={item.id} className="rounded-lg bg-muted p-3">
                          <div className="flex items-start gap-2.5">
                            <ChannelIcon channel={item.channel} size="sm" />
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium">{channelLabel(item.channel)}</p>
                              <p className="break-words text-xs text-foreground-muted">
                                {item.connection?.label || "No connection available"}
                              </p>
                            </div>
                            {item.connection ? <BuildStatus status={item.connection.status} /> : null}
                          </div>
                          <dl className="mt-3 grid gap-2 text-xs">
                            {item.displayName ? (
                              <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3">
                                <dt className="text-foreground-muted">Name</dt>
                                <dd className="min-w-0 break-words">{item.displayName}</dd>
                              </div>
                            ) : null}
                            <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3">
                              <dt className="text-foreground-muted">External ID</dt>
                              <dd className="min-w-0 break-all font-mono">{item.externalId}</dd>
                            </div>
                          </dl>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-foreground-muted">
                      No connected accounts yet. Channel accounts appear here when linked to this contact.
                    </p>
                  )}
                </BuildState>
              </InspectorSection>
              <InspectorSection label="Attributes">
                <BuildState
                  isLoading={attributes.isLoading}
                  error={attributes.error}
                  onRetry={attributes.refresh}
                >
                  {attributes.data?.length ? (
                    <dl className="space-y-3 text-sm">
                      {attributes.data.map((item) => (
                        <div key={item.key} className="grid grid-cols-2 gap-3">
                          <dt className="break-words text-foreground-muted">
                            {item.key}
                          </dt>
                          <dd className="min-w-0 break-words">
                            {typeof item.value === "string"
                              ? item.value
                              : JSON.stringify(item.value)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="text-xs text-foreground-muted">
                      No attributes yet.
                    </p>
                  )}
                </BuildState>
                <form
                  className="mt-4 grid gap-3"
                  onSubmit={(event) =>
                    void saveAttribute(event).catch(() => undefined)
                  }
                >
                  <FormLabel label="Attribute name">
                    <Input
                      placeholder="e.g. company"
                      value={attribute.key}
                      onChange={(event) =>
                        setAttribute((current) => ({
                          ...current,
                          key: event.target.value,
                        }))
                      }
                    />
                  </FormLabel>
                  <FormLabel label="Value">
                    <Input
                      placeholder="Value or JSON"
                      value={attribute.value}
                      onChange={(event) =>
                        setAttribute((current) => ({
                          ...current,
                          value: event.target.value,
                        }))
                      }
                    />
                  </FormLabel>
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    className="justify-self-start"
                    loading={attributeMutation.isPending}
                    disabled={!attribute.key.trim()}
                  >
                    <Plus className="size-3.5" />
                    Add attribute
                  </Button>
                  {attributeMutation.error ? (
                    <Notice variant="error">
                      {attributeMutation.error.message}
                    </Notice>
                  ) : null}
                </form>
              </InspectorSection>
              {Object.keys(contact.metadata ?? {}).length ? (
                <InspectorSection label="Metadata" defaultOpen={false}>
                  <pre className="overflow-auto text-xs break-words whitespace-pre-wrap text-foreground-muted">
                    {JSON.stringify(contact.metadata, null, 2)}
                  </pre>
                </InspectorSection>
              ) : null}
            </>
          ) : null}
        </BuildState>
      </div>
    </aside>
  )
}
