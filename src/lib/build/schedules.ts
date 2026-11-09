import { z } from "zod"
import { buildChannelSchema } from "./contracts"
import type { SdkTaskContext } from "./sdk-context"

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

export type ScheduledTaskRun = {
  id: string
  taskId: string
  source: "schedule" | "manual"
  status:
    | "queued"
    | "running"
    | "completed"
    | "blocked"
    | "needs_attention"
    | "failed"
    | "cancelled"
  scheduledAt: string
  startedAt: string | null
  finishedAt: string | null
  conversationId: string | null
  traceId: string | null
  error: string | null
}

export type ScheduledTask = Omit<ScheduledTaskInput, "enabled"> & {
  id: string
  revision: number
  status: "active" | "paused" | "completed"
  nextRunAt: string | null
  lastRun: ScheduledTaskRun | null
  createdAt: string
  updatedAt: string
  sdkContext?: SdkTaskContext | null
}

export const taskRunStatusLabels: Record<ScheduledTaskRun["status"], string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  blocked: "Blocked",
  needs_attention: "Needs attention",
  failed: "Failed",
  cancelled: "Cancelled",
}
