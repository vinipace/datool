"use client"

import * as React from "react"
import Link from "next/link"
import {
  CalendarClock,
  CheckCircle2,
  Clock3,
  History,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { FormRow } from "@/components/ui/form-row"
import { InspectorSection } from "@/components/ui/inspector-section"
import { Notice } from "@/components/ui/notice"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { useCollectionPages } from "@/components/tracer/use-collection-pages"
import { useWorkspaceHref } from "@/components/tracer/workspace-path"
import {
  buildCall,
  buildOperations,
  formatBuildError,
} from "../shared/build-api"
import type {
  AgentConfiguration,
  BuildChannel,
} from "@/src/lib/build/contracts"
import type { ApiList } from "@/src/lib/tracer/contracts"
import {
  taskRunStatusLabels,
  type ScheduledTask,
  type ScheduledTaskInput,
  type ScheduledTaskRun,
} from "@/src/lib/build/schedules"

type Frequency = "once" | "daily" | "weekly" | "custom"
type Draft = {
  name: string
  prompt: string
  frequency: Frequency
  time: string
  weekday: string
  at: string
  expression: string
  timezone: string
  channel: BuildChannel
  enabled: boolean
}
const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]
function localDate(value: Date) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16)
}
function newDraft(channel: BuildChannel): Draft {
  return {
    name: "",
    prompt: "",
    frequency: "daily",
    time: "09:00",
    weekday: "1",
    at: localDate(new Date(Date.now() + 3600_000)),
    expression: "0 9 * * 1-5",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    channel,
    enabled: true,
  }
}
function editDraft(task: ScheduledTask): Draft {
  const draft = {
    ...newDraft(task.channel),
    name: task.name,
    prompt: task.prompt,
    timezone: task.timezone,
    enabled: task.status === "active",
  }
  if (task.schedule.kind === "once")
    return {
      ...draft,
      frequency: "once",
      at: localDate(new Date(task.schedule.at)),
    }
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/.exec(
    task.schedule.expression
  )
  return match
    ? {
        ...draft,
        frequency: match[3] === "*" ? "daily" : "weekly",
        time: `${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}`,
        weekday: match[3] === "*" ? "1" : match[3],
      }
    : { ...draft, frequency: "custom", expression: task.schedule.expression }
}
function describeSchedule(task: ScheduledTask) {
  if (task.schedule.kind === "once") return "One time"
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/.exec(
    task.schedule.expression
  )
  return match
    ? `${match[3] === "*" ? "Daily" : weekdays[Number(match[3])]} at ${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}`
    : task.schedule.expression
}
function dateLabel(value: string | null, timezone: string) {
  return value
    ? new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: timezone,
      }).format(new Date(value))
    : "—"
}
function TaskRunStatus({ run }: { run: ScheduledTaskRun }) {
  const color =
    run.status === "completed"
      ? "text-success-foreground"
      : run.status === "failed" || run.status === "blocked"
        ? "text-destructive"
        : run.status === "needs_attention"
          ? "text-warning-foreground"
          : "text-foreground-muted"
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${color}`}
      title={run.error ?? undefined}
    >
      {run.status === "completed" ? (
        <CheckCircle2 className="size-3.5" />
      ) : (
        <Clock3 className="size-3.5" />
      )}
      {taskRunStatusLabels[run.status]}
    </span>
  )
}

export function AgentScheduledTasks({
  agentId,
  configuration,
}: {
  agentId: string
  configuration: AgentConfiguration
}) {
  const [search, setSearch] = React.useState("")
  const list = React.useCallback(
    ({
      cursor,
      limit,
      signal,
      filter,
    }: {
      cursor?: string
      limit?: number
      signal?: AbortSignal
      filter?: string
    }) =>
      buildCall<ApiList<ScheduledTask>>(
        buildOperations.listScheduledTasks,
        { agentId, cursor, limit, search: filter || undefined },
        { signal }
      ),
    [agentId]
  )
  const tasks = useCollectionPages(list, search, 5000, {
    refreshLoadedPages: true,
  })
  const [editing, setEditing] = React.useState<ScheduledTask | null>(null)
  const [open, setOpen] = React.useState(false)
  const [history, setHistory] = React.useState<ScheduledTask | null>(null)
  const channels = configuration.channelAllowlist.filter(
    (channel) => configuration.channelOverrides[channel]?.enabled !== false
  )
  const [draft, setDraft] = React.useState<Draft>(() =>
    newDraft(channels.includes("web") ? "web" : (channels[0] ?? "api"))
  )
  const [pending, setPending] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState<ScheduledTask | null>(null)
  const fields = React.useId()
  const workspaceHref = useWorkspaceHref()
  const conversationHref = (id: string) =>
    workspaceHref(
      `/build/agents/${encodeURIComponent(agentId)}?section=conversations&conversation=${encodeURIComponent(id)}`
    )
  function begin(task?: ScheduledTask) {
    setEditing(task ?? null)
    setDraft(
      task
        ? editDraft(task)
        : newDraft(channels.includes("web") ? "web" : (channels[0] ?? "api"))
    )
    setFormError(null)
    setOpen(true)
  }
  async function mutate(action: () => Promise<unknown>, message?: string) {
    setPending(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      tasks.refresh()
      if (message) setNotice(message)
    } catch (failure) {
      setError(formatBuildError(failure))
    } finally {
      setPending(false)
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setFormError(null)
    try {
      const [hour, minute] = draft.time.split(":").map(Number)
      const input: ScheduledTaskInput = {
        agentId,
        name: draft.name,
        prompt: draft.prompt,
        timezone: draft.timezone,
        channel: draft.channel,
        enabled: draft.enabled,
        schedule:
          draft.frequency === "once"
            ? { kind: "once", at: new Date(draft.at).toISOString() }
            : {
                kind: "cron",
                expression:
                  draft.frequency === "custom"
                    ? draft.expression
                    : `${minute} ${hour} * * ${draft.frequency === "weekly" ? draft.weekday : "*"}`,
              },
      }
      await buildCall(
        editing
          ? buildOperations.updateScheduledTask
          : buildOperations.createScheduledTask,
        {
          ...input,
          ...(editing
            ? { id: editing.id, expectedRevision: editing.revision }
            : {}),
        }
      )
      setOpen(false)
      tasks.refresh()
    } catch (failure) {
      setFormError(formatBuildError(failure))
    } finally {
      setPending(false)
    }
  }
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }))
  return (
    <>
      <CollectionPanel label="Scheduled tasks" compactToolbar>
        <CollectionPage
          className="contents"
          state={tasks}
          pagination={tasks}
          loadingLabel="Loading scheduled tasks"
          isEmpty={tasks.items.length === 0}
          empty={
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center text-sm text-foreground-muted">
              <CalendarClock className="size-6" />
              <p className="max-w-sm">
                {search
                  ? "No matching tasks"
                  : "No scheduled tasks yet. Create a task to run your agent automatically."}
              </p>
            </div>
          }
          header={{
            children: (
              <CollectionSearch
                label="Search tasks"
                value={search}
                onChange={setSearch}
              />
            ),
            actions: (
              <Button
                size="sm"
                onClick={() => begin()}
                disabled={!channels.length}
              >
                <Plus />
                <span className="hidden @min-[480px]/page:inline">
                  New task
                </span>
                <span className="sr-only @min-[480px]/page:hidden">
                  New task
                </span>
              </Button>
            ),
            showExport: false,
          }}
          toolbar={
            error ? (
              <Notice variant="error" role="alert" layout="banner">
                {error}
              </Notice>
            ) : notice ? (
              <Notice variant="success" role="status" layout="banner">
                {notice}
              </Notice>
            ) : null
          }
        >
          <CollectionTable
            fillHeight
            enableCardView={false}
            widths={[280, 240, 130, 220, 200, 180, 190, 48]}
            columnIds={[
              "name",
              "workspace",
              "status",
              "schedule",
              "timezone",
              "next",
              "last",
              "actions",
            ]}
            actionColumnIds={["actions"]}
            persistenceKey={`agent-scheduled-tasks:${agentId}`}
          >
            <thead className={collectionTable.head}>
              <tr>
                <th className={collectionTable.heading} aria-hidden />
                {[
                  "Name",
                  "Workspace",
                  "Status",
                  "Schedule",
                  "Time zone",
                  "Next run",
                  "Last run",
                ].map((label) => (
                  <th key={label} className={collectionTable.heading}>
                    {label}
                  </th>
                ))}
                <th className={collectionTable.heading}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <CollectionTableBody
              rows={tasks.items}
              empty={
                <tr>
                  <td
                    colSpan={9}
                    className="px-3 py-12 text-center text-sm text-foreground-muted"
                  >
                    {search
                      ? "No matching tasks"
                      : "No scheduled tasks yet. Create a task to run your agent automatically."}
                  </td>
                </tr>
              }
            >
              {(task, index) => (
                <CollectionRow onClick={() => begin(task)}>
                  <td className={collectionTable.cell}>{index + 1}</td>
                  <td className={collectionTable.cell}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="max-w-full justify-start px-0"
                      onClick={(event) => {
                        event.stopPropagation()
                        begin(task)
                      }}
                    >
                      <CalendarClock className="size-4 text-foreground-muted" />
                      <span className="truncate">{task.name}</span>
                    </Button>
                  </td>
                  <td className={collectionTable.cell}>
                    {task.sdkContext ? (
                      <span
                        className="flex items-center gap-2"
                        title={task.sdkContext.workspace ?? undefined}
                      >
                        <span className="truncate">
                          {task.sdkContext.workspaceName ??
                            "No workspace drive"}
                        </span>
                        <span className="shrink-0 text-xs text-foreground-muted">SDK-managed</span>
                      </span>
                    ) : (
                      <span className="text-foreground-muted">Shared</span>
                    )}
                  </td>
                  <td className={collectionTable.cell}>
                    <span
                      className={
                        task.status === "active"
                          ? "text-success-foreground"
                          : "text-foreground-muted"
                      }
                    >
                      {task.status === "active"
                        ? "Active"
                        : task.status === "paused"
                          ? "Paused"
                          : "Finished"}
                    </span>
                  </td>
                  <td className={collectionTable.cell}>
                    {describeSchedule(task)}
                  </td>
                  <td className={collectionTable.cell}>
                    <span className="text-foreground-muted">
                      {task.timezone}
                    </span>
                  </td>
                  <td className={collectionTable.cell}>
                    <time
                      dateTime={task.nextRunAt ?? undefined}
                      title={task.nextRunAt ?? undefined}
                    >
                      {dateLabel(task.nextRunAt, task.timezone)}
                    </time>
                  </td>
                  <td className={collectionTable.cell}>
                    {task.lastRun ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="px-0"
                        onClick={(event) => {
                          event.stopPropagation()
                          setHistory(task)
                        }}
                      >
                        <TaskRunStatus run={task.lastRun} />
                      </Button>
                    ) : (
                      <span className="text-foreground-muted">Not run yet</span>
                    )}
                  </td>
                  <td
                    className={collectionTable.cell}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost-muted"
                          size="icon-sm"
                          aria-label={`Actions for ${task.name}`}
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          disabled={
                            pending ||
                            task.lastRun?.status === "queued" ||
                            task.lastRun?.status === "running"
                          }
                          onClick={() =>
                            void mutate(
                              () =>
                                buildCall(buildOperations.runScheduledTask, {
                                  agentId,
                                  id: task.id,
                                }),
                              "Task queued. Its result will appear in Conversations."
                            )
                          }
                        >
                          <Play />
                          Run now
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={pending || task.status === "completed"}
                          onClick={() =>
                            void mutate(() =>
                              buildCall(buildOperations.updateScheduledTask, {
                                agentId,
                                id: task.id,
                                expectedRevision: task.revision,
                                name: task.name,
                                prompt: task.prompt,
                                channel: task.channel,
                                schedule: task.schedule,
                                timezone: task.timezone,
                                enabled: task.status !== "active",
                              })
                            )
                          }
                        >
                          {task.status === "active" ? <Pause /> : <Play />}
                          {task.status === "active" ? "Pause" : "Resume"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setHistory(task)}>
                          <History />
                          Run history
                        </DropdownMenuItem>
                        {task.lastRun?.conversationId ? (
                          <DropdownMenuItem asChild>
                            <Link
                              href={conversationHref(
                                task.lastRun.conversationId
                              )}
                            >
                              Open last conversation
                            </Link>
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={pending}
                          onClick={() => setDeleting(task)}
                        >
                          <Trash2 />
                          Delete task
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </CollectionRow>
              )}
            </CollectionTableBody>
          </CollectionTable>
        </CollectionPage>
      </CollectionPanel>
      <Sheet
        open={open}
        onOpenChange={(value) => {
          if (!pending) setOpen(value)
        }}
      >
        <SheetContent>
          <SheetHeader className="shrink-0 border-b border-border px-6 py-5">
            <SheetTitle>
              {editing ? "Edit task" : "New scheduled task"}
            </SheetTitle>
            <SheetDescription>
              Tell your agent what to do and when. Results are saved in
              Conversations.
            </SheetDescription>
          </SheetHeader>
          <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
            {formError ? (
              <Notice variant="error" role="alert" layout="banner">
                {formError}
              </Notice>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {editing?.sdkContext && (
                <Notice variant="info" layout="banner">
                  <p>
                    <strong>
                      {editing.sdkContext.workspaceName ?? "No workspace drive"}
                    </strong>{" "}
                    · SDK-managed
                  </p>
                  <p>
                    This task keeps its original workspace, drive and
                    conversation for every run.
                  </p>
                  <p className="font-mono text-xs break-all">
                    {editing.sdkContext.driveId
                      ? `Drive: ${editing.sdkContext.workspace} · /workspace`
                      : "No drive attached"}
                  </p>
                  <Link
                    className="underline"
                    href={conversationHref(editing.sdkContext.conversationId)}
                  >
                    Open workspace conversation
                  </Link>
                </Notice>
              )}
              <FormRow
                label="Name"
                htmlFor={`${fields}-name`}
                layout="vertical"
              >
                <Input
                  id={`${fields}-name`}
                  required
                  maxLength={160}
                  placeholder="Daily customer summary"
                  value={draft.name}
                  onChange={(event) => update("name", event.target.value)}
                />
              </FormRow>
              <FormRow
                label="Instructions"
                htmlFor={`${fields}-prompt`}
                layout="vertical"
              >
                <Textarea
                  id={`${fields}-prompt`}
                  required
                  maxLength={20_000}
                  rows={5}
                  placeholder="Review today's conversations and summarize the most common questions."
                  value={draft.prompt}
                  onChange={(event) => update("prompt", event.target.value)}
                />
              </FormRow>
              <FormRow label="Repeat" htmlFor={`${fields}-repeat`}>
                <Select
                  id={`${fields}-repeat`}
                  value={draft.frequency}
                  onChange={(event) =>
                    update("frequency", event.target.value as Frequency)
                  }
                >
                  <option value="once">One time</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="custom">Custom schedule</option>
                </Select>
              </FormRow>
              {draft.frequency === "once" ? (
                <FormRow
                  label="Date and time"
                  htmlFor={`${fields}-at`}
                  layout="vertical"
                  description={`Your local time (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`}
                >
                  <Input
                    id={`${fields}-at`}
                    type="datetime-local"
                    required
                    value={draft.at}
                    onChange={(event) => update("at", event.target.value)}
                  />
                </FormRow>
              ) : (
                <>
                  {draft.frequency === "weekly" ? (
                    <FormRow label="Day" htmlFor={`${fields}-day`}>
                      <Select
                        id={`${fields}-day`}
                        value={draft.weekday}
                        onChange={(event) =>
                          update("weekday", event.target.value)
                        }
                      >
                        {weekdays.map((day, index) => (
                          <option key={day} value={index}>
                            {day}
                          </option>
                        ))}
                      </Select>
                    </FormRow>
                  ) : null}
                  {draft.frequency === "custom" ? (
                    <FormRow
                      label="Cron expression"
                      htmlFor={`${fields}-cron`}
                      layout="vertical"
                      description="Minute, hour, day, month, weekday. For example, 0 9 * * 1-5 runs at 09:00 on weekdays."
                    >
                      <Input
                        id={`${fields}-cron`}
                        required
                        value={draft.expression}
                        onChange={(event) =>
                          update("expression", event.target.value)
                        }
                      />
                    </FormRow>
                  ) : (
                    <FormRow label="Time" htmlFor={`${fields}-time`}>
                      <Input
                        id={`${fields}-time`}
                        type="time"
                        required
                        value={draft.time}
                        onChange={(event) => update("time", event.target.value)}
                      />
                    </FormRow>
                  )}
                  <FormRow
                    label="Time zone"
                    htmlFor={`${fields}-zone`}
                    layout="vertical"
                  >
                    <Input
                      id={`${fields}-zone`}
                      list={`${fields}-zones`}
                      required
                      value={draft.timezone}
                      onChange={(event) =>
                        update("timezone", event.target.value)
                      }
                    />
                    <datalist id={`${fields}-zones`}>
                      {Intl.supportedValuesOf("timeZone").map((zone) => (
                        <option key={zone} value={zone} />
                      ))}
                      <option value="UTC" />
                    </datalist>
                  </FormRow>
                </>
              )}
              <FormRow
                label="Enabled"
                htmlFor={`${fields}-enabled`}
                description="Pausing stops future runs. Work already started can finish."
                controlWidth="auto"
              >
                <Switch
                  id={`${fields}-enabled`}
                  checked={draft.enabled}
                  onCheckedChange={(value) => update("enabled", value)}
                />
              </FormRow>
              <InspectorSection
                label="Advanced settings"
                variant="form"
                defaultOpen={false}
              >
                <FormRow
                  label="Channel settings"
                  htmlFor={`${fields}-channel`}
                  layout="vertical"
                  description={
                    editing?.sdkContext
                      ? "Uses the original React SDK conversation and workspace drive."
                      : "Uses this channel's instructions, tools and guardrails. Each run starts a fresh conversation."
                  }
                >
                  <Select
                    id={`${fields}-channel`}
                    disabled={Boolean(editing?.sdkContext)}
                    value={draft.channel}
                    onChange={(event) =>
                      update("channel", event.target.value as BuildChannel)
                    }
                  >
                    {[...new Set([...channels, draft.channel])].map(
                      (channel) => (
                        <option key={channel} value={channel}>
                          {channel === "web"
                            ? "Web chat"
                            : channel === "api"
                              ? "API"
                              : channel[0].toUpperCase() + channel.slice(1)}
                        </option>
                      )
                    )}
                  </Select>
                </FormRow>
              </InspectorSection>
            </div>
            <SheetFooter className="shrink-0 border-t border-border px-6 py-4">
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" loading={pending}>
                {editing ? "Save changes" : "Create task"}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
      <Sheet
        open={!!history}
        onOpenChange={(value) => {
          if (!value) setHistory(null)
        }}
      >
        <SheetContent>
          <SheetHeader className="shrink-0 border-b border-border px-6 py-5">
            <SheetTitle>Run history</SheetTitle>
            <SheetDescription>{history?.name}</SheetDescription>
          </SheetHeader>
          {history ? <TaskRunHistory agentId={agentId} task={history} /> : null}
        </SheetContent>
      </Sheet>
      <Sheet
        open={!!deleting}
        onOpenChange={(value) => {
          if (!pending && !value) setDeleting(null)
        }}
      >
        <SheetContent>
          <SheetHeader className="shrink-0 border-b border-border px-6 py-5">
            <SheetTitle>Delete task</SheetTitle>
            <SheetDescription>
              Delete {deleting?.name}? Future runs will stop. Existing
              conversations and already started runs are kept.
            </SheetDescription>
          </SheetHeader>
          <SheetFooter className="shrink-0 border-t border-border px-6 py-4">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setDeleting(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={pending}
              onClick={() => {
                if (!deleting) return
                void mutate(async () => {
                  await buildCall(buildOperations.deleteScheduledTask, {
                    agentId,
                    id: deleting.id,
                    expectedRevision: deleting.revision,
                  })
                  setDeleting(null)
                })
              }}
            >
              Delete task
            </Button>
          </SheetFooter>
          {error ? (
            <Notice variant="error" role="alert">
              {error}
            </Notice>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  )
}

function TaskRunHistory({
  agentId,
  task,
}: {
  agentId: string
  task: ScheduledTask
}) {
  const workspaceHref = useWorkspaceHref()
  const list = React.useCallback(
    ({
      cursor,
      limit,
      signal,
    }: {
      cursor?: string
      limit?: number
      signal?: AbortSignal
    }) =>
      buildCall<ApiList<ScheduledTaskRun>>(
        buildOperations.listScheduledTaskRuns,
        { agentId, taskId: task.id, cursor, limit },
        { signal }
      ),
    [agentId, task.id]
  )
  const runs = useCollectionPages(list, "", 5000, { refreshLoadedPages: true })
  return (
    <CollectionPanel label="Task runs" compactToolbar>
      <CollectionPage
        className="contents"
        state={runs}
        pagination={runs}
        loadingLabel="Loading run history"
        header={{ showExport: false }}
      >
        <CollectionTable
          fillHeight
          enableCardView={false}
          widths={[180, 170, 110, 230]}
          columnIds={["date", "status", "source", "result"]}
        >
          <thead className={collectionTable.head}>
            <tr>
              <th className={collectionTable.heading} aria-hidden />
              {["Scheduled for", "Status", "Trigger", "Result"].map((label) => (
                <th key={label} className={collectionTable.heading}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <CollectionTableBody
            rows={runs.items}
            empty={
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-10 text-center text-sm text-foreground-muted"
                >
                  No runs yet
                </td>
              </tr>
            }
          >
            {(run, index) => (
              <CollectionRow>
                <td className={collectionTable.cell}>{index + 1}</td>
                <td className={collectionTable.cell}>
                  {dateLabel(run.scheduledAt, task.timezone)}
                </td>
                <td className={collectionTable.cell}>
                  <TaskRunStatus run={run} />
                </td>
                <td className={collectionTable.cell}>
                  {run.source === "manual" ? "Manual" : "Schedule"}
                </td>
                <td className={collectionTable.cell}>
                  {run.conversationId ? (
                    <Link
                      className="underline underline-offset-4"
                      href={workspaceHref(
                        `/build/agents/${encodeURIComponent(agentId)}?section=conversations&conversation=${encodeURIComponent(run.conversationId)}`
                      )}
                    >
                      Open conversation
                    </Link>
                  ) : (
                    (run.error ?? "—")
                  )}
                </td>
              </CollectionRow>
            )}
          </CollectionTableBody>
        </CollectionTable>
      </CollectionPage>
    </CollectionPanel>
  )
}
