"use client"

import { SettingsShell } from "./settings-shell"
import { useOrganizationSessionSync } from "@/lib/workspace-selection"
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog"
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  KeyRound,
  LoaderCircle,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Notice } from "@/components/ui/notice"
import { Textarea } from "@/components/ui/textarea"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Card } from "@/components/ui/card"
import { collectionTable } from "@/components/tracer/collection-table-styles"
import {
  workspaceScopes,
  type WorkspaceScope,
} from "@/src/lib/auth/permissions"

type ApiKeySummary = {
  id: string
  name: string | null
  maskedKey: string
  owner: string | null
  scopes: string[]
  createdAt: string
  expiresAt: string | null
}
type OrganizationKeys = {
  organization: { id: string; name: string }
  role: string
  keys: ApiKeySummary[]
  apiKeyCreationDisabled: boolean
}

type KeyResponse = {
  keys: Array<{
    id: string
    name: string | null
    start: string | null
    prefix: string | null
    createdAt: string
    expiresAt: string | null
    enabled: boolean
    scopes: string[]
    createdBy?: string | null
  }>
  canManage: boolean
  total: number
  creationDisabled: boolean
}

async function request<T>(
  organizationId: string,
  method = "GET",
  body?: Record<string, unknown>,
  keyId?: string,
  offset = 0
): Promise<T> {
  const path = `/api/organizations/${encodeURIComponent(organizationId)}/api-keys${keyId ? `/${encodeURIComponent(keyId)}` : ""}`
  const response = await fetch(
    method === "GET" ? `${path}?limit=100&offset=${offset}` : path,
    {
      method,
      credentials: "same-origin",
      cache: "no-store",
      ...(body
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    }
  )
  const result = await response.json()
  if (!response.ok)
    throw new Error(
      result.error?.message ??
        result.message ??
        "Unable to update API keys. Try again."
    )
  return result.data as T
}

function dateLabel(value: string | null) {
  if (!value) return "Never"
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value)
  )
}

