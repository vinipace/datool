import type { BuildContext } from "../context"
import { bindEveSession, getEveExecution } from "./store"
import type { EveExecution } from "./contracts"

export class EveExecutionPendingError extends Error {
  readonly code = "EXECUTION_PENDING"
  readonly retryAfterSeconds = 2
  readonly details: {
    reason: "EXECUTION_PENDING"
    conversationId: string
    turnId: string
  }

  constructor(
    message: string,
    run: Pick<EveExecution, "conversationId" | "turnId">
  ) {
    super(message)
    this.details = {
      reason: this.code,
      conversationId: run.conversationId,
      turnId: run.turnId,
    }
  }
}

function connection() {
  const url = process.env.DATOOL_EVE_URL
  const secret = process.env.DATOOL_EVE_SECRET
  if (!url || !secret || secret.length < 32)
    throw new Error(
      "Configure DATOOL_EVE_URL and DATOOL_EVE_SECRET (at least 32 characters)."
    )
  return { url: url.replace(/\/$/, ""), secret }
}

async function request(
  run: EveExecution,
  operation: "execute" | "result" | "cancel",
  signal?: AbortSignal,
  timeoutMs = 10_000
) {
  const { url, secret } = connection()
  return fetch(
    `${url}/datool/executions/${encodeURIComponent(run.projectId)}/${encodeURIComponent(run.turnId)}/${operation}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    }
  )
}

export async function cancelEveExecution(run: EveExecution) {
  await request(run, "cancel")
}

/** One idempotent delivery/recovery attempt, also used by the queue worker. */
export async function advanceEveExecution(
  context: BuildContext,
  run: EveExecution,
  signal?: AbortSignal
) {
  if (run.outcome) return run
  const response = await request(
    run,
    run.sessionId ? "result" : "execute",
    signal
  )
  if (!response.ok)
    throw new Error(`Eve execution request failed (HTTP ${response.status}).`)
  const data = (await response.json()) as { sessionId?: string }
  if (data.sessionId) await bindEveSession(context, run.turnId, data.sessionId)
  return getEveExecution(context, run.turnId)
}

/** Polling is only delivery observation; Eve alone executes and recovers the workflow. */
export async function waitForEveExecution(
  context: BuildContext,
  run: EveExecution,
  signal?: AbortSignal
) {
  connection()
  let dispatched = Boolean(run.sessionId)
  const deadline = Date.now() + 30_000
  let unavailableSince: number | undefined
  for (;;) {
    if (signal?.aborted) {
      await request(run, "cancel").catch(() => undefined)
      throw signal.reason ?? new Error("The turn was cancelled.")
    }
    const current = await getEveExecution(context, run.turnId)
    if (current.outcome) return current
    if (
      unavailableSince !== undefined &&
      Date.now() - unavailableSince >= 5_000
    )
      throw new EveExecutionPendingError(
        "Your message was saved, but the agent service is temporarily unavailable. It will resume when the service returns.",
        current
      )
    if (Date.now() >= deadline)
      throw new EveExecutionPendingError(
        "Your message was saved. The agent is still working; the reply will appear here.",
        current
      )
    const attemptStarted = Date.now()
    try {
      const timeoutMs = Math.max(
        1,
        Math.min(
          5_000,
          deadline - attemptStarted,
          (unavailableSince ?? attemptStarted) + 5_000 - attemptStarted
        )
      )
      const response = await request(
        run,
        dispatched ? "result" : "execute",
        signal,
        timeoutMs
      )
      if (response.ok) {
        const data = (await response.json()) as {
          sessionId?: string
          error?: string
        }
        if (data.sessionId) {
          await bindEveSession(context, run.turnId, data.sessionId)
          dispatched = true
        }
        unavailableSince = undefined
      } else if (response.status < 500 && response.status !== 409) {
        throw new Error(`Eve rejected the execution (HTTP ${response.status}).`)
      } else unavailableSince ??= attemptStarted
    } catch (error) {
      if (signal?.aborted) continue
      if (error instanceof Error && error.message.startsWith("Eve rejected"))
        throw error
      unavailableSince ??= attemptStarted
    }
    // Bound HTTP observation, not the durable workflow. The worker or a retry
    // with the same request key resumes this exact execution after an outage.
    await new Promise<void>((resolve) => setTimeout(resolve, 250))
  }
}
