import { scheduledSdkConversation } from "./sdk-scope"
import { CronExpressionParser } from "cron-parser"
import { sql } from "drizzle-orm"
import {
  scheduledTaskInputSchema,
  taskScheduleSchema,
  type ScheduledTask,
  type ScheduledTaskInput,
  type ScheduledTaskRun,
  type TaskSchedule,
} from "@/src/lib/build/schedules"
import { TracerError } from "@/src/server/tracer/errors"
import type { TracerDatabase } from "@/src/server/tracer/db"
import { assertBuildProject, asIsoDate, type BuildContext } from "./context"
import { getAgent } from "./agents"
import { enabledBuildProject } from "./access"
import { ConversationService } from "./conversations"
import { runAgentTurn } from "./runtime"
import { EveExecutionPendingError } from "./eve/client"

type TaskRow = {
  id: string
  project_id: string
  agent_id: string
  name: string
  prompt: string
  channel: ScheduledTaskInput["channel"]
  schedule_json: TaskSchedule
  timezone: string
  status: ScheduledTask["status"]
  revision: number
  next_run_at: unknown
  deleted_at: unknown
  created_at: unknown
  updated_at: unknown
  last_run?: RunRow | null
}
type RunRow = {
  id: string
  project_id: string
  task_id: string
  source: ScheduledTaskRun["source"]
  request_key: string
  snapshot_json: ScheduledTaskInput
  status: ScheduledTaskRun["status"]
  scheduled_at: unknown
  started_at: unknown
  finished_at: unknown
  created_at: unknown
  conversation_id: string | null
  trace_id: string | null
  error: string | null
  lease_token: string | null
}
const invalid = (message: string) =>
  new TracerError("VALIDATION_ERROR", message)
const conflict = () =>
  new TracerError(
    "CONFLICT",
    "This task changed. Refresh it before saving again."
  )
function runModel(row: RunRow): ScheduledTaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    source: row.source,
    status: row.status,
    scheduledAt: asIsoDate(row.scheduled_at)!,
    startedAt: asIsoDate(row.started_at),
    finishedAt: asIsoDate(row.finished_at),
    conversationId: row.conversation_id,
    traceId: row.trace_id,
    error: row.error,
  }
}
function taskModel(row: TaskRow): ScheduledTask {
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    prompt: row.prompt,
    channel: row.channel,
    schedule: row.schedule_json,
    timezone: row.timezone,
    status: row.status,
    revision: row.revision,
    nextRunAt: asIsoDate(row.next_run_at),
    lastRun: row.last_run ? runModel(row.last_run) : null,
    createdAt: asIsoDate(row.created_at)!,
    updatedAt: asIsoDate(row.updated_at)!,
  }
}

/** All recurring dates are calculated in the chosen IANA zone, including DST. */
export function nextTaskOccurrence(
  schedule: TaskSchedule,
  timezone: string,
  after = new Date()
): Date | null {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(after)
  } catch {
    throw invalid("Choose a valid time zone, such as America/Sao_Paulo.")
  }
  const value = taskScheduleSchema.parse(schedule)
  if (value.kind === "once")
    return new Date(value.at) > after ? new Date(value.at) : null
  if (
    value.expression.split(/\s+/).length !== 5 ||
    /\bH\b/.test(value.expression)
  )
    throw invalid(
      "Use a five-field cron expression: minute hour day month weekday."
    )
  try {
    return CronExpressionParser.parse(value.expression, {
      currentDate: after,
      tz: timezone,
    })
      .next()
      .toDate()
  } catch {
    throw invalid(
      "This schedule has no valid upcoming date. Check its cron expression."
    )
  }
}

