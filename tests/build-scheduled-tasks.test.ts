import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { rejects, throws } from "node:assert/strict"
import { sql } from "drizzle-orm"
import { createEveFixture, eveResponse } from "./helpers/eve-fixture"
import { configureBuildTestEnvironment } from "./helpers/build-env"
import { createAgent, updateAgent } from "@/src/server/build/agents"
import {
  createScheduledTask,
  deleteScheduledTask,
  enqueueDueScheduledTasks,
  listScheduledTaskRuns,
  listScheduledTasks,
  nextTaskOccurrence,
  processNextScheduledTask,
  runScheduledTaskNow,
  updateScheduledTask,
} from "@/src/server/build/schedules"
import type {
  ScheduledTask,
  ScheduledTaskInput,
} from "@/src/lib/build/schedules"
import { ConversationService } from "@/src/server/build/conversations"
import { runAgentTurn } from "@/src/server/build/runtime"
import { executeBuildOperation } from "@/src/server/build/bootstrap"
import { withWorkspace } from "@/src/server/auth/context"

// Primary owner for schedule persistence, admission, isolation and execution.
// The real Eve/PG boundary exposes duplicate execution and recovery failures;
// only the paid model's HTTP responses are synthetic.
configureBuildTestEnvironment()
let fixture: Awaited<ReturnType<typeof createEveFixture>>
beforeAll(async () => {
  fixture = await createEveFixture()
})
afterEach(async () => {
  await fixture.context.database.execute(sql`DELETE FROM build_agent_schedules`)
})
afterAll(async () => {
  await fixture?.close()
})

async function agent() {
  return createAgent(fixture.context, {
    name: "Scheduled assistant",
    slug: `scheduled-${crypto.randomUUID()}`,
    configuration: {
      provider: "openai",
      model: "gpt-4.1-mini",
      instructions: "PUBLISHED_SETTINGS",
      guardrails: { jevCheckEnabled: false },
      channelAllowlist: ["web", "api"],
    },
  })
}
function input(
  agentId: string,
  overrides: Partial<ScheduledTaskInput> = {}
): ScheduledTaskInput {
  return {
    agentId,
    name: "Daily summary",
    prompt: "Summarize the available data.",
    channel: "web",
    enabled: true,
    timezone: "America/Sao_Paulo",
    schedule: { kind: "cron", expression: "0 9 * * *" },
    ...overrides,
  }
}
function edit(
  task: ScheduledTask,
  overrides: Partial<ScheduledTaskInput> = {}
) {
  return {
    ...input(task.agentId),
    name: task.name,
    prompt: task.prompt,
    channel: task.channel,
    schedule: task.schedule,
    timezone: task.timezone,
    enabled: task.status === "active",
    ...overrides,
    id: task.id,
    expectedRevision: task.revision,
  }
}
function runNow(task: ScheduledTask, key = crypto.randomUUID()) {
  return runScheduledTaskNow(
    { ...fixture.context, idempotencyKey: key },
    { agentId: task.agentId, id: task.id }
  )
}
function processOne() {
  return processNextScheduledTask(fixture.context.database, (id) => {
    expect(id).toBe(fixture.context.projectId)
    return fixture.context
  })
}
function history(task: ScheduledTask) {
  return listScheduledTaskRuns(fixture.context, {
    agentId: task.agentId,
    taskId: task.id,
  })
}
async function makeDue(task: ScheduledTask) {
  await fixture.context.database.execute(
    sql`UPDATE build_agent_schedules SET next_run_at=now()-interval '2 days' WHERE id=${task.id}::uuid`
  )
}

test("calendar schedules respect local time, DST and invalid dates", () => {
  expect(
    nextTaskOccurrence(
      { kind: "cron", expression: "0 9 * * *" },
      "America/Sao_Paulo",
      new Date("2027-03-13T13:00:00Z")
    )?.toISOString()
  ).toBe("2027-03-14T12:00:00.000Z")
  expect(
    nextTaskOccurrence(
      { kind: "cron", expression: "0 9 * * *" },
      "America/New_York",
      new Date("2027-03-13T14:00:00Z")
    )?.toISOString()
  ).toBe("2027-03-14T13:00:00.000Z")
  expect(
    nextTaskOccurrence(
      { kind: "once", at: "2027-03-14T10:00:00-03:00" },
      "America/Sao_Paulo",
      new Date("2027-03-14T12:00:00Z")
    )?.toISOString()
  ).toBe("2027-03-14T13:00:00.000Z")
  throws(() =>
    nextTaskOccurrence({ kind: "cron", expression: "* * * * * *" }, "UTC")
  )
  throws(() =>
    nextTaskOccurrence({ kind: "cron", expression: "0 9 31 2 *" }, "UTC")
  )
  throws(() =>
    nextTaskOccurrence(
      { kind: "cron", expression: "0 9 * * *" },
      "Imaginary/Zone"
    )
  )
})

