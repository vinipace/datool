import { BRIDGE_RETRY_BUDGET_MS } from "../src/lib/playground/bridge-retry"
import { retryBackoffMs, transientHttpStatuses } from "../src/lib/tracer/retry"
import { captureCodeProvenance } from "./code-provenance"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import {
  definitionSchema,
  type AppConfig,
  type AppDefinition,
} from "../src/lib/playground/contracts.ts"
import { withDatoolCall } from "../src/lib/tracer/call-context.ts"
import { setTimeout as delay } from "node:timers/promises"
import type { BridgeJob, BridgeResult } from "../src/lib/playground/connections"
import { checkSchema } from "../src/server/playground/schema"

import { appRequest, DatoolRequestError } from "./request"

export function parseAppManifest(config: AppConfig) {
  if (!config || !Array.isArray(config.apps) || !config.apps.length)
    throw new Error(
      "Manifest must export a non-empty apps array of workflow or agent handlers."
    )
  const apps = config.apps.map((app) => {
    if (!app || typeof app !== "object")
      throw new Error("Invalid manifest handler.")
    if (
      app.type !== undefined &&
      app.type !== "workflow" &&
      app.type !== "agent"
    )
      throw new Error(`Handler ${app.id} type must be workflow or agent.`)
    const mode = app.type
      ? app.type === "agent"
        ? "agent"
        : "input"
      : app.mode
    if (app.type && app.mode && app.mode !== mode)
      throw new Error(`Handler ${app.id} has conflicting type and mode.`)
    const definition = definitionSchema.parse({
      ...app,
      mode,
      codeProvenance: captureCodeProvenance(),
    })
    if (definition.inputSchema.type !== "object")
      throw new Error(
        `Handler ${definition.id} must declare an object input schema.`
      )
    // Reject invalid schema edits before a watcher drains the serving process.
    checkSchema(definition.inputSchema)
    checkSchema(definition.outputSchema)
    if (typeof app.handler !== "function")
      throw new Error(`Missing handler for ${definition.id}`)
    if (
      app.flushTelemetry !== undefined &&
      typeof app.flushTelemetry !== "function"
    )
      throw new Error(`flushTelemetry for ${definition.id} must be a function.`)
    return {
      ...definition,
      handler: app.handler,
      flushTelemetry: app.flushTelemetry,
    }
  })
  if (new Set(apps.map((app) => app.id)).size !== apps.length)
    throw new Error("Duplicate app IDs")
  return apps
}

async function syncDefinitions(
  definitions: ReturnType<typeof definitionSchema.parse>[],
  origin: string
) {
  const apps = await appRequest<AppDefinition[]>(
    origin,
    "/api/apps/config",
    definitions.map((definition) => ({
      ...definition,
      connection: { type: "bridge" },
    }))
  )
  console.info(
    `Synced ${apps.length} handler definitions. They remain available when the listener is offline.`
  )
  return apps
}

