"use client"

import { useCallback, useState } from "react"
import { CircleCheck, CircleDashed, Plus, UsersRound } from "lucide-react"
import {
  workspaceRequest,
  type WorkspaceOrganization,
} from "@/lib/workspace-api"
import type { OrganizationTeam, OrganizationTeams } from "@/src/lib/teams"
import { useRemote } from "@/components/tracer/hooks"
import { CollectionPanel } from "@/components/tracer/collection-panel"
import {
  CollectionPage,
  CollectionSearch,
} from "@/components/tracer/collection-page"
import { CollectionRow, CollectionTable, CollectionTableBody } from "@/components/tracer/collection-table"
import { collectionTable } from "@/components/tracer/collection-table-styles"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { PanelActionLabel } from "@/components/ui/panel-action-label"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { UserAvatar } from "@/components/ui/user-avatar"
import { TeamEditor } from "./team-editor"

export function TeamsPage({
  organization,
}: {
  organization: WorkspaceOrganization
}) {
  const endpoint = `/api/organizations/${encodeURIComponent(organization.id)}/teams`
  const load = useCallback(
    (signal: AbortSignal) =>
      workspaceRequest<OrganizationTeams>(endpoint, { signal }),
    [endpoint]
  )
  const remote = useRemote(load, [organization.id])
  const [search, setSearch] = useState("")
  const [editor, setEditor] = useState<{ team?: OrganizationTeam } | null>(null)
  const [notice, setNotice] = useState("")
  const data = remote.data
  const members = data?.members ?? []
  const query = search.trim().toLocaleLowerCase()
  const teams = (data?.teams ?? []).filter((team) =>
    [
      team.name,
      team.description,
      ...members
        .filter((member) => team.memberIds.includes(member.id))
        .map((member) => `${member.name} ${member.email}`),
    ].some((value) => value.toLocaleLowerCase().includes(query))
  )

  function open(team?: OrganizationTeam) {
    setNotice("")
    setEditor({ team })
  }

  return (
    <>
      <CollectionPanel label="Teams">
        <CollectionPage
          className="contents"
          state={remote}
          loadingLabel="Loading teams"
          header={{
            exportRows: teams,
            exportName: "teams",
            children: (
              <CollectionSearch
                label="Search teams or members"
                value={search}
                onChange={setSearch}
              />
            ),
            actions: data?.canManage ? (
              <Button size="sm" onClick={() => open()}>
                <Plus />
                <PanelActionLabel>New team</PanelActionLabel>
              </Button>
            ) : undefined,
          }}
          toolbar={
            notice ? (
              <Notice variant="success" role="status">
                {notice}
              </Notice>
            ) : data && !data.canManage ? (
              <p className="p-2 text-xs text-foreground-muted">
                Owners and admins can manage teams and their members.
              </p>
            ) : undefined
          }
        >
          <CollectionTable
            persistenceKey={`organization-teams:${organization.id}`}
            fillHeight
            columnIds={["name", "description", "members", "status", "updated"]}
            widths={[240, 300, 240, 120, 160]}
          >
            <thead className={collectionTable.head}>
              <tr>
                <th
                  scope="col"
                  aria-label="Row number"
                  className={collectionTable.heading}
                >
                  <span className="sr-only">Row number</span>
                </th>
                {["Team", "Description", "Members", "Status", "Updated"].map(
                  (title) => (
                    <th key={title} scope="col" className={collectionTable.heading}>
                      {title}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <CollectionTableBody
              rows={teams}
              empty={
                <tr>
                  <td colSpan={6} className="py-16 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <UsersRound className="size-6 text-foreground-muted" />
                      <p className="text-sm font-medium">
                        {query
                          ? "No matching teams"
                          : "Bring your teammates together"}
                      </p>
                      <p className="text-sm text-foreground-muted">
                        {query
                          ? "Try another team name or member."
                          : "Create groups that work together across your organization’s projects."}
                      </p>
                      {!query && data?.canManage ? (
                        <Button size="sm" onClick={() => open()}>
                          <Plus />
                          Create team
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              }
            >
              {(team, index) => {
                const people = members.filter((member) =>
                  team.memberIds.includes(member.id)
                )
                return (
                  <CollectionRow
                    key={team.id}
                    onClick={data?.canManage ? () => open(team) : undefined}
                    className={data?.canManage ? undefined : "cursor-default"}
                  >
                    <td className={collectionTable.cell}>
                      <span className="text-xs text-foreground-muted tabular-nums">
                        {index + 1}
                      </span>
                    </td>
                    <td className={collectionTable.cell}>
                      <div className="flex min-w-0 items-center gap-2">
                        <UsersRound className="size-4 shrink-0 text-foreground-muted" />
                        {data?.canManage ? (
                          <button
                            type="button"
                            className="truncate text-left hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                            onClick={(event) => {
                              event.stopPropagation()
                              open(team)
                            }}
                            aria-label={`Edit ${team.name}`}
                          >
                            {team.name}
                          </button>
                        ) : (
                          <span className="truncate">{team.name}</span>
                        )}
                      </div>
                    </td>
                    <td className={collectionTable.cell}>
                      <span
                        className="block truncate text-foreground-muted"
                        title={team.description}
                      >
                        {team.description || "—"}
                      </span>
                    </td>
                    <td className={collectionTable.cell}>
                      <div
                        className="flex items-center gap-2"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {people.length ? (
                          <>
                            <div className="flex -space-x-1">
                              {people.slice(0, 4).map((member) => (
                                <UserAvatar
                                  key={member.id}
                                  name={member.name}
                                  image={member.image}
                                />
                              ))}
                            </div>
                            <span className="text-xs text-foreground-muted">
                              {people.length}{" "}
                              {people.length === 1 ? "member" : "members"}
                            </span>
                          </>
                        ) : (
                          <span className="text-foreground-muted">
                            No members
                          </span>
                        )}
                      </div>
                    </td>
                    <td className={collectionTable.cell}>
                      <span className="inline-flex items-center gap-2">
                        {team.enabled ? (
                          <CircleCheck className="size-4 text-status-success" />
                        ) : (
                          <CircleDashed className="size-4 text-foreground-muted" />
                        )}
                        {team.enabled ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className={collectionTable.cell}>
                      <span className="text-foreground-muted">
                        {team.updatedAt
                          ? new Date(team.updatedAt).toLocaleDateString()
                          : "—"}
                      </span>
                    </td>
                  </CollectionRow>
                )
              }}
            </CollectionTableBody>
          </CollectionTable>
        </CollectionPage>
      </CollectionPanel>
      <Sheet
        open={editor !== null}
        onOpenChange={(value) => {
          if (!value) setEditor(null)
        }}
      >
        <SheetContent className="flex flex-col p-0">
          {editor ? (
            <TeamEditor
              key={editor.team?.id ?? "new"}
              team={editor.team}
              members={members}
              membersLoading={remote.isLoading}
              membersError={remote.error}
              showStatus
              onCancel={() => setEditor(null)}
              saveTeam={async (input) => {
                const result = await workspaceRequest<{
                  team: OrganizationTeam
                }>(endpoint, {
                  method: input.id ? "PATCH" : "POST",
                  body: JSON.stringify(input),
                })
                return result.team
              }}
              onSaved={(team) => {
                setEditor(null)
                setNotice(
                  `${team.name} ${editor.team ? "updated" : "created"}.`
                )
                remote.refresh()
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  )
}
