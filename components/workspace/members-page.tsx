"use client"

import { useCallback, useRef, useState, type FormEvent } from "react"
import { Copy, Mail, MoreHorizontal, UserPlus } from "lucide-react"
import { authClient } from "@/lib/auth-client"
import {
  workspaceRequest,
  type WorkspaceOrganization,
} from "@/lib/workspace-api"
import { useRemote } from "@/components/tracer/hooks"
import { CollectionPanel } from "@/components/tracer/collection-panel"
import {
  CollectionPage,
  CollectionSearch,
} from "@/components/tracer/collection-page"
import { LogRow, LogTable, LogTableBody } from "@/components/tracer/log-table"
import { logTable } from "@/components/tracer/log-table-styles"
import { SettingsShell } from "./settings-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  OrganizationRoleBadge,
  OrganizationRoleSelect,
} from "@/components/ui/organization-role"
import { Notice } from "@/components/ui/notice"
import { PanelActionLabel } from "@/components/ui/panel-action-label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import type {
  OrganizationInvitation,
  OrganizationMember,
  OrganizationMembers,
} from "@/src/lib/members"

type Change = { member: OrganizationMember; role?: "admin" | "member" }
function invitationExpired(invitation: OrganizationInvitation) {
  return (
    invitation.expired || new Date(invitation.expiresAt).getTime() <= Date.now()
  )
}