export async function syncApps(config: AppConfig, origin: string) {
  const definitions = parseAppManifest(config).map((app) =>
    definitionSchema.parse(app)
  )
  return syncDefinitions(definitions, origin)
}
export type BridgeSession = {
  id: string
  token: string
  appIds: string[]
  revisions: Record<string, number>
  transport: "relay"
}
export async function connectApps(
  config: AppConfig,
  origin: string,
  options: {
    signal?: AbortSignal
    watched?: boolean
    resume?: BridgeSession
    onConnected?: (session: BridgeSession) => void
  } = {}
): Promise<void> {
  const apps = parseAppManifest(config)
  const definitions = apps.map((app) => definitionSchema.parse(app))
  const registered = await syncDefinitions(definitions, origin)
  const revisions: Record<string, number> = {}
  for (const definition of definitions) {
    const saved = registered.find((a) => a.id === definition.id)
    if (!saved || !isDeepStrictEqual(definitionSchema.parse(saved), definition))
      throw new Error(
        `Datool returned a different definition for ${definition.id}; the listener was not started.`
      )
    revisions[definition.id] = saved.revision
  }
  const session = {
    id: options.resume?.id ?? randomUUID(),
    appIds: definitions.map((app) => app.id),
    revisions,
    transport: "relay" as const,
    protocolVersion: 2 as const,
    token: randomUUID(),
  }
  const registration = {
    ...session,
    ...(options.resume ? { resumeToken: options.resume.token } : {}),
  }
  let connected: {
    transport: string
    protocolVersion?: number
    reload?: string
  }
  // A lost registration reply must retry the same token rotation, never create
  // another session whose ownership is uncertain.
  const registerDeadline = Date.now() + 20000
  while (true) {
    try {
      connected = await appRequest(origin, "/api/apps/bridges", registration)
      break
    } catch (error) {
      if (
        (error instanceof DatoolRequestError &&
          [400, 401, 403, 409].includes(error.status ?? 0)) ||
        Date.now() >= registerDeadline
      )
        throw error
      await delay(500)
    }
  }
  if (
    connected.transport !== "relay" ||
    connected.protocolVersion !== 2 ||
    (options.watched && connected.reload !== "session-v1")
  ) {
    await appRequest(origin, "/api/apps/bridges", {
      ...session,
      disconnect: true,
    })
    throw new Error(
      connected.protocolVersion !== 2
        ? "Server does not support resilient outbound bridges (protocol 2). Update Datool before connecting."
        : "Server does not support safe watched reloads. Update Datool before connecting with --watch."
    )
  }
  console.info(
    `Listening for ${apps.map((app) => `${app.mode === "agent" ? "agent" : "workflow"} ${app.id}`).join(", ")} through outbound HTTPS. Open ${origin}/playground`
  )
  options.onConnected?.(session)
  let stopped = options.signal?.aborted ?? false
  const stop = () => {
    stopped = true
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  options.signal?.addEventListener("abort", stop, { once: true })
  const tasks = new Map<string, { job: BridgeJob; result?: BridgeResult }>()
  const seen = new Map<string, number>()
  async function execute(job: BridgeJob) {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const task = { job } as { job: BridgeJob; result?: BridgeResult }
    tasks.set(job.id, task)
    seen.set(job.id, job.deadline)
    try {
      if (job.deadline <= Date.now())
        throw new Error("Invocation expired before execution.")
      const app = apps.find((app) => app.id === job.appId)
      if (!app) throw new Error("App not served by this bridge.")
      const input =
        app.mode === "agent"
          ? (job.input as { messages: unknown }).messages
          : job.input
      const execution = withDatoolCall(
        {
          connectionId: app.id,
          callId: job.callId,
          invocationTraceId: job.traceId,
          promptScope: job.promptScope
            ? { ...job.promptScope, baseUrl: origin }
            : undefined,
        },
        async () => {
          const output = await app.handler(input as never)
          const json = JSON.stringify(output)
          if (json === undefined || Buffer.byteLength(json) > 768 * 1024)
            throw new Error("Handler output must be JSON and at most 768 KiB.")
          await app.flushTelemetry?.()
          return JSON.parse(json)
        }
      )
      const output = await Promise.race([
        execution,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  "Local handler execution timed out. It may still be running; this call will not be executed again automatically."
                )
              ),
            Math.min(60_000, job.executionTimeoutMs ?? 60_000)
          )
        }),
      ])
      task.result = {
        ok: true,
        output,
        telemetryComplete: !!app.flushTelemetry,
      }
    } catch (error) {
      task.result = {
        ok: false,
        error: (error instanceof Error
          ? error.message
          : "Handler failed"
        ).slice(0, 4000),
      }
    } finally {
      clearTimeout(timeout)
    }
  }
  let sequence = 0
  let failures = 0
  let interruptedAt: number | undefined
  let pending:
    | {
        id: string
        token: string
        requestId: string
        sequence?: number
        capacity: number
        results: { id: string; result: BridgeResult }[]
      }
    | undefined
  try {
    // Draining stops new claims, but must retry any outstanding exchange verbatim
    // and deliver every claimed call's result before this process can be replaced.
    while (!stopped || pending || tasks.size) {
      // Retry the identical exchange after uncertain delivery. A new claim must use a new ID.
      pending ??= {
        id: session.id,
        token: session.token,
        requestId: randomUUID(),
        ...(connected.reload === "session-v1" ? { sequence: ++sequence } : {}),
        capacity: stopped ? 0 : Math.max(0, 16 - tasks.size),
        results: [...tasks]
          .filter(([, task]) => task.result)
          .slice(0, 1)
          .map(([id, task]) => ({ id, result: task.result! })),
      }
      try {
        const reply = await appRequest<{
          jobs: BridgeJob[]
          acknowledged: string[]
        }>(origin, "/api/apps/bridges/exchange", pending)
        pending = undefined
        failures = 0
        interruptedAt = undefined
        for (const id of reply.acknowledged) tasks.delete(id)
        for (const job of reply.jobs) if (!seen.has(job.id)) void execute(job)
        for (const [id, deadline] of seen)
          if (deadline < Date.now() && !tasks.has(id)) seen.delete(id)
        if (!reply.jobs.length && !reply.acknowledged.length)
          await delay(tasks.size ? 500 : 2000)
      } catch (error) {
        interruptedAt ??= Date.now()
        const retryable =
          error instanceof DatoolRequestError &&
          (error.category === "disconnected" ||
            transientHttpStatuses.includes(error.status ?? 0))
        if (!retryable) throw error
        const wait = retryBackoffMs(failures++, error.retryAfterMs)
        if (Date.now() - interruptedAt + wait > BRIDGE_RETRY_BUDGET_MS)
          throw new Error(
            `Bridge ${error.category}: retry window exhausted. ${tasks.size} call(s) may have uncertain completion; inspect the existing run and recover saved results. No app calls were replayed.`
          )
        console.error(
          `Bridge ${error.category}${error.status ? ` (HTTP ${error.status})` : ""}; retrying the identical exchange in ${Math.ceil(wait / 1000)}s. Pending outputs remain retained.`
        )
        await delay(wait)
      }
    }
  } finally {
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
    options.signal?.removeEventListener("abort", stop)
    // Only an explicitly requested, fully acknowledged reload leaves the mailbox
    // available. Uncertain delivery retains the lease and stored results for recovery.
    if (options.signal?.reason !== "reload" && !pending && !tasks.size) {
      try {
        await appRequest(origin, "/api/apps/bridges", {
          ...session,
          disconnect: true,
        })
      } catch {
        /* The session lease expires when the server is unavailable. */
      }
    }
  }
}
