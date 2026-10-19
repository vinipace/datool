"use client"

import * as React from "react"
import { Check, Plus, UserRound, UsersRound } from "lucide-react"
import { Combobox } from "@/components/ui/combobox"
import { UserAvatarImage } from "@/components/ui/user-avatar"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { useMutation, useRemote } from "@/components/tracer/hooks"
import { asList, buildApi } from "./build-api"

import { TeamEditor } from "@/components/workspace/team-editor"
import type {
  OrganizationTeam as Team,
  TeamMember as Member,
} from "@/src/lib/teams"
type Assignment = { teamId: string | null; assigneeUserId: string | null }
type Ticket = Assignment & {
  id: string
  version?: number
  assigneeName?: string | null
  assigneeImage?: string | null
  teamName?: string | null
}

export function TicketAssignment({
  ticket,
  onChanged,
}: {
  ticket: Ticket
  onChanged: () => void
}) {
  const teams = useRemote(
    (signal) =>
      buildApi.call<unknown>("build_list_teams", {}, signal).then(asList<Team>),
    [],
    { intervalMs: 30_000 }
  )
  const members = useRemote(
    (signal) =>
      buildApi
        .call<unknown>("build_list_organization_members", {}, signal)
        .then(asList<Member>),
    []
  )
  const [draft, setDraft] = React.useState<Assignment | null>(null)
  const [saved, setSaved] = React.useState<Ticket | null>(null)
  const [teamSearch, setTeamSearch] = React.useState("")
  const [teamEditor, setTeamEditor] = React.useState<{
    team?: Team
    name?: string
  } | null>(null)
  const [recentTeam, setRecentTeam] = React.useState<Team | null>(null)
  const save = useMutation()
  const current =
    saved && (saved.version ?? 0) > (ticket.version ?? 0) ? saved : ticket
  const value = draft ?? current
  const recentIsCurrent =
    recentTeam &&
    !(teams.data ?? []).some(
      (team) =>
        team.id === recentTeam.id &&
        (team.updatedAt ?? "") >= (recentTeam.updatedAt ?? "")
    )
  const allTeams = recentIsCurrent
    ? (teams.data ?? [])
        .filter((team) => team.id !== recentTeam.id)
        .concat(recentTeam)
    : (teams.data ?? [])
  const selectedTeam = allTeams.find((team) => team.id === value.teamId)
  const eligibleMembers = (members.data ?? []).filter(
    (member) => !value.teamId || selectedTeam?.memberIds.includes(member.id)
  )
  const dirty =
    value.teamId !== current.teamId ||
    value.assigneeUserId !== current.assigneeUserId
  const query = teamSearch.trim().toLocaleLowerCase()
  const availableTeams = allTeams.filter(
    (team) => team.enabled && team.name.toLocaleLowerCase().includes(query)
  )
  const selectedMember = members.data?.find(
    (member) => member.id === value.assigneeUserId
  )
  const missingAssignee =
    value.assigneeUserId &&
    !eligibleMembers.some((member) => member.id === value.assigneeUserId)
  const missingTeam =
    value.teamId &&
    !allTeams.some((team) => team.id === value.teamId && team.enabled)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!dirty || !current.version || save.isPending) return
    try {
      const result = await save.run(() =>
        buildApi.call<Ticket>("build_assign_ticket", {
          ticketId: ticket.id,
          teamId: value.teamId,
          assigneeUserId: value.assigneeUserId,
          expectedVersion: current.version,
        })
      )
      setSaved(result)
      setDraft(null)
      onChanged()
    } catch {
      /* Keep the draft and show the mutation error. */
    }
  }

  return (
    <>
      <form className="space-y-5" onSubmit={(event) => void submit(event)}>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Team</p>
            {selectedTeam ? (
              <Button
                type="button"
                variant="ghost-muted"
                size="sm"
                onClick={() => setTeamEditor({ team: selectedTeam })}
              >
                Manage members
              </Button>
            ) : null}
          </div>
          <Combobox
            label="Team"
            placeholder={teams.isLoading ? "Loading teams…" : "No team"}
            value={teams.isLoading ? null : (value.teamId ?? "")}
            disabled={teams.isLoading || !!teams.error || save.isPending}
            searchPlaceholder="Search teams…"
            onSearchChange={setTeamSearch}
            selectedOption={
              selectedTeam
                ? {
                    value: selectedTeam.id,
                    label: selectedTeam.name,
                    leading: (
                      <UserAvatarImage name={selectedTeam.name} image={null} />
                    ),
                  }
                : undefined
            }
            options={[
              ...(!query || "no team".includes(query)
                ? [{ value: "", label: "No team", icon: UsersRound }]
                : []),
              ...(missingTeam
                ? [
                    {
                      value: value.teamId!,
                      label: current.teamName ?? "Unavailable team",
                      icon: UsersRound,
                      disabled: true,
                    },
                  ]
                : []),
              ...availableTeams.map((team) => ({
                value: team.id,
                label: team.name,
                description: `${team.memberCount} ${team.memberCount === 1 ? "member" : "members"}`,
                leading: <UserAvatarImage name={team.name} image={null} />,
              })),
              {
                value: "__create_team__",
                label: teamSearch.trim()
                  ? `Create “${teamSearch.trim()}”`
                  : "Create team…",
                icon: Plus,
                group: "Organization",
              },
            ]}
            onValueChange={(id) => {
              if (id === "__create_team__") {
                setTeamEditor({ name: teamSearch.trim() })
                return
              }
              const next = allTeams.find((team) => team.id === id)
              setDraft({
                teamId: id || null,
                assigneeUserId:
                  !id || next?.memberIds.includes(value.assigneeUserId ?? "")
                    ? value.assigneeUserId
                    : null,
              })
            }}
          />
          <p className="text-xs text-foreground-muted">
            Teams are shared across your organization.
          </p>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Assignee</p>
          <Combobox
            label="Assignee"
            placeholder={members.isLoading ? "Loading people…" : "Unassigned"}
            value={members.isLoading ? null : (value.assigneeUserId ?? "")}
            disabled={
              members.isLoading ||
              teams.isLoading ||
              !!members.error ||
              !!teams.error ||
              save.isPending
            }
            searchPlaceholder="Search people…"
            options={[
              { value: "", label: "Unassigned", icon: UserRound },
              ...(missingAssignee
                ? [
                    {
                      value: value.assigneeUserId!,
                      label:
                        selectedMember?.name ??
                        current.assigneeName ??
                        "Unavailable teammate",
                      leading: (
                        <UserAvatarImage
                          name={
                            selectedMember?.name ??
                            current.assigneeName ??
                            "Teammate"
                          }
                          image={
                            selectedMember?.image ??
                            current.assigneeImage ??
                            null
                          }
                        />
                      ),
                      description: "Not in this team",
                      disabled: true,
                    },
                  ]
                : []),
              ...eligibleMembers.map((member) => ({
                value: member.id,
                label: member.name,
                description: member.email,
                descriptionBelow: true,
                keywords: [member.email],
                leading: (
                  <UserAvatarImage name={member.name} image={member.image} />
                ),
              })),
            ]}
            onValueChange={(id) =>
              setDraft({ teamId: value.teamId, assigneeUserId: id || null })
            }
          />
          {value.teamId ? (
            <p className="text-xs text-foreground-muted">
              {selectedTeam?.memberCount
                ? "Choose a member of the selected team."
                : "Add members to this team to assign someone."}
            </p>
          ) : null}
        </div>
        {teams.error || members.error ? (
          <Notice variant="error">
            {teams.error?.message ?? members.error?.message}
            <Button
              type="button"
              variant="ghost-muted"
              size="sm"
              onClick={() => {
                teams.refresh()
                members.refresh()
              }}
            >
              Try again
            </Button>
          </Notice>
        ) : null}
        {save.error ? (
          <Notice variant="error">{save.error.message}</Notice>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          {dirty ? (
            <Button
              type="button"
              variant="ghost-muted"
              size="sm"
              disabled={save.isPending}
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
          ) : saved ? (
            <span
              role="status"
              className="mr-auto flex items-center gap-1.5 text-xs text-foreground-muted"
            >
              <Check className="size-3.5" /> Assignment saved
            </span>
          ) : null}
          <Button
            type="submit"
            size="sm"
            loading={save.isPending}
            disabled={
              !dirty ||
              !current.version ||
              !!teams.error ||
              !!members.error ||
              !!missingTeam ||
              !!missingAssignee
            }
          >
            Save assignment
          </Button>
        </div>
      </form>
      <Sheet
        open={teamEditor !== null}
        onOpenChange={(open) => {
          if (!open) setTeamEditor(null)
        }}
      >
        <SheetContent>
          {teamEditor ? (
            <TeamEditor
              key={teamEditor.team?.id ?? "new"}
              team={teamEditor.team}
              initialName={teamEditor.name}
              members={members.data ?? []}
              membersLoading={members.isLoading}
              membersError={members.error}
              saveTeam={(input, idempotencyKey) =>
                buildApi.call<Team>(
                  teamEditor.team ? "build_update_team" : "build_create_team",
                  input,
                  { idempotencyKey }
                )
              }
              onCancel={() => setTeamEditor(null)}
              onSaved={(team) => {
                setRecentTeam(team)
                teams.refresh()
                setDraft({
                  teamId: team.id,
                  assigneeUserId: team.memberIds.includes(
                    value.assigneeUserId ?? ""
                  )
                    ? value.assigneeUserId
                    : null,
                })
                setTeamEditor(null)
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  )
}