test("task CRUD preserves project and agent boundaries, revisions and run permission", async () => {
  const first = await agent(),
    other = await agent()
  const task = await createScheduledTask(fixture.context, input(first.id))
  expect(
    (await listScheduledTasks(fixture.context, { agentId: other.id })).items
  ).toHaveLength(0)
  await rejects(
    listScheduledTaskRuns(fixture.context, {
      agentId: other.id,
      taskId: task.id,
    })
  )
  await rejects(
    runScheduledTaskNow(
      { ...fixture.context, idempotencyKey: "wrong-agent" },
      { agentId: other.id, id: task.id }
    )
  )
  const foreign = { ...fixture.context, projectId: "missing-project" }
  await rejects(createScheduledTask(foreign, input(first.id)))
  await rejects(updateScheduledTask(foreign, edit(task)))
  await rejects(
    deleteScheduledTask(foreign, {
      agentId: first.id,
      id: task.id,
      expectedRevision: 1,
    })
  )
  const updated = await updateScheduledTask(
    fixture.context,
    edit(task, { name: "Weekly report" })
  )
  expect(updated.nextRunAt).toBe(task.nextRunAt)
  await rejects(updateScheduledTask(fixture.context, edit(task)), {
    code: "CONFLICT",
  })
  await withWorkspace(
    {
      organizationId: fixture.target.organizationId,
      projectId: fixture.context.projectId,
      userId: fixture.target.ownerId,
      kind: "session",
      scopes: ["build:write"],
    },
    async () => {
      await rejects(
        executeBuildOperation("build_create_scheduled_task", input(first.id)),
        { code: "UNAUTHORIZED", status: 403 }
      )
      await rejects(
        executeBuildOperation("build_run_scheduled_task", {
          agentId: first.id,
          id: task.id,
        }),
        { code: "UNAUTHORIZED", status: 403 }
      )
    }
  )
})

test("concurrent ticks coalesce missed occurrences and cancel queued work on pause", async () => {
  const a = await agent()
  let task = await createScheduledTask(fixture.context, input(a.id))
  await makeDue(task)
  const counts = await Promise.all([
    enqueueDueScheduledTasks(fixture.context.database),
    enqueueDueScheduledTasks(fixture.context.database),
  ])
  expect(counts.reduce((sum, n) => sum + n, 0)).toBe(1)
  expect((await history(task)).items).toHaveLength(1)
  expect(await enqueueDueScheduledTasks(fixture.context.database)).toBe(0)
  task = await updateScheduledTask(
    fixture.context,
    edit(task, { enabled: false })
  )
  expect((await history(task)).items[0].status).toBe("cancelled")
  expect(await processOne()).toBe(false)
  task = await updateScheduledTask(
    fixture.context,
    edit(task, { enabled: true })
  )
  expect(new Date(task.nextRunAt!).getTime() > Date.now()).toBe(true)
  await deleteScheduledTask(fixture.context, {
    agentId: a.id,
    id: task.id,
    expectedRevision: task.revision,
  })
  expect(
    (await listScheduledTasks(fixture.context, { agentId: a.id })).items
  ).toHaveLength(0)
})

test("disabled organizations and archived agents are not admitted", async () => {
  const a = await agent()
  const task = await createScheduledTask(fixture.context, input(a.id))
  await makeDue(task)
  process.env.DATOOL_BUILD_ENABLED = "false"
  expect(await enqueueDueScheduledTasks(fixture.context.database)).toBe(0)
  process.env.DATOOL_BUILD_ENABLED = "true"
  await fixture.context.database.execute(
    sql`UPDATE build_agents SET status='archived' WHERE id=${a.id}`
  )
  expect(await enqueueDueScheduledTasks(fixture.context.database)).toBe(0)
})