async function validateInput(context: BuildContext, value: unknown) {
  const input = scheduledTaskInputSchema.parse(value)
  const agent = await getAgent(context, input.agentId)
  const config = agent.appliedConfiguration ?? agent.configuration
  if (
    input.enabled &&
    (!config.channelAllowlist.includes(input.channel) ||
      config.channelOverrides[input.channel]?.enabled === false)
  )
    throw invalid("Choose a channel enabled in the agent's published settings.")
  const next = nextTaskOccurrence(input.schedule, input.timezone)
  if (input.enabled && !next)
    throw invalid("Choose a future date for this task.")
  return { input, next }
}

export async function listScheduledTasks(
  context: BuildContext,
  input: {
    agentId: string
    cursor?: string
    limit?: number
    search?: string
    sdkSessionId?: string
    id?: string
  }
) {
  await assertBuildProject(context)
  await getAgent(context, input.agentId)
  const limit = Math.min(100, Math.max(1, input.limit ?? 50))
  const rows = await context.database.execute<TaskRow>(sql`
    SELECT s.*, (SELECT row_to_json(r) FROM build_agent_schedule_runs r WHERE r.project_id=s.project_id AND r.task_id=s.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) AS last_run
    FROM build_agent_schedules s WHERE s.project_id=${context.projectId} AND s.agent_id=${input.agentId} AND s.deleted_at IS NULL
      ${input.sdkSessionId ? sql`AND EXISTS (SELECT 1 FROM build_sdk_tasks t WHERE t.project_id=s.project_id AND t.task_id=s.id AND t.conversation_id=${input.sdkSessionId})` : sql``}
      ${input.id ? sql`AND s.id=${input.id}::uuid` : sql``}
      ${input.cursor ? sql`AND s.id>${input.cursor}::uuid` : sql``}
      ${input.search ? sql`AND strpos(lower(s.name || ' ' || s.prompt), lower(${input.search}))>0` : sql``}
    ORDER BY s.id LIMIT ${limit + 1}`)
  return {
    items: rows.rows.slice(0, limit).map(taskModel),
    nextCursor: rows.rows.length > limit ? rows.rows[limit - 1].id : null,
  }
}

export async function createScheduledTask(
  context: BuildContext,
  value: unknown
) {
  await assertBuildProject(context)
  const { input, next } = await validateInput(context, value)
  const rows = await context.database
    .execute<TaskRow>(sql`INSERT INTO build_agent_schedules
    (id,project_id,agent_id,name,prompt,channel,schedule_json,timezone,status,next_run_at)
    VALUES (${crypto.randomUUID()}::uuid,${context.projectId},${input.agentId},${input.name},${input.prompt},${input.channel},${JSON.stringify(input.schedule)}::jsonb,${input.timezone},${input.enabled ? "active" : "paused"},${input.enabled ? next?.toISOString() : null}::timestamptz) RETURNING *`)
  return taskModel(rows.rows[0])
}

export async function updateScheduledTask(
  context: BuildContext,
  input: ScheduledTaskInput & { id: string; expectedRevision: number }
) {
  await assertBuildProject(context)
  const { id, expectedRevision, ...candidate } = input
  const { input: value, next: nextOccurrence } = await validateInput(
    context,
    candidate
  )
  return context.database.transaction(async (tx) => {
    const previous = await tx.execute<TaskRow>(
      sql`SELECT * FROM build_agent_schedules WHERE project_id=${context.projectId} AND agent_id=${input.agentId} AND id=${id}::uuid AND deleted_at IS NULL FOR UPDATE`
    )
    const old = previous.rows[0]
    if (!old) throw new TracerError("NOT_FOUND", "Scheduled task not found.")
    if (old.revision !== expectedRevision) throw conflict()
    const scheduleChanged =
      old.schedule_json.kind !== value.schedule.kind ||
      (old.schedule_json.kind === "cron" &&
        value.schedule.kind === "cron" &&
        old.schedule_json.expression !== value.schedule.expression) ||
      (old.schedule_json.kind === "once" &&
        value.schedule.kind === "once" &&
        old.schedule_json.at !== value.schedule.at) ||
      old.timezone !== value.timezone
    const next = value.enabled
      ? old.status === "active" && !scheduleChanged
        ? asIsoDate(old.next_run_at)
        : nextOccurrence?.toISOString()
      : null
    const rows =
      await tx.execute<TaskRow>(sql`UPDATE build_agent_schedules SET name=${value.name.trim()},prompt=${value.prompt.trim()},channel=${value.channel},schedule_json=${JSON.stringify(value.schedule)}::jsonb,
      timezone=${value.timezone},status=${value.enabled ? "active" : "paused"},next_run_at=${next ?? null}::timestamptz,revision=revision+1,updated_at=now()
      WHERE project_id=${context.projectId} AND id=${id}::uuid RETURNING *`)
    if (!value.enabled || scheduleChanged)
      await tx.execute(sql`UPDATE build_agent_schedule_runs SET status='cancelled',finished_at=now()
      WHERE project_id=${context.projectId} AND task_id=${id}::uuid AND source='schedule' AND status='queued' AND started_at IS NULL`)
    return taskModel(rows.rows[0])
  })
}

