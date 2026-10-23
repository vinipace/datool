import { enqueueShopifyReconciliationJobs } from "../src/server/build/integrations/shopify-reconciliation"
import { createTracerDatabase } from "../src/server/tracer/db"
import { createBuildContext } from "../src/server/build/context"
import {
  runAgentTurn,
  type RunAgentTurnInput,
} from "../src/server/build/runtime"
import {
  pinContinuationWidgets,
  runtimeMessageMetadata,
} from "../src/server/build/runtime/continuations"
import {
  claimNextChannelJob,
  completeChannelJob,
  enqueueConversationWaitJobs,
  enqueueTelegramPollingJobs,
  failChannelJob,
  processChannelJob,
  renewChannelJobLease,
  type ResumeWaitRunner,
} from "../src/server/build/channels/service"
import {
  enqueueDueKnowledgeResyncs,
  listKnowledgeProjectsWithPendingWork,
  runQueuedKnowledgeJobs,
} from "../src/server/build/knowledge/service"
import {
  listSimulationProjectsWithPendingRuns,
  runQueuedSimulationRuns,
} from "../src/server/build/testing/service"
import { createRuntimeSimulationExecutor } from "../src/server/build/testing/runtime-executor"
import {
  enqueueDueCampaigns,
  listCampaignProjectsWithPendingWork,
  processNextCampaignDelivery,
} from "../src/server/build/operations/campaigns"
import type { AgentTurnRunner } from "../src/lib/build/channels"
import { buildAvailable } from "../lib/build/config"

// Stay healthy under process supervisors without admitting or processing jobs.
if (!buildAvailable()) {
  console.info(
    "[build-worker] disabled; set DATOOL_BUILD_ENABLED=true or DATOOL_BUILD_ORGANIZATION_IDS to enable"
  )
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {}, 60_000)
    const stop = () => {
      clearInterval(timer)
      resolve()
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
  process.exit(0)
}

/** Independent queues keep long crawls and simulations from delaying customer replies. */
const workerDatabase = createTracerDatabase(undefined, {
  projectId: "build-worker",
})
const shutdown = new AbortController()
let stopped = false
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopped = true
    shutdown.abort()
  })