test("one-time tasks use published settings through Eve and retain the conversation", async () => {
  let a = await agent()
  a = await updateAgent(fixture.context, a.id, {
    expectedRevision: a.currentRevision,
    configuration: { ...a.configuration, instructions: "UNPUBLISHED_DRAFT" },
    apply: false,
  })
  const task = await createScheduledTask(
    fixture.context,
    input(a.id, {
      schedule: {
        kind: "once",
        at: new Date(Date.now() + 3600_000).toISOString(),
      },
    })
  )
  await makeDue(task)
  fixture.provider((body) => {
    expect(JSON.stringify(body)).toContain("PUBLISHED_SETTINGS")
    expect(JSON.stringify(body)).not.toContain("UNPUBLISHED_DRAFT")
    return eveResponse(body, "Scheduled report ready.")
  })
  await enqueueDueScheduledTasks(fixture.context.database)
  const outcomes = await Promise.all([processOne(), processOne()])
  expect(outcomes.filter(Boolean)).toHaveLength(1)
  const run = (await history(task)).items[0]
  expect(run.status).toBe("completed")
  expect(run.conversationId).toBeTruthy()
  const messages = await new ConversationService(
    fixture.context
  ).getMessagesForModel(run.conversationId!)
  expect(JSON.stringify(messages)).toContain("Scheduled report ready.")
  expect(
    (await listScheduledTasks(fixture.context, { agentId: a.id })).items[0]
      .status
  ).toBe("completed")
  expect(await enqueueDueScheduledTasks(fixture.context.database)).toBe(0)
}, 60_000)

test("manual runs deduplicate and cannot bypass newly published guardrails", async () => {
  let a = await agent()
  const task = await createScheduledTask(
    fixture.context,
    input(a.id, { prompt: "restricted-topic" })
  )
  const run = await runNow(task, "same-manual-request")
  expect((await runNow(task, "same-manual-request")).id).toBe(run.id)
  expect((await runNow(task, "different-request-while-running")).id).toBe(
    run.id
  )
  a = await updateAgent(fixture.context, a.id, {
    expectedRevision: a.currentRevision,
    configuration: {
      ...a.configuration,
      guardrails: {
        ...a.configuration.guardrails,
        blockedTopics: ["restricted-topic"],
      },
    },
    apply: true,
  })
  const before = fixture.requests.length
  await processOne()
  expect((await history(task)).items[0].status).toBe("blocked")
  expect(fixture.requests.length).toBe(before)
  expect((await runNow(task, "same-manual-request")).id).toBe(run.id)
  // Recover after the guarded turn finished but its scheduling receipt was lost.
  await fixture.context.database.execute(
    sql`UPDATE build_agent_schedule_runs SET status='running',lease_expires_at=now()-interval '1 minute' WHERE id=${run.id}::uuid`
  )
  await processOne()
  expect((await history(task)).items[0].status).toBe("blocked")
  expect(fixture.requests.length).toBe(before)
}, 60_000)

test("expired worker leases recover a completed Eve turn without another model call", async () => {
  const a = await agent()
  const task = await createScheduledTask(fixture.context, input(a.id))
  const run = await runNow(task)
  const service = new ConversationService(fixture.context)
  const conversation = await service.getOrCreate({
    agentId: a.id,
    channel: task.channel,
    externalConversationId: `scheduled-task:${run.id}`,
    metadata: {},
  })
  fixture.provider((body) => eveResponse(body, "Recovered report."))
  await runAgentTurn(fixture.context, {
    agentId: a.id,
    channel: task.channel,
    conversationId: conversation.id,
    requestKey: `scheduled-task:${run.id}`,
    message: task.prompt,
  })
  await fixture.context.database.execute(
    sql`UPDATE build_agent_schedule_runs SET status='running',started_at=now()-interval '2 minutes',lease_expires_at=now()-interval '1 minute',conversation_id=${conversation.id} WHERE id=${run.id}::uuid`
  )
  const before = fixture.requests.length
  await fixture.stop()
  await fixture.start()
  await processOne()
  expect((await history(task)).items[0]).toMatchObject({
    status: "completed",
    conversationId: conversation.id,
  })
  expect(fixture.requests.length).toBe(before)
}, 60_000)