export async function deleteScheduledTask(
  context: BuildContext,
  input: { agentId: string; id: string; expectedRevision: number }
) {
  await assertBuildProject(context)
  return context.database.transaction(async (tx) => {
    const rows =
      await tx.execute(sql`UPDATE build_agent_schedules SET deleted_at=now(),next_run_at=null,status='paused',revision=revision+1,updated_at=now()
      WHERE project_id=${context.projectId} AND agent_id=${input.agentId} AND id=${input.id}::uuid AND revision=${input.expectedRevision} AND deleted_at IS NULL RETURNING id`)
    if (!rows.rows.length) throw conflict()
    await tx.execute(
      sql`UPDATE build_agent_schedule_runs SET status='cancelled',finished_at=now() WHERE project_id=${context.projectId} AND task_id=${input.id}::uuid AND status='queued' AND started_at IS NULL`
    )
    return { deleted: true }
  })
}

function snapshot(row: TaskRow): ScheduledTaskInput {
  return {
    agentId: row.agent_id,
    name: row.name,
    prompt: row.prompt,
    channel: row.channel,
    schedule: row.schedule_json,
    timezone: row.timezone,
    enabled: true,
  }
}

export async function runScheduledTaskNow(
  context: BuildContext,
  input: { agentId: string; id: string }
) {
  await assertBuildProject(context)
  await getAgent(context, input.agentId)
  const requestKey = context.idempotencyKey ?? context.requestKey
  if (!requestKey)
    throw invalid("An idempotency key is required to run a task.")
  return context.database.transaction(async (tx) => {
    const rows = await tx.execute<TaskRow>(
      sql`SELECT * FROM build_agent_schedules WHERE project_id=${context.projectId} AND agent_id=${input.agentId} AND id=${input.id}::uuid AND deleted_at IS NULL FOR UPDATE`
    )
    const row = rows.rows[0]
    if (!row) throw new TracerError("NOT_FOUND", "Scheduled task not found.")
    const existing = await tx.execute<RunRow>(
      sql`SELECT * FROM build_agent_schedule_runs WHERE project_id=${context.projectId} AND task_id=${row.id}::uuid AND (request_key=${`manual:${requestKey}`} OR status IN ('queued','running')) ORDER BY created_at DESC LIMIT 1`
    )
    if (existing.rows[0]) return runModel(existing.rows[0])
    const run =
      await tx.execute<RunRow>(sql`INSERT INTO build_agent_schedule_runs(id,project_id,task_id,source,request_key,snapshot_json,scheduled_at)
      VALUES (${crypto.randomUUID()}::uuid,${context.projectId},${row.id}::uuid,'manual',${`manual:${requestKey}`},${JSON.stringify(snapshot(row))}::jsonb,now()) RETURNING *`)
    return runModel(run.rows[0])
  })
}

