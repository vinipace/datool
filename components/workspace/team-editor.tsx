"use client"

import * as React from "react"
import { ComboboxMultiple } from "@/components/ui/combobox"
import { UserAvatarImage } from "@/components/ui/user-avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Notice } from "@/components/ui/notice"
import {
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet"
import { useMutation } from "@/components/tracer/hooks"
import type {
  OrganizationTeam as Team,
  TeamMember as Member,
  TeamEditorInput,
} from "@/src/lib/teams"

export function TeamEditor({
  team,
  initialName,
  members,
  membersLoading,
  membersError,
  onCancel,
  saveTeam,
  showStatus = false,
  onSaved,
}: {
  team?: Team
  initialName?: string
  members: Member[]
  membersLoading: boolean
  membersError: Error | null
  showStatus?: boolean
  saveTeam: (input: TeamEditorInput, idempotencyKey: string) => Promise<Team>
  onCancel: () => void
  onSaved: (team: Team) => void
}) {
  const [name, setName] = React.useState(team?.name ?? initialName ?? "")
  const [description, setDescription] = React.useState(team?.description ?? "")
  const [memberIds, setMemberIds] = React.useState(team?.memberIds ?? [])
  const [enabled, setEnabled] = React.useState(team?.enabled ?? true)
  const save = useMutation()
  const request = React.useRef<{ fingerprint: string; key: string } | null>(
    null
  )
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim() || save.isPending) return
    const input = {
      ...(team ? { id: team.id } : {}),
      name: name.trim(),
      description: description.trim(),
      memberIds,
      enabled,
    }
    const fingerprint = JSON.stringify(input)
    if (request.current?.fingerprint !== fingerprint)
      request.current = { fingerprint, key: crypto.randomUUID() }
    const idempotencyKey = request.current.key
    try {
      const result = await save.run(() => saveTeam(input, idempotencyKey))
      onSaved(result)
    } catch {
      /* Keep the form open so the user can correct or retry. */
    }
  }
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => void submit(event)}
    >
      <SheetHeader className="border-b border-border px-5 py-4 pr-12">
        <SheetTitle>{team ? "Manage team" : "Create team"}</SheetTitle>
        <SheetDescription>
          Group people who work together. This team is available in every
          project in your organization.
        </SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
        <div className="space-y-2">
          <label htmlFor="team-name" className="text-sm font-medium">
            Team name
          </label>
          <Input
            id="team-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Customer support"
            required
            maxLength={160}
            disabled={save.isPending}
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="team-description" className="text-sm font-medium">
            Description{" "}
            <span className="font-normal text-foreground-muted">
              (optional)
            </span>
          </label>
          <Textarea
            id="team-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What does this team help with?"
            rows={3}
            maxLength={2000}
            disabled={save.isPending}
          />
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Members</p>
          <ComboboxMultiple
            label="Team members"
            placeholder={membersLoading ? "Loading people…" : "Add people…"}
            value={memberIds}
            onValueChange={setMemberIds}
            disabled={membersLoading || !!membersError || save.isPending}
            maxSelected={500}
            options={members.map((member) => ({
              value: member.id,
              label: member.name,
              description: member.email,
              keywords: [member.email],
              leading: (
                <UserAvatarImage name={member.name} image={member.image} />
              ),
            }))}
          />
          <p className="text-xs text-foreground-muted">
            Only people already in your organization can join.
          </p>
        </div>
        {showStatus ? (
          <div className="flex items-start justify-between gap-4 border-t border-border pt-5">
            <div className="space-y-1">
              <label htmlFor="team-enabled" className="text-sm font-medium">
                Active team
              </label>
              <p
                id="team-enabled-description"
                className="text-xs text-foreground-muted"
              >
                Inactive teams keep their members and history but cannot receive
                new assignments.
              </p>
            </div>
            <Switch
              id="team-enabled"
              aria-describedby="team-enabled-description"
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={save.isPending}
            />
          </div>
        ) : null}
        {membersError ? (
          <Notice variant="error">
            People could not be loaded: {membersError.message}
          </Notice>
        ) : null}
        {save.error ? (
          <Notice variant="error">{save.error.message}</Notice>
        ) : null}
      </div>
      <SheetFooter className="border-t border-border p-5">
        <Button
          type="button"
          variant="outline"
          disabled={save.isPending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          loading={save.isPending}
          disabled={!name.trim() || membersLoading || !!membersError}
        >
          {team ? "Save team" : "Create team"}
        </Button>
      </SheetFooter>
    </form>
  )
}
