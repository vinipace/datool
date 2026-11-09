import { sql } from "drizzle-orm"
import { sdkTaskInputSchema } from "@/src/lib/build/react-sdk"
import type { BuildContext } from "./context"
import { TracerError } from "@/src/server/tracer/errors"
import { requireSdkSession } from "./sdk-scope"
import {
  createScheduledTask,
  deleteScheduledTask,
  listScheduledTasks,
  listScheduledTaskRuns,
  runScheduledTaskNow,
  updateScheduledTask,
} from "./schedules"

export async function sdkTasks(context: BuildContext, value: unknown) {
  const input = sdkTaskInputSchema.parse(value)
  const { connection } = await requireSdkSession(
    context,
    input,
    input.conversationId
  )
  const agentId = connection.agentId
  const request = input.request
  if (request.action === "list")
    return listScheduledTasks(context, {
      agentId,
      sdkSessionId: input.conversationId,
      cursor: request.cursor,
      limit: request.limit,
    })
  if (request.action === "create") {
    return context.database.transaction(async (database) => {
      const scoped = {
        ...context,
        database: database as unknown as BuildContext["database"],
      }
      const task = await createScheduledTask(scoped, {
        ...request.task,
        agentId,
        channel: "api",
      })
      await database.execute(
        sql`INSERT INTO build_sdk_tasks(project_id,task_id,conversation_id) VALUES(${context.projectId},${task.id}::uuid,${input.conversationId})`
      )
      return task
    })
  }
  const task = (
    await listScheduledTasks(context, {
      agentId,
      sdkSessionId: input.conversationId,
      id: request.id,
    })
  ).items[0]
  if (!task)
    throw new TracerError(
      "NOT_FOUND",
      "Scheduled task not found in this SDK session."
    )
  if (request.action === "runs")
    return listScheduledTaskRuns(context, {
      agentId,
      taskId: task.id,
      cursor: request.cursor,
      limit: request.limit,
    })
  if (request.action === "run")
    return runScheduledTaskNow(context, { agentId, id: task.id })
  if (request.action === "delete")
    return deleteScheduledTask(context, {
      agentId,
      id: task.id,
      expectedRevision: request.expectedRevision,
    })
  return updateScheduledTask(context, {
    agentId,
    channel: "api",
    id: task.id,
    expectedRevision: request.expectedRevision,
    ...(request.action === "update"
      ? request.task
      : {
          name: task.name,
          prompt: task.prompt,
          schedule: task.schedule,
          timezone: task.timezone,
          enabled: request.action === "resume",
        }),
  })
}
