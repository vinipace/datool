import { readFile } from "node:fs/promises"
import { rejects } from "node:assert/strict"
import { expect, test } from "bun:test"
import { configureBuildTestEnvironment } from "./helpers/build-env"

configureBuildTestEnvironment()
import { sql } from "drizzle-orm"
import { createAgent } from "@/src/server/build/agents"
import {
  createChannelConnection,
  updateChannelStatus,
} from "@/src/server/build/channels/service"
import { createDrive, listDrives } from "@/src/server/build/drives"
import {
  createSdkSession,
  resolveSdkDrive,
  scheduledSdkConversation,
  sdkSandboxConfiguration,
} from "@/src/server/build/sdk-scope"
import { sdkTasks } from "@/src/server/build/sdk-tasks"
import {
  listScheduledTasks,
  updateScheduledTask,
  runScheduledTaskNow,
  enqueueDueScheduledTasks,
  processNextScheduledTask,
} from "@/src/server/build/schedules"
import { getTracerProjectId } from "@/src/server/tracer/db"
import type { SavedSdkTaskContext } from "@/src/lib/build/sdk-context"
import type { ScheduledTask } from "@/src/lib/build/schedules"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"

async function setup(context: Parameters<typeof createAgent>[0]) {
  const agent = await createAgent(context, {
    name: "SDK context",
    slug: `sdk-context-${crypto.randomUUID()}`,
    configuration: { sandbox: { enabled: true, provider: "local" } },
  })
  const connection = await createChannelConnection(context, {
    agentId: agent.id,
    channel: "api",
    label: "React SDK",
  })
  await updateChannelStatus(context, connection.id, "connected")
  return { agent, connection }
}

test("drive catalog shows workspace ownership even before a chat exists and filters other agents", async () => {
  const database = await createTracerFixture()
  const context = { database, projectId: getTracerProjectId(database) }
  try {
    const { agent, connection } = await setup(context)
    const shared = await createDrive(context, {
      name: "Shared",
      provider: "local",
    })
    const scope = {
      connectionId: connection.id,
      userId: "alice",
      drive: "drive_acme",
      workspaceName: "Acme Studio",
    }
    const driveId = await resolveSdkDrive(
      context,
      scope,
      agent.configuration.sandbox
    )
    const other = await setup(context)
    const otherDrive = await resolveSdkDrive(
      context,
      { ...scope, connectionId: other.connection.id },
      other.agent.configuration.sandbox
    )
    const rows = []
    let after: string | undefined
    do {
      const page = await listDrives(context, {
        agentId: agent.id,
        limit: 1,
        after,
      })
      rows.push(...page.items)
      after = page.nextCursor ?? undefined
    } while (after)
    expect(rows.map((d) => d.id).sort()).toEqual([shared.id, driveId!].sort())
    expect(rows.some((d) => d.id === otherDrive)).toBe(false)
    expect(rows.find((d) => d.id === driveId)?.sdkContext).toMatchObject({
      workspace: "drive_acme",
      workspaceName: "Acme Studio",
      agentId: agent.id,
    })
    await resolveSdkDrive(
      context,
      { ...scope, workspaceName: undefined },
      agent.configuration.sandbox
    )
    expect(
      (await listDrives(context)).items.find((d) => d.id === driveId)
        ?.sdkContext?.workspaceName
    ).toBe("Acme Studio")
    await rejects(
      listDrives(
        { ...context, projectId: "another-project" },
        { agentId: agent.id }
      )
    )
  } finally {
    await closeTracerFixture(database)
  }
}, 60_000)

