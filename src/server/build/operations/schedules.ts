import { z } from "zod"
import { scheduledTaskInputSchema } from "@/src/lib/build/schedules"
import { registerBuildOperation } from "../api"
import {
  createScheduledTask,
  deleteScheduledTask,
  listScheduledTaskRuns,
  listScheduledTasks,
  runScheduledTaskNow,
  updateScheduledTask,
} from "../schedules"

const agent = z.string().trim().min(1).max(200)
const page = {
  cursor: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).optional(),
}
const target = z.object({ agentId: agent, id: z.string().uuid() })

registerBuildOperation({
  name: "build_list_scheduled_tasks",
  description:
    "List an agent's scheduled automations, next dates and latest run status.",
  scopes: ["build:read"],
  schema: z.object({
    agentId: agent,
    search: z.string().trim().max(200).optional(),
    ...page,
  }),
  execute: (ctx, input) =>
    listScheduledTasks(ctx, input as Parameters<typeof listScheduledTasks>[1]),
})
registerBuildOperation({
  name: "build_create_scheduled_task",
  description:
    "Schedule an agent prompt once or with a timezone-aware cron expression. Runs use published settings and save results in Conversations.",
  scopes: ["build:write", "build:run"],
  schema: scheduledTaskInputSchema,
  execute: createScheduledTask,
  idempotency: "required",
})
registerBuildOperation({
  name: "build_update_scheduled_task",
  description:
    "Edit or pause a scheduled task. Already started runs continue; paused tasks do not start new scheduled runs.",
  scopes: ["build:write", "build:run"],
  schema: scheduledTaskInputSchema.extend({
    id: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
  }),
  expectedRevision: "required",
  execute: (ctx, input) =>
    updateScheduledTask(
      ctx,
      input as Parameters<typeof updateScheduledTask>[1]
    ),
})
registerBuildOperation({
  name: "build_delete_scheduled_task",
  description:
    "Remove a scheduled task and cancel unstarted runs. Already started runs and their conversations are retained.",
  scopes: ["build:write"],
  schema: target.extend({ expectedRevision: z.number().int().positive() }),
  destructive: true,
  expectedRevision: "required",
  execute: (ctx, input) =>
    deleteScheduledTask(
      ctx,
      input as Parameters<typeof deleteScheduledTask>[1]
    ),
})
registerBuildOperation({
  name: "build_run_scheduled_task",
  description:
    "Queue a task now without changing its schedule. Returns the existing run when the task is already queued or running.",
  scopes: ["build:run"],
  schema: target,
  idempotency: "required",
  openWorld: true,
  execute: (ctx, input) =>
    runScheduledTaskNow(
      ctx,
      input as Parameters<typeof runScheduledTaskNow>[1]
    ),
})
registerBuildOperation({
  name: "build_list_scheduled_task_runs",
  description:
    "Read a task's run history and links to its saved conversations and traces.",
  scopes: ["build:read"],
  schema: z.object({ agentId: agent, taskId: z.string().uuid(), ...page }),
  execute: (ctx, input) =>
    listScheduledTaskRuns(
      ctx,
      input as Parameters<typeof listScheduledTaskRuns>[1]
    ),
})