function sleep(ms: number) {
  if (stopped) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      shutdown.signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    shutdown.signal.addEventListener("abort", done, { once: true })
  })
}
function projectContext(projectId: string) {
  return createBuildContext(createTracerDatabase(undefined, { projectId }), {
    projectId,
  })
}
function workerErrorCode(error: unknown) {
  const value =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : error instanceof Error
        ? error.name
        : "UNKNOWN"
  return value.replace(/[^A-Za-z0-9_]/g, "").slice(0, 80) || "UNKNOWN"
}
function reportWorkerError(scope: string, error: unknown) {
  console.error("[build-worker] " + scope + " (" + workerErrorCode(error) + ")")
}
function runner(context: ReturnType<typeof projectContext>): AgentTurnRunner {
  return async (input) => {
    const latest = input.messages.at(-1)
    const metadata = JSON.parse(
      JSON.stringify({
        ...(input.metadata.metadata &&
        typeof input.metadata.metadata === "object" &&
        !Array.isArray(input.metadata.metadata)
          ? input.metadata.metadata
          : {}),
        ...input.metadata,
        ...(latest?.attachments?.length
          ? { channelAttachments: latest.attachments }
          : {}),
      })
    ) as RunAgentTurnInput["metadata"]
    const requestKey = input.metadata.requestKey
    if (typeof requestKey !== "string" || !requestKey)
      throw new Error("Channel execution requires a durable request key.")
    const result = await runAgentTurn(context, {
      agentId: input.agentId,
      channel: input.channel,
      conversationId: input.conversationId,
      externalConversationId: input.metadata.externalConversationId as
        string | undefined,
      requestKey,
      message: latest?.content ?? "",
      metadata,
    })
    if (result.status === "busy")
      throw Object.assign(
        new Error("The conversation is processing another turn."),
        {
          code: "CONVERSATION_BUSY",
          retryAfterSeconds: 2,
        }
      )
    const continuations = await pinContinuationWidgets(context, {
      channel: input.channel,
      agentId: input.agentId,
      agentRevision: result.turn.snapshot.agentRevision,
      continuations: result.continuations,
    })
    const continuationText = continuations
      .map((item) => item.message ?? item.submitLabel ?? item.eventName ?? "")
      .filter(Boolean)
      .join("\n")
    const text =
      result.text || (input.channel === "web" ? "" : continuationText)
    const handedOff =
      result.status === "handed_off" &&
      result.conversation.ownerType === "human"
    return {
      // Normal responses remain bound to the turn's admitted AI epoch. A
      // completed runtime handoff is the sole case that carries the new
      // human epoch committed by ConversationService.claim.
      ownerFence: handedOff
        ? result.conversation.ownerFence
        : result.turn.ownerFence,
      ownerType: handedOff ? "human" : "ai",
      messages:
        text || continuations.length
          ? [
              {
                text,
                ...(input.channel === "web"
                  ? { metadata: runtimeMessageMetadata(result, continuations) }
                  : {}),
              },
            ]
          : [],
      ownership: handedOff ? "human" : undefined,
      metadata: {
        traceId: result.traceId,
        status: result.status,
      },
    }
  }
}
function waitRunner(
  context: ReturnType<typeof projectContext>
): ResumeWaitRunner {
  return async (input) => {
    const result = await runAgentTurn(
      context,
      {
        agentId: input.agentId,
        channel: input.channel,
        conversationId: input.conversationId,
        externalConversationId: input.externalConversationId,
        requestKey: input.requestKey,
        message: "",
        metadata: {
          widgetInteraction: {
            actionId: "__wait__",
            continuationId: input.continuationId,
            input: {},
          },
        },
      },
      { trustedWaitContinuationId: input.continuationId }
    )
    if (result.status === "busy")
      throw Object.assign(
        new Error("The conversation is processing another turn."),
        {
          code: "CONVERSATION_BUSY",
          retryAfterSeconds: 2,
        }
      )
    return result
  }
}
async function loop(
  name: string,
  task: () => Promise<boolean | void>,
  idleMs = 1000
) {
  while (!stopped) {
    try {
      const worked = await task()
      if (!worked) await sleep(idleMs)
    } catch (error) {
      reportWorkerError(name, error)
      await sleep(Math.max(1000, idleMs))
    }
  }
}
async function channelTask() {
  const job = await claimNextChannelJob(workerDatabase)
  if (!job) return false
  const context = projectContext(job.projectId)
  let renewing = false
  const heartbeat = setInterval(() => {
    if (renewing) return
    renewing = true
    void renewChannelJobLease(workerDatabase, job)
      .catch((error) =>
        reportWorkerError("channel lease renewal failed", error)
      )
      .finally(() => {
        renewing = false
      })
  }, 30_000)
  try {
    await processChannelJob(
      job,
      runner(context),
      context.database,
      job.kind === "resume_wait"
        ? { resumeWait: waitRunner(context) }
        : undefined
    )
    await completeChannelJob(workerDatabase, job)
  } catch (error) {
    reportWorkerError("channel job " + job.id + " failed", error)
    await failChannelJob(workerDatabase, job, {
      message: "Build channel job failed (" + workerErrorCode(error) + ").",
      code: workerErrorCode(error),
      retryAfterSeconds:
        typeof error === "object" &&
        error &&
        "retryAfterSeconds" in error &&
        typeof error.retryAfterSeconds === "number"
          ? error.retryAfterSeconds
          : undefined,
      uncertain:
        typeof error === "object" && error && "uncertain" in error
          ? Boolean(error.uncertain)
          : false,
    })
  } finally {
    clearInterval(heartbeat)
  }
  return true
}
async function waitTask() {
  return (await enqueueConversationWaitJobs(workerDatabase, { limit: 100 })) > 0
}
async function knowledgeTask() {
  const projects = await listKnowledgeProjectsWithPendingWork(workerDatabase)
  for (const projectId of projects) {
    if (stopped) break
    const context = projectContext(projectId)
    try {
      await enqueueDueKnowledgeResyncs(context, { limit: 10 })
      await runQueuedKnowledgeJobs(context, { limit: 1 })
    } catch (error) {
      reportWorkerError("knowledge project job failed", error)
    }
  }
  return projects.length > 0
}
async function simulationTask() {
  const projects = await listSimulationProjectsWithPendingRuns(
    workerDatabase,
    50
  )
  for (const projectId of projects) {
    if (stopped) break
    const context = projectContext(projectId)
    try {
      await runQueuedSimulationRuns(
        context,
        createRuntimeSimulationExecutor(context),
        { maxRuns: 1, leaseSeconds: 60 }
      )
    } catch (error) {
      reportWorkerError("simulation project job failed", error)
    }
  }
  return projects.length > 0
}
async function campaignTask() {
  const projects = await listCampaignProjectsWithPendingWork(workerDatabase, 50)
  for (const projectId of projects) {
    if (stopped) break
    const context = projectContext(projectId)
    try {
      await enqueueDueCampaigns(context, { limit: 10 })
      await processNextCampaignDelivery(context)
    } catch (error) {
      reportWorkerError("campaign project job failed", error)
    }
  }
  return projects.length > 0
}

console.info(
  "[build-worker] starting channels, knowledge, simulations, and campaigns"
)
await Promise.all([
  loop(
    "Telegram polling admission failed",
    async () => {
      await enqueueTelegramPollingJobs(workerDatabase)
      return false
    },
    1000
  ),
  ...Array.from({ length: 4 }, (_, index) =>
    loop("channel consumer " + (index + 1), channelTask)
  ),
  loop("knowledge queue failed", knowledgeTask, 2000),
  loop("simulation queue failed", simulationTask, 2000),
  loop("campaign queue failed", campaignTask, 2000),
  loop("conversation wait scheduler failed", waitTask, 1000),
  loop(
    "Shopify reconciliation scheduler failed",
    async () => (await enqueueShopifyReconciliationJobs(workerDatabase)) > 0,
    2000
  ),
])
const { db, analyticsDb } = await import("../lib/db")
await Promise.all([db.end(), analyticsDb.end()])
console.info("[build-worker] stopped")