test("SDK task context is saved, survives dashboard edits, and fails closed on a changed or missing binding", async () => {
  const database = await createTracerFixture()
  const context = { database, projectId: getTracerProjectId(database) }
  try {
    const { agent, connection } = await setup(context)
    const a = {
      connectionId: connection.id,
      userId: "alice",
      drive: "drive_acme",
      workspaceName: "Acme Studio",
    }
    const b = { ...a, drive: "drive_orbit", workspaceName: "Orbit Labs" }
    const sa = await createSdkSession(context, a)
    const sb = await createSdkSession(context, b)
    const definition = {
      name: "Daily briefing",
      prompt: "Read company.md",
      schedule: { kind: "cron", expression: "0 9 * * *" },
      timezone: "UTC",
    }
    const task = (await sdkTasks(context, {
      ...a,
      ...sa,
      request: { action: "create", task: definition },
    })) as ScheduledTask
    const other = (await sdkTasks(context, {
      ...b,
      ...sb,
      request: { action: "create", task: definition },
    })) as ScheduledTask
    expect(task.sdkContext).toMatchObject({
      workspaceName: "Acme Studio",
      conversationId: sa.conversationId,
    })
    expect(JSON.stringify(task)).not.toContain("scopeKey")
    expect(
      (
        await listScheduledTasks(context, {
          agentId: agent.id,
          search: "Orbit Labs",
        })
      ).items.map((t) => t.id)
    ).toEqual([other.id])
    const { rows } = await database.execute<{
      sdk_context: SavedSdkTaskContext
    }>(
      sql`SELECT sdk_context FROM build_agent_schedules WHERE id=${task.id}::uuid`
    )
    const original = rows[0].sdk_context
    const edited = await updateScheduledTask(context, {
      ...definition,
      schedule: { kind: "cron", expression: "0 10 * * *" },
      agentId: agent.id,
      channel: "api",
      id: task.id,
      expectedRevision: task.revision,
      enabled: true,
    })
    expect(edited.sdkContext?.driveId).toBe(original.driveId)
    expect(
      (await scheduledSdkConversation(context, task.id, agent.id, original))?.id
    ).toBe(sa.conversationId)
    await rejects(
      updateScheduledTask(context, {
        ...definition,
        schedule: { kind: "cron", expression: "0 10 * * *" },
        agentId: agent.id,
        channel: "web",
        id: task.id,
        expectedRevision: edited.revision,
        enabled: true,
      }),
      /original workspace/
    )
    await rejects(
      sdkTasks(context, {
        ...b,
        ...sb,
        request: { action: "run", id: task.id },
      }),
      /not found/
    )
    const manual = await runScheduledTaskNow(
      { ...context, requestKey: "sdk-context-test" },
      { agentId: agent.id, id: task.id }
    )
    const queued = await database.execute<{
      snapshot_json: { sdkContext: SavedSdkTaskContext }
    }>(
      sql`SELECT snapshot_json FROM build_agent_schedule_runs WHERE id=${manual.id}::uuid`
    )
    expect(queued.rows[0].snapshot_json.sdkContext).toEqual(original)
    await database.execute(
      sql`UPDATE build_agent_schedules SET next_run_at=now()-interval '1 minute' WHERE id=${other.id}::uuid`
    )
    await enqueueDueScheduledTasks(database)
    const due = await database.execute<{
      snapshot_json: { sdkContext: SavedSdkTaskContext }
    }>(
      sql`SELECT snapshot_json FROM build_agent_schedule_runs WHERE task_id=${other.id}::uuid`
    )
    expect(due.rows[0].snapshot_json.sdkContext.conversationId).toBe(
      sb.conversationId
    )
    expect(due.rows[0].snapshot_json.sdkContext.driveId).not.toBe(
      original.driveId
    )
    await database.execute(
      sql`UPDATE build_sdk_sessions SET drive_id=${other.sdkContext!.driveId}::uuid WHERE conversation_id=${sa.conversationId}`
    )
    await rejects(
      scheduledSdkConversation(context, task.id, agent.id, original),
      /not available/
    )
    await database.execute(
      sql`UPDATE build_sdk_sessions SET drive_id=${original.driveId}::uuid WHERE conversation_id=${sa.conversationId}`
    )
    await database.execute(
      sql`DELETE FROM build_sdk_tasks WHERE task_id=${task.id}::uuid`
    )
    await rejects(
      scheduledSdkConversation(context, task.id, agent.id, original),
      /not available/
    )
    // A worker must fail the queued SDK run, never create an unscoped conversation.
    await database.execute(
      sql`UPDATE build_agent_schedule_runs SET status='cancelled' WHERE task_id=${other.id}::uuid`
    )
    expect(await processNextScheduledTask(database, () => context)).toBe(true)
    const run = await database.execute<{
      status: string
      conversation_id: string | null
    }>(
      sql`SELECT status,conversation_id FROM build_agent_schedule_runs WHERE id=${manual.id}::uuid`
    )
    expect(run.rows[0]).toMatchObject({
      status: "failed",
      conversation_id: null,
    })
    await database.execute(
      sql`DELETE FROM build_sdk_sessions WHERE conversation_id=${sa.conversationId}`
    )
    await rejects(
      sdkSandboxConfiguration(
        context,
        sa.conversationId,
        agent.configuration.sandbox
      ),
      /not available/
    )
  } finally {
    await closeTracerFixture(database)
  }
}, 60_000)

test("migration restores ownership and task/run context for existing SDK records", async () => {
  const database = await createTracerFixture()
  const context = { database, projectId: getTracerProjectId(database) }
  try {
    const { agent, connection } = await setup(context)
    const scope = {
      connectionId: connection.id,
      userId: "legacy",
      drive: "legacy_workspace",
    }
    const session = await createSdkSession(context, scope)
    const fileOnlyId = await resolveSdkDrive(
      context,
      { ...scope, drive: "legacy_file_only" },
      agent.configuration.sandbox
    )
    const task = (await sdkTasks(context, {
      ...scope,
      ...session,
      request: {
        action: "create",
        task: {
          name: "Legacy briefing",
          prompt: "Read context",
          schedule: { kind: "cron", expression: "0 9 * * *" },
          timezone: "UTC",
        },
      },
    })) as ScheduledTask
    const run = await runScheduledTaskNow(
      { ...context, requestKey: "legacy-run" },
      { agentId: agent.id, id: task.id }
    )
    await database.execute(
      sql`ALTER TABLE build_agent_schedules DROP COLUMN sdk_context`
    )
    await database.execute(
      sql`ALTER TABLE build_drives DROP COLUMN sdk_context`
    )
    await database.execute(
      sql`UPDATE build_agent_schedule_runs SET snapshot_json=snapshot_json-'sdkContext'`
    )
    const migration = await readFile(
      "migrations/0087_sdk_resource_context.sql",
      "utf8"
    )
    await database.execute(sql.raw(migration))
    const drives = await listDrives(context, { agentId: agent.id })
    expect(
      drives.items.find((d) => d.id === fileOnlyId)?.sdkContext
    ).toMatchObject({
      workspace: "legacy_file_only",
      agentId: agent.id,
    })
    const tasks = await listScheduledTasks(context, { agentId: agent.id })
    expect(tasks.items[0].sdkContext?.conversationId).toBe(
      session.conversationId
    )
    const saved = await database.execute<{
      snapshot_json: { sdkContext: SavedSdkTaskContext }
    }>(
      sql`SELECT snapshot_json FROM build_agent_schedule_runs WHERE id=${run.id}::uuid`
    )
    expect(saved.rows[0].snapshot_json.sdkContext.driveId).toBe(
      task.sdkContext!.driveId
    )
    expect(
      (
        await scheduledSdkConversation(
          context,
          task.id,
          agent.id,
          saved.rows[0].snapshot_json.sdkContext
        )
      )?.id
    ).toBe(session.conversationId)
  } finally {
    await closeTracerFixture(database)
  }
}, 60_000)