export async function listScheduledTaskRuns(
  context: BuildContext,
  input: { agentId: string; taskId: string; cursor?: string; limit?: number }
) {
  await assertBuildProject(context)
  const task = await context.database.execute(
    sql`SELECT id FROM build_agent_schedules WHERE project_id=${context.projectId} AND agent_id=${input.agentId} AND id=${input.taskId}::uuid AND deleted_at IS NULL`
  )
  if (!task.rows.length)
    throw new TracerError("NOT_FOUND", "Scheduled task not found.")
  const limit = Math.min(100, Math.max(1, input.limit ?? 30))
  const rows = await context.database
    .execute<RunRow>(sql`SELECT r.* FROM build_agent_schedule_runs r WHERE r.project_id=${context.projectId} AND r.task_id=${input.taskId}::uuid
    ${input.cursor ? sql`AND (r.created_at,r.id)<(SELECT c.created_at,c.id FROM build_agent_schedule_runs c WHERE c.project_id=${context.projectId} AND c.task_id=${input.taskId}::uuid AND c.id=${input.cursor}::uuid)` : sql``}
    ORDER BY r.created_at DESC,r.id DESC LIMIT ${limit + 1}`)
  return {
    items: rows.rows.slice(0, limit).map(runModel),
    nextCursor: rows.rows.length > limit ? rows.rows[limit - 1].id : null,
  }
}

/** Commit the occurrence and next date together. Downtime coalesces into one run. */
export async function enqueueDueScheduledTasks(database: TracerDatabase) {
  return database.transaction(async (tx) => {
    const tasks =
      await tx.execute<TaskRow>(sql`SELECT s.* FROM build_agent_schedules s JOIN build_agents a ON a.id=s.agent_id AND a.project_id=s.project_id
      WHERE s.status='active' AND s.deleted_at IS NULL AND s.next_run_at<=now() AND a.status='active'
        AND ${enabledBuildProject(sql`s.project_id`)}
        AND NOT EXISTS (SELECT 1 FROM build_agent_schedule_runs r WHERE r.task_id=s.id AND r.status IN ('queued','running'))
      ORDER BY s.next_run_at,s.id LIMIT 25 FOR UPDATE OF s SKIP LOCKED`)
    for (const task of tasks.rows) {
      const next =
        task.schedule_json.kind === "once"
          ? null
          : nextTaskOccurrence(task.schedule_json, task.timezone)
      const due = asIsoDate(task.next_run_at)!
      await tx.execute(sql`INSERT INTO build_agent_schedule_runs(id,project_id,task_id,source,request_key,snapshot_json,scheduled_at)
        VALUES (${crypto.randomUUID()}::uuid,${task.project_id},${task.id}::uuid,'schedule',${`schedule:${due}`},${JSON.stringify(snapshot(task))}::jsonb,${due}::timestamptz) ON CONFLICT DO NOTHING`)
      await tx.execute(
        sql`UPDATE build_agent_schedules SET next_run_at=${next?.toISOString() ?? null}::timestamptz,updated_at=now() WHERE id=${task.id}::uuid`
      )
    }
    return tasks.rows.length
  })
}

