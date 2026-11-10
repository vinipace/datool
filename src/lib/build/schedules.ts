import { z } from "zod"
import { buildChannelSchema } from "./contracts"
import { sdkTaskContextSchema } from "./sdk-context"

export const taskScheduleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("once"),
      at: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cron"),
      expression: z.string().trim().min(1).max(100),
    })
    .strict(),
])
export type TaskSchedule = z.infer<typeof taskScheduleSchema>

export const scheduledTaskInputSchema = z
  .object({
    agentId: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(160),
    prompt: z.string().trim().min(1).max(20_000),
    schedule: taskScheduleSchema,
    timezone: z.string().trim().min(1).max(100),
    channel: buildChannelSchema.default("web"),
    enabled: z.boolean().default(true),
  })
  .strict()
export type ScheduledTaskInput = z.infer<typeof scheduledTaskInputSchema>

export const scheduledTaskRunSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  source: z.enum(["schedule", "manual"]),
  status: z.enum([
    "queued",
    "running",
    "completed",
    "blocked",
    "needs_attention",
    "failed",
    "cancelled",
  ]),
  scheduledAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  conversationId: z.string().nullable(),
  traceId: z.string().nullable(),
  error: z.string().nullable(),
})
export type ScheduledTaskRun = z.infer<typeof scheduledTaskRunSchema>

export const scheduledTaskSchema = scheduledTaskInputSchema
  .omit({ enabled: true })
  .extend({
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    status: z.enum(["active", "paused", "completed"]),
    nextRunAt: z.string().nullable(),
    lastRun: scheduledTaskRunSchema.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    sdkContext: sdkTaskContextSchema.nullable().optional(),
  })
export type ScheduledTask = z.infer<typeof scheduledTaskSchema>

export const taskRunStatusLabels: Record<ScheduledTaskRun["status"], string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  blocked: "Blocked",
  needs_attention: "Needs attention",
  failed: "Failed",
  cancelled: "Cancelled",
}
