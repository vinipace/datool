import { withPromptScope } from "./prompt-scope"
import { promptRunScopeSchema, type PromptRunScope } from "./prompt-overrides"
import { AsyncLocalStorage } from "node:async_hooks"

export type DatoolCallContext = {
  connectionId: string
  callId: string
  invocationTraceId?: string
  promptScope?: PromptRunScope
}
// Share context even when a connected app imports a second SDK module copy.
const key = Symbol.for("datool.call-context.v1")
const registry = globalThis as typeof globalThis & {
  [key]: AsyncLocalStorage<DatoolCallContext> | undefined
}
const storage = (registry[key] ??= new AsyncLocalStorage<DatoolCallContext>())

export function withDatoolCall<T>(
  context: DatoolCallContext,
  action: () => T
): T {
  return storage.run(context, () =>
    withPromptScope(action, { fresh: true, run: context.promptScope })
  )
}

/** HTTP adapters can wrap their handler with this function. */
export function withDatoolRequest<T>(request: Request, action: () => T): T {
  const connectionId = request.headers.get("x-datool-connection-id")
  const callId = request.headers.get("x-datool-call-id")
  return connectionId && callId
    ? withDatoolCall(
        {
          connectionId,
          callId,
          invocationTraceId:
            request.headers.get("x-datool-invocation-trace-id") ?? undefined,
          promptScope: request.headers.has("x-datool-prompt-scope")
            ? promptRunScopeSchema.parse(
                JSON.parse(
                  Buffer.from(
                    request.headers.get("x-datool-prompt-scope")!,
                    "base64url"
                  ).toString("utf8")
                )
              )
            : undefined,
        },
        action
      )
    : action()
}

export function datoolCallAttributes(): Record<string, string> {
  const context = storage.getStore()
  const connectionId = context?.connectionId ?? process.env.DATOOL_CONNECTION_ID
  return {
    ...(connectionId ? { "datool.connection.id": connectionId } : {}),
    ...(context ? { "datool.call.id": context.callId } : {}),
  }
}

export function getDatoolCallContext() {
  return storage.getStore()
}