/** Claim with a renewable lease; retries reuse the same conversation and turn. */
export async function processNextScheduledTask(
  database: TracerDatabase,
  projectContext: (projectId: string) => BuildContext
) {
  const token = crypto.randomUUID()
  const claimed = await database.execute<RunRow>(sql`WITH candidate AS (
    SELECT r.id FROM build_agent_schedule_runs r JOIN build_agent_schedules s ON s.id=r.task_id AND s.project_id=r.project_id
    WHERE ((r.status='queued' AND r.available_at<=now()) OR (r.status='running' AND r.lease_expires_at<now()))
      AND ${enabledBuildProject(sql`r.project_id`)}
      AND (r.started_at IS NOT NULL OR (s.deleted_at IS NULL AND (r.source='manual' OR s.status='active')))
    ORDER BY r.available_at,r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED
  ) UPDATE build_agent_schedule_runs r SET status='running',lease_token=${token}::uuid,lease_expires_at=now()+interval '90 seconds',started_at=coalesce(started_at,now())
    FROM candidate WHERE r.id=candidate.id RETURNING r.*`)
  const run = claimed.rows[0]
  if (!run) return false
  const context = projectContext(run.project_id)
  const heartbeat = setInterval(() => {
    void database
      .execute(
        sql`UPDATE build_agent_schedule_runs SET lease_expires_at=now()+interval '90 seconds' WHERE id=${run.id}::uuid AND lease_token=${token}::uuid AND status='running'`
      )
      .catch(() => undefined)
  }, 20_000)
  let status: ScheduledTaskRun["status"] = "failed"
  let error: string | null = null
  let traceId: string | null = null
  let retry = false
  try {
    const input = scheduledTaskInputSchema.parse(run.snapshot_json)
    const service = new ConversationService(context)
    const conversation =
      (await scheduledSdkConversation(context, run.task_id, input.agentId)) ??
      (await service.getOrCreate({
        agentId: input.agentId,
        channel: input.channel,
        externalConversationId: `scheduled-task:${run.id}`,
        metadata: {
          scheduledTaskId: run.task_id,
          scheduledTaskRunId: run.id,
          scheduledTaskName: input.name,
        },
      }))
    await database.execute(
      sql`UPDATE build_agent_schedule_runs SET conversation_id=${conversation.id} WHERE id=${run.id}::uuid AND lease_token=${token}::uuid`
    )
    const result = await runAgentTurn(context, {
      agentId: input.agentId,
      channel: conversation.channel,
      conversationId: conversation.id,
      requestKey: `scheduled-task:${run.id}`,
      message: input.prompt,
      metadata: {
        scheduledTaskId: run.task_id,
        scheduledTaskRunId: run.id,
        scheduledAt: asIsoDate(run.scheduled_at)!,
      },
    })
    traceId = result.traceId
    if (result.status === "busy") {
      // A turn interrupted before creating an Eve checkpoint needs operator review.
      retry =
        Date.now() - new Date(asIsoDate(run.started_at)!).getTime() <
        10 * 60_000
      error = retry
        ? null
        : "The interrupted run needs review. Open its conversation before running it again."
    } else if (
      ["failed", "uncertain", "cancelled"].includes(result.turn.status)
    ) {
      error =
        "The agent could not finish this task. Open the conversation for details."
    } else if (
      result.status === "blocked" ||
      typeof result.message?.metadata.guardrail === "string"
    ) {
      status = "blocked"
      error = "The agent's guardrails blocked this run."
    } else if (
      result.continuations.length ||
      result.status === "handed_off" ||
      result.turn.status === "awaiting_client"
    ) {
      status = "needs_attention"
    } else {
      status = "completed"
    }
  } catch (failure) {
    retry = failure instanceof EveExecutionPendingError
    error = retry
      ? null
      : "The task could not finish. Check the agent's model, settings and conversation."
  } finally {
    clearInterval(heartbeat)
  }
  await database.transaction(async (tx) => {
    const updated =
      await tx.execute(sql`UPDATE build_agent_schedule_runs SET status=${retry ? "queued" : status},error=${error},trace_id=coalesce(${traceId},trace_id),
      available_at=now()+interval '5 seconds',finished_at=${retry ? sql`null` : sql`now()`},lease_token=null,lease_expires_at=null
      WHERE id=${run.id}::uuid AND lease_token=${token}::uuid RETURNING id`)
    if (updated.rows.length && !retry && run.source === "schedule")
      await tx.execute(sql`UPDATE build_agent_schedules SET status='completed',revision=revision+1,updated_at=now()
      WHERE id=${run.task_id}::uuid AND status='active' AND next_run_at IS NULL AND schedule_json->>'kind'='once'`)
  })
  return true
}
