import { rejects } from "node:assert/strict"
import { expect, test } from "bun:test"
import { configureBuildTestEnvironment } from "./helpers/build-env"

configureBuildTestEnvironment()
import { sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { createAgent } from "@/src/server/build/agents"
import {
  createChannelConnection,
  updateChannelStatus,
} from "@/src/server/build/channels/service"
import {
  createSdkSession,
  requireSdkSession,
  sdkSandboxConfiguration,
  scheduledSdkConversation,
} from "@/src/server/build/sdk-scope"
import { sdkFiles } from "@/src/server/build/sdk-files"
import { sdkTasks } from "@/src/server/build/sdk-tasks"
import { sdkChat } from "@/src/server/build/sdk-chat"
import { createDrive } from "@/src/server/build/drives"
import {
  runAgentSandboxCommand,
  volumeName,
} from "@/src/server/build/sandbox-runtime"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"
import { getTracerProjectId } from "@/src/server/tracer/db"
import {
  createEveFixture,
  eveResponse,
  invokeTool,
  toolOutputs,
} from "./helpers/eve-fixture"
import {
  processNextScheduledTask,
  enqueueDueScheduledTasks,
  runScheduledTaskNow,
} from "@/src/server/build/schedules"

async function setup(
  context: Parameters<typeof createAgent>[0],
  provider = false
) {
  const agent = await createAgent(context, {
    name: "SDK fixture",
    configuration: {
      ...(provider ? { provider: "openai", model: "gpt-4.1-mini" } : {}),
      guardrails: { jevCheckEnabled: false },
      sandbox: { enabled: true, provider: "local" },
    },
  })
  const connection = await createChannelConnection(context, {
    agentId: agent.id,
    channel: "api",
    label: "React SDK",
  })
  await updateChannelStatus(context, connection.id, "connected")
  return { agent, connection }
}
async function removeVolumes(context: Parameters<typeof createAgent>[0]) {
  const rows = await context.database.execute<{ id: string }>(
    sql`SELECT id FROM build_drives WHERE project_id=${context.projectId} AND provisioned_at IS NOT NULL`
  )
  for (const row of rows.rows)
    execFileSync(
      "docker",
      ["volume", "rm", volumeName(context.projectId, row.id)],
      { stdio: "ignore" }
    )
}

test("SDK isolates conversations and tasks by user and organization while sharing the organization's drive", async () => {
  const database = await createTracerFixture()
  const context = { database, projectId: getTracerProjectId(database) }
  try {
    const { connection, agent } = await setup(context)
    const a = { connectionId: connection.id, userId: "alice", drive: "org_a" }
    const b = { ...a, userId: "bob" }
    const other = { ...a, drive: "org_b" }
    const [sa, saAgain, sb, so] = await Promise.all([
      createSdkSession(context, a),
      createSdkSession(context, a),
      createSdkSession(context, b),
      createSdkSession(context, other),
    ])
    expect(saAgain).toEqual(sa)
    expect(sb.conversationId).not.toBe(sa.conversationId)
    const aa = await requireSdkSession(context, a, sa.conversationId)
    expect(
      (await requireSdkSession(context, b, sb.conversationId)).driveId
    ).toBe(aa.driveId)
    expect(
      (await requireSdkSession(context, other, so.conversationId)).driveId
    ).not.toBe(aa.driveId)
    await rejects(
      requireSdkSession(context, other, sa.conversationId),
      /not available/
    )
    await rejects(
      requireSdkSession(context, b, sa.conversationId),
      /not available/
    )
    const shared = await createDrive(context, {
      name: "Must not leak",
      provider: "local",
    })
    const config = {
      ...agent.configuration.sandbox,
      drives: [{ driveId: shared.id, mountPath: "/workspace" }],
    }
    expect(
      (await sdkSandboxConfiguration(context, sa.conversationId, config)).drives
    ).toEqual([{ driveId: aa.driveId!, mountPath: "/workspace" }])
    const noDrive = await createSdkSession(context, {
      connectionId: connection.id,
      userId: "no-drive",
    })
    expect(
      (await sdkSandboxConfiguration(context, noDrive.conversationId, config))
        .drives
    ).toEqual([])
    const created = await sdkTasks(context, {
      ...a,
      ...sa,
      request: {
        action: "create",
        task: {
          name: "Daily",
          prompt: "Summarize",
          schedule: { kind: "cron", expression: "0 9 * * *" },
          timezone: "UTC",
        },
      },
    })
    if (!("id" in created)) throw new Error("Task not created")
    const task = created as { id: string; revision: number }
    expect(
      (await scheduledSdkConversation(context, task.id, agent.id))?.id
    ).toBe(sa.conversationId)
    expect(
      await sdkTasks(context, { ...b, ...sb, request: { action: "list" } })
    ).toMatchObject({ items: [] })
    await rejects(
      sdkTasks(context, {
        ...b,
        ...sb,
        request: {
          action: "pause",
          id: task.id,
          expectedRevision: task.revision,
        },
      }),
      /not found/
    )
    expect(
      await sdkTasks(context, {
        ...a,
        ...sa,
        request: {
          action: "pause",
          id: task.id,
          expectedRevision: task.revision,
        },
      })
    ).toMatchObject({ status: "paused" })
    await rejects(
      sdkTasks(context, {
        ...a,
        ...sa,
        request: {
          action: "resume",
          id: task.id,
          expectedRevision: task.revision,
        },
      })
    )
    await updateChannelStatus(context, connection.id, "paused")
    await rejects(requireSdkSession(context, a, sa.conversationId), /Connect/)
    await rejects(scheduledSdkConversation(context, task.id, agent.id))
    await context.database.execute(
      sql`DELETE FROM build_channel_connection WHERE id=${connection.id}::uuid`
    )
    const removed = await context.database.execute<{
      status: string
      deleted_at: unknown
    }>(
      sql`SELECT status,deleted_at FROM build_agent_schedules WHERE id=${task.id}::uuid`
    )
    expect(removed.rows[0]?.status).toBe("paused")
    expect(removed.rows[0]?.deleted_at).not.toBeNull()
  } finally {
    await closeTracerFixture(database)
  }
}, 60_000)

test("SDK files use the persistent drive, enforce paths and preserve binary bytes", async () => {
  const database = await createTracerFixture()
  const context = { database, projectId: getTracerProjectId(database) }
  try {
    const { connection, agent } = await setup(context)
    const scope = { connectionId: connection.id, userId: "alice", drive: "org" }
    const file = (request: unknown) => sdkFiles(context, { ...scope, request })
    const bytes = Buffer.alloc(200_000, 127)
    expect(
      await file({
        action: "write",
        path: "context/data.bin",
        content: bytes.toString("base64"),
      })
    ).toMatchObject({ written: true, size: bytes.length })
    expect(await file({ action: "read", path: "context/data.bin" })).toEqual({
      content: bytes.toString("base64"),
    })
    expect(await file({ action: "list", path: "context" })).toMatchObject({
      entries: [{ name: "data.bin", type: "file", size: bytes.length }],
    })
    await rejects(
      file({ action: "read", path: "../etc/passwd" }),
      /inside the drive/
    )
    await rejects(file({ action: "delete", path: "/" }), /root/)
    const session = await createSdkSession(context, scope)
    const sandbox = await sdkSandboxConfiguration(
      context,
      session.conversationId,
      agent.configuration.sandbox
    )
    await runAgentSandboxCommand(context, sandbox, {
      command: "ln -s /etc /workspace/link",
    })
    await rejects(
      file({ action: "read", path: "link/passwd" }),
      /Symbolic links/
    )
    await rejects(
      file({ action: "write", path: "link/test", content: "" }),
      /Symbolic links/
    )
    await rejects(
      sdkFiles(context, {
        ...scope,
        drive: "other",
        request: { action: "read", path: "context/data.bin" },
      }),
      /not found/
    )
    await file({ action: "delete", path: "context/data.bin" })
    expect(await file({ action: "list", path: "context" })).toEqual({
      entries: [],
    })
  } finally {
    await removeVolumes(context)
    await closeTracerFixture(database)
  }
}, 120_000)

test("a scheduled SDK task uses the same drive and delivers a proactive reply into the embedded chat", async () => {
  const fixture = await createEveFixture()
  const { context } = fixture
  try {
    const { agent, connection } = await setup(context, true)
    const scope = { connectionId: connection.id, userId: "alice", drive: "org" }
    const session = await createSdkSession(context, scope)
    await sdkFiles(context, {
      ...scope,
      request: {
        action: "write",
        path: "context.txt",
        content: Buffer.from("Company context").toString("base64"),
      },
    })
    fixture.provider((body) =>
      invokeTool(
        body,
        { command: "cat /workspace/context.txt", timeout: 10 },
        "I reviewed your company context.",
        "bash shell command"
      )
    )
    expect(
      await sdkChat(context, {
        ...scope,
        request: {
          action: "send",
          ...session,
          text: "Review our context",
          requestId: randomUUID(),
        },
      })
    ).toMatchObject({
      status: "completed",
      text: "I reviewed your company context.",
    })
    expect(JSON.stringify(fixture.requests.flatMap(toolOutputs))).toContain(
      "Company context"
    )
    fixture.provider((body) =>
      eveResponse(body, "Here is your proactive briefing.")
    )
    const created = await sdkTasks(context, {
      ...scope,
      ...session,
      request: {
        action: "create",
        task: {
          name: "Briefing",
          prompt: "Send the daily briefing",
          schedule: { kind: "cron", expression: "0 9 * * *" },
          timezone: "UTC",
        },
      },
    })
    if (!("id" in created)) throw new Error("Task not created")
    await sdkTasks(
      { ...context, idempotencyKey: randomUUID() },
      { ...scope, ...session, request: { action: "run", id: created.id } }
    )
    expect(
      await processNextScheduledTask(context.database, () => context)
    ).toBe(true)
    const result = await sdkChat(context, {
      ...scope,
      request: { action: "messages", ...session },
    })
    expect(result).toMatchObject({ pending: false, failed: false })
    if (!("messages" in result) || !result.messages)
      throw new Error("Messages missing")
    expect(result.messages.map((message) => message.text)).toContain(
      "Here is your proactive briefing."
    )
    expect(result.messages.map((message) => message.text)).not.toContain(
      "Send the daily briefing"
    )
    const plans = await context.database.execute<{
      plan_json: { configuration: { sandbox: { drives: unknown[] } } }
    }>(
      sql`SELECT plan_json FROM build_eve_executions WHERE project_id=${context.projectId} AND agent_id=${agent.id}`
    )
    expect(plans.rows.length).toBe(2)
    const drive = (
      await requireSdkSession(context, scope, session.conversationId)
    ).driveId
    for (const row of plans.rows)
      expect(row.plan_json.configuration.sandbox.drives).toEqual([
        { driveId: drive, mountPath: "/workspace" },
      ])
  } finally {
    await removeVolumes(context)
    await fixture.close()
  }
}, 120_000)

test("scheduled and dashboard-triggered SDK runs read only their saved workspace drive", async () => {
  const fixture = await createEveFixture()
  const { context } = fixture
  try {
    const { agent, connection } = await setup(context, true)
    fixture.provider((body) =>
      invokeTool(
        body,
        { command: "cat /workspace/company.md", timeout: 10 },
        "Workspace briefing ready.",
        "bash shell command"
      )
    )
    const workspaces = []
    for (const name of ["ACME", "ORBIT"]) {
      const scope = {
        connectionId: connection.id,
        userId: "owner",
        drive: name,
        workspaceName: name,
      }
      const session = await createSdkSession(context, scope)
      await sdkFiles(context, {
        ...scope,
        request: {
          action: "write",
          path: "company.md",
          content: Buffer.from(`${name}_PRIVATE_CONTEXT`).toString("base64"),
        },
      })
      const task = await sdkTasks(context, {
        ...scope,
        ...session,
        request: {
          action: "create",
          task: {
            name: `${name} briefing`,
            prompt: "Read company.md",
            schedule: { kind: "cron", expression: "0 9 * * *" },
            timezone: "UTC",
          },
        },
      })
      if (!("id" in task)) throw new Error("Task missing")
      workspaces.push({ name, scope, session, task })
    }
    for (const [index, item] of workspaces.entries()) {
      const requestStart = fixture.requests.length
      if (index === 0) {
        await context.database.execute(
          sql`UPDATE build_agent_schedules SET next_run_at=now()-interval '1 minute' WHERE id=${item.task.id}::uuid`
        )
        expect(await enqueueDueScheduledTasks(context.database)).toBe(1)
      } else {
        await runScheduledTaskNow(
          { ...context, idempotencyKey: randomUUID() },
          { agentId: agent.id, id: item.task.id }
        )
      }
      expect(
        await processNextScheduledTask(context.database, () => context)
      ).toBe(true)
      const outputs = JSON.stringify(
        fixture.requests.slice(requestStart).flatMap(toolOutputs)
      )
      expect(outputs).toContain(`${item.name}_PRIVATE_CONTEXT`)
      expect(outputs).not.toContain(
        `${workspaces[1 - index].name}_PRIVATE_CONTEXT`
      )
      const runs = await context.database.execute<{
        conversation_id: string
        status: string
      }>(
        sql`SELECT conversation_id,status FROM build_agent_schedule_runs WHERE task_id=${item.task.id}::uuid`
      )
      expect(runs.rows[0]).toMatchObject({
        status: "completed",
        conversation_id: item.session.conversationId,
      })
    }
  } finally {
    await removeVolumes(context)
    await fixture.close()
  }
}, 120_000)
