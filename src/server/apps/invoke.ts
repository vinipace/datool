import type { PromptRunScope } from "@/src/lib/tracer/prompt-overrides"
import { randomUUID, createHash } from "node:crypto"
import type {
  JsonValue,
  TraceDetail,
  TraceForEvaluation,
} from "@/src/lib/tracer/contracts"
import type { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect } from "@/src/server/tracer/effect"
import { notFound, TracerError } from "@/src/server/tracer/errors"
import {
  readState,
  liveBridge,
  type State,
} from "@/src/server/playground/storage"
import { validateSchema } from "@/src/server/playground/schema"
import { invokeConnection, readConnections, type Connection } from "./store"
import { decryptProviderKey } from "@/src/server/model-providers/secrets"
import { currentProjectId } from "@/src/server/playground/storage"

export async function resolveApp(appId: string) {
  const state = await readState()
  const registered = resolveRegisteredApp(state, appId)
  if (registered) return registered
  const connection = (await readConnections()).find((app) => app.id === appId)
  if (!connection) throw notFound("App", appId)
  return {
    connection,
    definition: {
      id: connection.id,
      name: connection.name,
      mode: connection.mode,
      revision: 1,
      inputSchema: {},
      outputSchema: {},
      evaluatorIds: [] as string[],
      internalTracing: false,
    },
  }
}
export function resolveRegisteredApp(state: State, appId: string) {
  const app = state.apps.find((app) => app.id === appId)
  if (app) {
    const config = state.connections?.[appId]
    if (config?.type === "webhook") {
      const { encryptedHeaders } = config
      const http = {
        type: "webhook" as const,
        url: config.url,
        method: config.method,
        body: config.body,
        timeoutMs: config.timeoutMs,
      }
      const headers = encryptedHeaders
        ? JSON.parse(
            decryptProviderKey(
              encryptedHeaders,
              currentProjectId(),
              `app:${appId}`
            )
          )
        : {}
      return {
        definition: app,
        connection: {
          id: app.id,
          name: app.name,
          mode: app.mode,
          url: http.url,
          target: { type: "webhook", config: { ...http, headers } },
        } as Connection,
      }
    }
    const bridge = liveBridge(state, appId)
    if (!bridge)
      throw new TracerError(
        "CONFLICT",
        "App is offline. Run bunx datool connect to reconnect its listener."
      )
    return {
      connection: {
        id: app.id,
        name: app.name,
        mode: app.mode,
        url: bridge.url,
        token: bridge.token,
        ...(bridge.transport === "relay"
          ? {
              target: {
                type: "bridge",
                bridgeId: bridge.id,
                revision: app.revision,
              },
            }
          : {}),
      } as Connection,
      definition: app,
    }
  }
  return undefined
}
export type ResolvedApp = Awaited<ReturnType<typeof resolveApp>>
export function validateAppInput(app: ResolvedApp, input: unknown) {
  validateSchema(app.definition.inputSchema, input)
  if (
    app.connection.mode === "agent" &&
    (!input ||
      typeof input !== "object" ||
      !Array.isArray((input as { messages?: unknown }).messages))
  )
    throw new Error("Agent dataset input must contain messages")
}
export async function beginInvocation(
  service: TracerService,
  app: ResolvedApp,
  input: unknown,
  callId: string = randomUUID()
) {
  return runTracerEffect(
    service.createTrace({
      id: createHash("sha256").update(callId).digest("hex").slice(0, 32),
      name: app.definition.name,
      operation: "app.invoke",
      group: {
        type: app.connection.mode === "agent" ? "agent" : "workflow",
        name: app.definition.name,
        version: String(app.definition.revision),
      },
      input: input as JsonValue,
      startedAt: new Date().toISOString(),
      status: "running",
      attributes: {
        "datool.call.id": callId,
        "datool.connection.id": app.definition.id,
        "datool.invocation": true,
        "datool.span.kind":
          app.connection.mode === "agent" ? "agent" : "workflow",
        "datool.app.revision": app.definition.revision,
        "datool.trace.coverage": "invocation-only",
      },
    })
  )
}
export async function executeInvocation(
  service: TracerService,
  app: ResolvedApp,
  trace: TraceDetail,
  promptScope?: PromptRunScope
) {
  try {
    validateAppInput(app, trace.input)
    let flushed = false
    const output = await invokeConnection(
      app.connection,
      app.connection.mode === "agent" ? trace.input : { input: trace.input },
      String(trace.attributes["datool.call.id"]),
      {
        traceId: trace.id,
        promptScope,
        onResponse: (response) => {
          flushed =
            response.headers.get("x-datool-telemetry-complete") === "true"
        },
      }
    )
    validateSchema(app.definition.outputSchema, output)
    return await runTracerEffect(
      service.patchTrace(trace.id, {
        output: output as JsonValue,
        status: "completed",
        endedAt: new Date().toISOString(),
        attributes: {
          ...trace.attributes,
          "datool.telemetry.flushed": flushed,
        },
      })
    )
  } catch (error) {
    return runTracerEffect(
      service.patchTrace(trace.id, {
        status: "errored",
        endedAt: new Date().toISOString(),
        attributes: {
          ...trace.attributes,
          "error.message": (error as Error).message,
        },
      })
    )
  }
}
/** Freeze the exact evidence used for scoring, including separately exported trees. */
export async function invocationEvidence(
  service: TracerService,
  trace: TraceDetail,
  waitForInternal = false
): Promise<TraceForEvaluation> {
  const callId = trace.attributes["datool.call.id"]
  if (!callId) return trace
  const deadline = Date.now() + (waitForInternal ? 20_000 : 0)
  let linked: TraceDetail[] = []
  do {
    trace = await runTracerEffect(service.getTraceArtifact(trace.id))
    const related = await runTracerEffect(
      service.listTraces({
        filter: `metadata."datool.call.id" = ${JSON.stringify(callId)}`,
        limit: 100,
      })
    )
    if (related.nextCursor)
      throw new Error("Too many correlated traces to snapshot safely")
    linked = await Promise.all(
      related.items
        .filter((t) => t.id !== trace.id)
        .map((t) => runTracerEffect(service.getTraceArtifact(t.id)))
    )
    if (
      !waitForInternal ||
      trace.attributes["datool.telemetry.flushed"] === true
    )
      break
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  } while (Date.now() <= deadline)
  const pending =
    trace.spans.some((s) => !s.endedAt) ||
    linked.some((t) => !t.endedAt || t.spans.some((s) => !s.endedAt))
  const coverage = pending
    ? "incomplete"
    : trace.attributes["datool.telemetry.flushed"] === true
      ? "complete"
      : linked.length || trace.spans.length
        ? "unknown"
        : waitForInternal
          ? "incomplete"
          : "invocation-only"
  return {
    ...trace,
    attributes: { ...trace.attributes, "datool.trace.coverage": coverage },
    linkedTraces: linked,
  }
}