export function ApiKeysPage({
  organizationId,
  organizationName,
  embedded = false,
}: {
  organizationId: string
  organizationName: string
  embedded?: boolean
}) {
  useOrganizationSessionSync(organizationId)
  const [data, setData] = useState<OrganizationKeys | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<{
    field: "createdAt" | "expiresAt"
    descending: boolean
  }>({ field: "createdAt", descending: true })
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [scopes, setScopes] = useState<WorkspaceScope[]>(["traces:write"])
  const [expiry, setExpiry] = useState("7776000")
  const [secret, setSecret] = useState("")
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const mutationLock = useRef(false)
  const [dialogError, setDialogError] = useState("")
  const [revoking, setRevoking] = useState<ApiKeySummary | null>(null)
  const [notice, setNotice] = useState("")
  const canManage = data?.role === "owner" || data?.role === "admin"

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const result = await request<KeyResponse>(organizationId)
      const allKeys = [...result.keys]
      while (allKeys.length < result.total) {
        const page = await request<KeyResponse>(
          organizationId,
          "GET",
          undefined,
          undefined,
          allKeys.length
        )
        if (!page.keys.length) break
        allKeys.push(...page.keys)
      }
      setData({
        organization: { id: organizationId, name: organizationName },
        role: result.canManage ? "admin" : "member",
        apiKeyCreationDisabled: result.creationDisabled,
        keys: [...new Map(allKeys.map((key) => [key.id, key])).values()].map(
          (key) => ({
            id: key.id,
            name: key.name,
            owner: key.createdBy ?? organizationName,
            maskedKey: `${key.start || key.prefix || "dtk_"}••••••`,
            scopes: key.scopes,
            createdAt: key.createdAt,
            expiresAt: key.expiresAt,
          })
        ),
      })
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setLoading(false)
    }
  }, [organizationId, organizationName])
  useEffect(() => {
    void Promise.resolve().then(load)
  }, [load])

  function changeOpen(next: boolean) {
    if (mutationLock.current) return
    setOpen(next)
    setSecret("")
    setCopied(false)
    setDialogError("")
    setName("")
    setScopes(["traces:write"])
    setExpiry("7776000")
  }

  async function createKey(event: FormEvent) {
    event.preventDefault()
    if (mutationLock.current || !name.trim() || !scopes.length) return
    mutationLock.current = true
    setBusy(true)
    setDialogError("")
    try {
      const result = await request<{ key: string }>(organizationId, "POST", {
        name: name.trim(),
        scopes,
        expiresIn: expiry === "never" ? null : Number(expiry),
      })
      setSecret(result.key)
      await load()
    } catch (cause) {
      setDialogError((cause as Error).message)
    } finally {
      mutationLock.current = false
      setBusy(false)
    }
  }

  async function revokeKey() {
    if (!revoking || mutationLock.current) return
    mutationLock.current = true
    setBusy(true)
    setDialogError("")
    try {
      await request(organizationId, "DELETE", undefined, revoking.id)
      setNotice(`Revoked ${revoking.name ?? "API key"}.`)
      setRevoking(null)
      await load()
    } catch (cause) {
      setDialogError((cause as Error).message)
    } finally {
      mutationLock.current = false
      setBusy(false)
    }
  }

  async function toggleCreation() {
    if (!data || mutationLock.current) return
    mutationLock.current = true
    setBusy(true)
    setError("")
    try {
      await request(organizationId, "PATCH", {
        creationDisabled: !data.apiKeyCreationDisabled,
      })
      await load()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      mutationLock.current = false
      setBusy(false)
    }
  }

  const filtered = (data?.keys ?? [])
    .filter((key) =>
      `${key.name ?? ""} ${key.owner ?? ""} ${key.maskedKey} ${key.scopes.join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase())
    )
    .sort((a, b) => {
      const left = a[sort.field] ? new Date(a[sort.field]!).getTime() : Infinity
      const right = b[sort.field]
        ? new Date(b[sort.field]!).getTime()
        : Infinity
      return left === right
        ? 0
        : (left < right ? -1 : 1) * (sort.descending ? -1 : 1)
    })

  return (
    <SettingsShell embedded={embedded} title="API keys" backHref="/">
      <section className="p-3 sm:p-4">
        {!embedded && (
          <h1 className="text-lg font-semibold tracking-tight">API keys</h1>
        )}
        {data ? (
          <p className="mt-2 text-sm text-foreground-subtle">
            {data.organization.name}
          </p>
        ) : null}
        <Notice variant="info" className="mt-4">
          <div>
            <p>
              {canManage
                ? "As an organization owner or admin, you can view and manage all API keys for your organization."
                : "Organization owners and admins can manage API keys."}
            </p>
            <p>
              Give each integration its own key and only the permissions it
              needs.
            </p>
          </div>
        </Notice>
        {canManage ? (
          <Card className="mt-4 p-4">
            <label className="flex cursor-pointer items-center gap-3 font-medium">
              <Switch
                checked={data?.apiKeyCreationDisabled ?? false}
                aria-label="Disable API key creation"
                disabled={busy || loading}
                onCheckedChange={() => void toggleCreation()}
              />
              Disable API key creation
            </label>
            <p className="mt-2 text-sm text-foreground-muted">
              Prevent new API keys from being created in this organization.
              Existing keys will continue to work.
            </p>
          </Card>
        ) : null}
        <div className="mt-6 flex items-center gap-3">
          <div className="relative flex-1">
            <Search
              className="absolute top-2.5 left-3 size-4 text-foreground-subtle"
              aria-hidden="true"
            />
            <Input
              aria-label="Find API key"
              placeholder="Find API key"
              className="pl-10"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {canManage ? (
            <Button
              disabled={loading || data?.apiKeyCreationDisabled || busy}
              onClick={() => changeOpen(true)}
            >
              <Plus /> API key
            </Button>
          ) : null}
        </div>
        {error ? (
          <div
            role="alert"
            className="mt-4 flex items-center gap-3 text-sm text-destructive"
          >
            <p>{error}</p>
            <Button variant="ghost" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : null}
        {notice ? (
          <p role="status" className="mt-4 text-sm text-success">
            {notice}
          </p>
        ) : null}
        <div className="relative mt-6 overflow-x-auto" aria-busy={loading}>
          <table className={`${collectionTable.table} min-w-[760px]`}>
            <thead className={collectionTable.head}>
              <tr>
                {["Owner", "Name", "Key", "Scope"].map((label) => (
                  <th key={label} className={collectionTable.heading}>
                    {label}
                  </th>
                ))}
                {(
                  [
                    ["createdAt", "Created"],
                    ["expiresAt", "Expires"],
                  ] as const
                ).map(([field, label]) => (
                  <th
                    key={field}
                    className={collectionTable.heading}
                    aria-sort={
                      sort.field === field
                        ? sort.descending
                          ? "descending"
                          : "ascending"
                        : "none"
                    }
                  >
                    <button
                      className="inline-flex items-center gap-1"
                      onClick={() =>
                        setSort({
                          field,
                          descending:
                            sort.field === field ? !sort.descending : true,
                        })
                      }
                    >
                      {label}
                      {sort.field === field && !sort.descending ? (
                        <ArrowUp className="size-3" />
                      ) : (
                        <ArrowDown className="size-3" />
                      )}
                    </button>
                  </th>
                ))}
                <th className={collectionTable.heading}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {!data && loading ? (
                <tr>
                  <td
                    colSpan={7}
                    className="p-12 text-center text-foreground-subtle"
                  >
                    Loading API keys…
                  </td>
                </tr>
              ) : null}
              {data && !filtered.length ? (
                <tr>
                  <td
                    colSpan={7}
                    className="p-12 text-center text-foreground-subtle"
                  >
                    <KeyRound className="mx-auto mb-3 size-6" />
                    {query
                      ? "No keys match your search."
                      : canManage
                        ? "No API keys yet. Create a key to connect your first integration."
                        : "Ask an organization owner or admin to manage API keys."}
                  </td>
                </tr>
              ) : null}
              {filtered.map((key) => (
                <tr key={key.id} className={collectionTable.row}>
                  <td
                    className={`${collectionTable.cell} max-w-40 truncate`}
                    title={key.owner ?? undefined}
                  >
                    {key.owner ?? "—"}
                  </td>
                  <td
                    className={`${collectionTable.cell} max-w-48 truncate`}
                    title={key.name ?? undefined}
                  >
                    {key.name ?? "Unnamed key"}
                  </td>
                  <td
                    className={`${collectionTable.cell} font-mono text-foreground-muted`}
                  >
                    {key.maskedKey}
                  </td>
                  <td className={`${collectionTable.cell} max-w-64`}>
                    <div className="flex flex-wrap gap-1">
                      {key.scopes.map((scope) => (
                        <span
                          key={scope}
                          className="rounded bg-surface-emphasis px-1.5 py-0.5 text-xs text-foreground-muted"
                        >
                          {scope}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className={`${collectionTable.cell} whitespace-nowrap`}>
                    {dateLabel(key.createdAt)}
                  </td>
                  <td
                    className={`${collectionTable.cell} whitespace-nowrap text-foreground-subtle`}
                  >
                    {dateLabel(key.expiresAt)}
                  </td>
                  <td className={collectionTable.cell}>
                    {canManage ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Revoke ${key.name ?? "API key"}`}
                        onClick={() => {
                          setDialogError("")
                          setRevoking(key)
                        }}
                      >
                        <Trash2 className="size-4 text-foreground-subtle" />
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent showCloseButton={false} className="max-w-lg">
          <DialogTitle className="text-lg font-semibold">
            {secret ? "Your API key is ready" : "Create API key"}
          </DialogTitle>
          <DialogDescription className="mt-2 text-sm text-foreground-muted">
            {secret
              ? "Copy this key now. You won’t be able to see it again."
              : "Choose a name, permissions, and expiration for this integration."}
          </DialogDescription>
          <DialogClose asChild>
            <Button
              aria-label="Close"
              variant="ghost"
              size="icon-sm"
              className="absolute top-3 right-3"
              disabled={busy}
            >
              <X />
            </Button>
          </DialogClose>
          {secret ? (
            <div className="mt-6 space-y-4">
              <label className="grid gap-2 text-sm">
                API key
                <Textarea
                  aria-label="API key"
                  readOnly
                  value={secret}
                  className="font-mono break-all"
                  onFocus={(event) => event.target.select()}
                />
              </label>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(secret)
                      setCopied(true)
                    } catch {
                      setDialogError(
                        "Copy failed. Select the key above and copy it manually."
                      )
                    }
                  }}
                >
                  {copied ? <Check /> : <Copy />}
                  {copied ? "Copied" : "Copy key"}
                </Button>
                <Button onClick={() => changeOpen(false)}>Done</Button>
              </div>
            </div>
          ) : (
            <form onSubmit={createKey} className="mt-6 space-y-5">
              <label className="grid gap-2 text-sm">
                Name
                <Input
                  autoFocus
                  required
                  maxLength={100}
                  placeholder="e.g. Production tracing"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                />
              </label>
              <label className="grid gap-2 text-sm">
                Expires
                <Select
                  value={expiry}
                  onChange={(event) => setExpiry(event.target.value)}
                  disabled={busy}
                >
                  <option value="2592000">In 30 days</option>
                  <option value="7776000">In 90 days</option>
                  <option value="31536000">In 1 year</option>
                  <option value="never">No expiry</option>
                </Select>
              </label>
              <fieldset disabled={busy}>
                <legend className="mb-2 text-sm">Permissions</legend>
                <div className="grid max-h-48 grid-cols-2 gap-2 overflow-auto rounded-lg border border-border p-3">
                  {workspaceScopes.map((scope) => (
                    <label
                      key={scope}
                      className="flex items-center gap-2 text-xs"
                    >
                      <Checkbox
                        checked={scopes.includes(scope)}
                        onChange={(event) =>
                          setScopes((current) =>
                            event.target.checked
                              ? [...current, scope]
                              : current.filter((value) => value !== scope)
                          )
                        }
                      />
                      {scope}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="flex justify-end">
                <Button
                  type="submit"

                  disabled={busy || !name.trim() || !scopes.length}
                >
                  {busy ? <LoaderCircle className="animate-spin" /> : <Plus />}
                  {busy ? "Creating…" : "Create API key"}
                </Button>
              </div>
            </form>
          )}
          {dialogError ? (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {dialogError}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(revoking)}
        onOpenChange={(next) => {
          if (!busy && !next) setRevoking(null)
        }}
      >
        <DialogContent showCloseButton={false} className="max-w-md">
          <DialogTitle className="text-lg font-semibold">
            Revoke {revoking?.name ?? "API key"}?
          </DialogTitle>
          <DialogDescription className="mt-3 text-sm text-foreground-muted">
            Integrations using this key will immediately lose access. This
            cannot be undone.
          </DialogDescription>
          {dialogError ? (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {dialogError}
            </p>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void revokeKey()}
            >
              {busy ? "Revoking…" : "Revoke key"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </SettingsShell>
  )
}