export function MembersPage({
  organization,
  embedded = false,
}: {
  organization: WorkspaceOrganization
  embedded?: boolean
}) {
  const { id: organizationId, name: organizationName } = organization
  const load = useCallback(
    (signal: AbortSignal) =>
      workspaceRequest<OrganizationMembers>(
        `/api/organizations/${encodeURIComponent(organizationId)}/members`,
        { signal }
      ),
    [organizationId]
  )
  const remote = useRemote(load, [organizationId])
  const data = remote.data
  const [search, setSearch] = useState("")
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<"member" | "admin">("member")
  const [dialog, setDialog] = useState<"invite" | "pending" | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [manualLink, setManualLink] = useState<{
    id: string
    url: string
  } | null>(null)
  const [change, setChange] = useState<Change | null>(null)
  const inviteTrigger = useRef<HTMLButtonElement>(null)
  const pendingTrigger = useRef<HTMLButtonElement>(null)
  const memberActionTrigger = useRef<HTMLButtonElement>(null)
  const memberActionTriggers = useRef(new Map<string, HTMLButtonElement>())
  const query = search.trim().toLocaleLowerCase()
  const members = (data?.members ?? []).filter((member) =>
    [member.name, member.email, member.role].some((value) =>
      value.toLocaleLowerCase().includes(query)
    )
  )
  const pendingCount = data?.invitations.length ?? 0
  const manualInvitation = data?.invitations.find(
    (invitation) =>
      invitation.id === manualLink?.id && !invitationExpired(invitation)
  )
  function openDialog(value: "invite" | "pending") {
    setError("")
    setNotice("")
    setManualLink(null)
    setDialog(value)
  }
  function openChange(value: Change) {
    memberActionTrigger.current =
      memberActionTriggers.current.get(value.member.id) ?? null
    setError("")
    setNotice("")
    setChange(value)
  }
  async function mutate(
    key: string,
    action: () => Promise<{ error: { message?: string } | null }>,
    success: string
  ) {
    if (busy) return
    setBusy(key)
    setError("")
    setNotice("")
    setManualLink(null)
    try {
      const result = await action()
      if (result.error)
        throw new Error(result.error.message || "Unable to update members.")
      setNotice(success)
      if (key === "invite") {
        setEmail("")
        setRole("member")
        setDialog(null)
      }
      setChange(null)
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to update members. Try again."
      )
    } finally {
      await remote.refresh()
      setBusy(null)
    }
  }
  async function copyInvitation(invitation: OrganizationInvitation) {
    if (busy) return
    setError("")
    setNotice("")
    setManualLink(null)
    if (invitationExpired(invitation)) {
      setError("This invitation has expired. Resend it to create a fresh link.")
      return
    }
    const url = new URL(
      `/invite/${encodeURIComponent(invitation.id)}`,
      window.location.origin
    ).toString()
    setBusy(`copy-${invitation.id}`)
    try {
      await navigator.clipboard.writeText(url)
      setNotice(`Invitation link copied for ${invitation.email}.`)
    } catch {
      setManualLink({ id: invitation.id, url })
      setError(
        "Clipboard access failed. Select and copy the invitation link below."
      )
    } finally {
      setBusy(null)
    }
  }
  function invite(event: FormEvent) {
    event.preventDefault()
    void mutate(
      "invite",
      () =>
        authClient.organization.inviteMember({
          organizationId,
          email: email.trim(),
          role,
        }),
      "Invitation email sent."
    )
  }
  const modalError = error ? (
    <Notice variant="error" role="alert">
      {error}
    </Notice>
  ) : null
  return (
    <SettingsShell
      title="Members"
      backHref="/projects"
      embedded={embedded}
      organization={organization}
    >
      <CollectionPanel label="Members">
        <CollectionPage
          className="contents"
          state={remote}
          loadingLabel="Loading members"
          header={{
            exportRows: members,
            exportName: "members",
            children: (
              <CollectionSearch
                label="Search members"
                value={search}
                onChange={setSearch}
              />
            ),
            actions: data?.canManage ? (
              <>
                <Button
                  ref={pendingTrigger}
                  size="sm"
                  variant="outline"
                  aria-label={`Pending invitations (${pendingCount})`}
                  onClick={() => openDialog("pending")}
                >
                  <Mail />
                  <PanelActionLabel collapseAt="md">
                    Pending invitations
                  </PanelActionLabel>
                  <span className="tabular-nums">{pendingCount}</span>
                </Button>
                <Button
                  ref={inviteTrigger}
                  size="sm"
                  aria-label="Invite member"
                  onClick={() => openDialog("invite")}
                >
                  <UserPlus />
                  <PanelActionLabel>Invite member</PanelActionLabel>
                </Button>
              </>
            ) : undefined,
          }}
          toolbar={
            <div className="space-y-2">
              {!dialog && !change && modalError}
              {!dialog && notice ? (
                <Notice variant="success" role="status">
                  {notice}
                </Notice>
              ) : null}
              {data && !data.canManage ? (
                <p className="py-2 text-xs text-foreground-muted">
                  Only owners and admins can invite teammates or manage members.
                </p>
              ) : null}
            </div>
          }
        >
          <LogTable
            persistenceKey={`organization-members:${organizationId}`}
            fillHeight
            columnIds={[
              "name",
              "email",
              "role",
              "joined",
              ...(data?.canManage ? ["actions"] : []),
            ]}
            actionColumnIds={data?.canManage ? ["actions"] : []}
            widths={[220, 300, 120, 150, ...(data?.canManage ? [80] : [])]}
          >
            <thead className={logTable.head}>
              <tr>
                <th
                  scope="col"
                  aria-label="Row number"
                  className={logTable.heading}
                >
                  <span className="sr-only">Row number</span>
                </th>
                <th scope="col" className={logTable.heading}>
                  Name
                </th>
                <th scope="col" className={logTable.heading}>
                  Email
                </th>
                <th scope="col" className={logTable.heading}>
                  Role
                </th>
                <th scope="col" className={logTable.heading}>
                  Joined
                </th>
                {data?.canManage ? (
                  <th scope="col" className={logTable.heading}>
                    Actions
                  </th>
                ) : null}
              </tr>
            </thead>
            <LogTableBody
              rows={members}
              empty={
                <tr>
                  <td
                    colSpan={data?.canManage ? 6 : 5}
                    className="py-16 text-center text-sm text-foreground-muted"
                  >
                    {query
                      ? "No matching members. Try a different name, email, or role."
                      : "No members found."}
                  </td>
                </tr>
              }
            >
              {(member, index) => (
                <LogRow key={member.id} className="cursor-default">
                  <td className={logTable.cell}>
                    <span className="text-xs text-foreground-muted tabular-nums">
                      {index + 1}
                    </span>
                  </td>
                  <td className={logTable.cell}>
                    {member.name}
                    {member.userId === data?.currentUserId ? " (you)" : ""}
                  </td>
                  <td className={logTable.cell}>{member.email}</td>
                  <td className={logTable.cell}>
                    <OrganizationRoleBadge role={member.role} />
                  </td>
                  <td className={logTable.cell}>
                    {new Date(member.createdAt).toLocaleDateString()}
                  </td>
                  {data?.canManage ? (
                    <td className={logTable.cell}>
                      {member.role !== "owner" &&
                      member.userId !== data.currentUserId ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Actions for ${member.name}`}
                              disabled={!!busy}
                              ref={(node) => {
                                if (node)
                                  memberActionTriggers.current.set(
                                    member.id,
                                    node
                                  )
                                else
                                  memberActionTriggers.current.delete(member.id)
                              }}
                            >
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            onCloseAutoFocus={(event) => {
                              if (change) event.preventDefault()
                            }}
                          >
                            <DropdownMenuItem
                              disabled={!!busy}
                              onSelect={() =>
                                openChange({
                                  member,
                                  role:
                                    member.role === "admin"
                                      ? "member"
                                      : "admin",
                                })
                              }
                            >
                              {member.role === "admin"
                                ? "Make member"
                                : "Make admin"}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={!!busy}
                              onSelect={() => openChange({ member })}
                            >
                              Remove
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : (
                        <span className="text-foreground-muted">—</span>
                      )}
                    </td>
                  ) : null}
                </LogRow>
              )}
            </LogTableBody>
          </LogTable>
        </CollectionPage>
      </CollectionPanel>
      <Dialog
        open={dialog === "invite"}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null)
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            inviteTrigger.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>Invite member</DialogTitle>
            <DialogDescription>
              Invite a teammate to {organizationName}. They’ll have access to
              every project. Invitations expire after 48 hours.
            </DialogDescription>
          </DialogHeader>
          {modalError}
          {!data?.emailConfigured ? (
            <Notice variant="warning">
              Email invitations are not configured. Ask your installation
              administrator to configure a Resend sender.
            </Notice>
          ) : null}
          <form onSubmit={invite} className="space-y-4">
            <label className="block space-y-2 text-sm">
              Email address
              <Input
                type="email"
                required
                maxLength={254}
                autoComplete="email"
                placeholder="teammate@company.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={!!busy || !data?.emailConfigured}
              />
            </label>
            <div className="space-y-2 text-sm">
              <span>Role</span>
              <OrganizationRoleSelect
                value={role}
                onChange={setRole}
                disabled={!!busy || !data?.emailConfigured}
              />
            </div>
            <p className="text-xs text-foreground-muted">
              Admins can also manage members, API keys, and billing. Your
              teammate joins with their verified Google account.
            </p>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={!!busy}
                onClick={() => setDialog(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                loading={busy === "invite"}
                disabled={!!busy || !data?.emailConfigured || !email.trim()}
              >
                Send invitation
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={dialog === "pending"}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null)
        }}
      >
        <DialogContent
          variant="panel"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            pendingTrigger.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>Pending invitations ({pendingCount})</DialogTitle>
            <DialogDescription>
              Share a link to invite teammates to {organizationName}, even if
              their email wasn’t delivered. They must sign in with the invited
              email. Resend expired invitations to create a fresh link.
            </DialogDescription>
          </DialogHeader>
          {modalError}
          {remote.error ? (
            <Notice variant="error" role="alert">
              {remote.error.message}
            </Notice>
          ) : null}
          {notice ? (
            <Notice variant="success" role="status">
              {notice}
            </Notice>
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto">
            {manualInvitation && manualLink ? (
              <label className="mb-4 block space-y-2 text-sm">
                Invitation link for {manualInvitation.email}
                <Input
                  readOnly
                  autoFocus
                  value={manualLink.url}
                  onFocus={(event) => event.currentTarget.select()}
                  onClick={(event) => event.currentTarget.select()}
                />
              </label>
            ) : null}
            {pendingCount ? (
              <table
                aria-label="Pending invitations"
                className={logTable.table}
              >
                <thead className={logTable.head}>
                  <tr>
                    <th scope="col" className={logTable.heading}>
                      Recipient
                    </th>
                    <th
                      scope="col"
                      className={`${logTable.heading} hidden sm:table-cell`}
                    >
                      Status
                    </th>
                    <th
                      scope="col"
                      className={`${logTable.heading} w-36 sm:w-44`}
                    >
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data?.invitations.map((invitation) => {
                    const expired = invitationExpired(invitation)
                    const delivery =
                      invitation.emailStatus === "sent"
                        ? "Email sent"
                        : "Email not confirmed"
                    const expiry = expired
                      ? "Expired"
                      : `Expires ${new Date(invitation.expiresAt).toLocaleDateString()}`
                    return (
                      <tr key={invitation.id} className="bg-surface-row">
                        <td className={`${logTable.cell} py-3`}>
                          <p className="mb-1 wrap-anywhere">
                            {invitation.email}
                          </p>
                          <OrganizationRoleBadge role={invitation.role} />
                          <div className="mt-2 space-y-1 text-xs text-foreground-muted sm:hidden">
                            <p>{expiry}</p>
                            <p>{delivery}</p>
                          </div>
                        </td>
                        <td
                          className={`${logTable.cell} hidden space-y-1 text-xs text-foreground-muted sm:table-cell`}
                        >
                          <p>{expiry}</p>
                          <p>{delivery}</p>
                        </td>
                        <td className={logTable.cell}>
                          <div className="flex items-center gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              aria-label={`Copy invitation link for ${invitation.email}`}
                              title={
                                expired
                                  ? "Resend this expired invitation to create a fresh link"
                                  : "Copy invitation link"
                              }
                              aria-busy={busy === `copy-${invitation.id}`}
                              disabled={!!busy || expired}
                              onClick={() => void copyInvitation(invitation)}
                            >
                              <Copy className="hidden sm:block" />
                              Copy link
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label={`Invitation actions for ${invitation.email}`}
                                  loading={
                                    busy === invitation.id ||
                                    busy === `cancel-${invitation.id}`
                                  }
                                  disabled={!!busy}
                                >
                                  {busy !== invitation.id &&
                                  busy !== `cancel-${invitation.id}` ? (
                                    <MoreHorizontal />
                                  ) : null}
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  disabled={!!busy || !data.emailConfigured}
                                  onSelect={() =>
                                    void mutate(
                                      invitation.id,
                                      () =>
                                        authClient.organization.inviteMember({
                                          organizationId,
                                          email: invitation.email,
                                          role: invitation.role as
                                            "member" | "admin",
                                          resend: true,
                                        }),
                                      "Invitation email resent."
                                    )
                                  }
                                >
                                  Resend invitation
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  disabled={!!busy}
                                  onSelect={() =>
                                    void mutate(
                                      `cancel-${invitation.id}`,
                                      () =>
                                        authClient.organization.cancelInvitation(
                                          { invitationId: invitation.id }
                                        ),
                                      "Invitation canceled."
                                    )
                                  }
                                >
                                  Cancel invitation
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            ) : (
              <Notice>No pending invitations.</Notice>
            )}
          </div>
          <DialogFooter className="shrink-0">
            <Button
              variant="outline"
              loading={remote.isRefreshing}
              onClick={() => void remote.refresh()}
            >
              Refresh invitations
            </Button>
            <Button disabled={!!busy} onClick={() => setDialog(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!change}
        onOpenChange={(open) => {
          if (!open && !busy) setChange(null)
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            memberActionTrigger.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {change?.role
                ? `Change role to ${change.role}?`
                : "Remove member?"}
            </DialogTitle>
            <DialogDescription>
              {change?.role
                ? `Update ${change.member.email}'s permissions in ${organizationName}. Admins can manage members, API keys, and billing.`
                : `${change?.member.email} will lose access to every project in ${organizationName}.`}
            </DialogDescription>
          </DialogHeader>
          {modalError}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={!!busy}
              onClick={() => setChange(null)}
            >
              Cancel
            </Button>
            <Button
              variant={change?.role ? "default" : "destructive"}
              loading={busy === "member-change"}
              onClick={() => {
                if (change)
                  void mutate(
                    "member-change",
                    () =>
                      change.role
                        ? authClient.organization.updateMemberRole({
                            organizationId,
                            memberId: change.member.id,
                            role: change.role,
                          })
                        : authClient.organization.removeMember({
                            organizationId,
                            memberIdOrEmail: change.member.id,
                          }),
                    change.role ? "Member role updated." : "Member removed."
                  )
              }}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsShell>
  )
}
