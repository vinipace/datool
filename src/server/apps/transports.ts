import type { PromptRunScope } from "@/src/lib/tracer/prompt-overrides"
import type { WebhookConnection } from "@/src/lib/playground/connections"
import { invokeHttp } from "./http-transport"
import { relay } from "./relay"

export type TransportTargets = {
  bridge: { type: "bridge"; bridgeId: string; revision?: number }
  webhook: { type: "webhook"; config: WebhookConnection }
}
export type TransportTarget = TransportTargets[keyof TransportTargets]
export type InvocationContext = {
  promptScope?: PromptRunScope
  appId: string
  callId: string
  traceId?: string
}
export type InvocationResult = { output: unknown; telemetryComplete: boolean }
// New connection types implement this contract; consumers never branch on their type.
export type ConnectionAdapter<T extends TransportTarget> = {
  invoke(
    target: T,
    input: unknown,
    envelope: unknown,
    context: InvocationContext
  ): Promise<InvocationResult>
}
export const connectionAdapters: {
  [K in keyof TransportTargets]: ConnectionAdapter<TransportTargets[K]>
} = {
  bridge: {
    async invoke(target, input, _envelope, context) {
      const result = await relay.invoke(
        target.bridgeId,
        context.appId,
        input,
        context.callId,
        context.traceId,
        60000,
        context.promptScope,
        target.revision
      )
      if (!result.ok) throw new Error(result.error)
      return result
    },
  },
  webhook: {
    invoke: (target, input, envelope, context) =>
      invokeHttp(target.config, input, envelope, context),
  },
}
export function invokeTransport(
  target: TransportTarget,
  input: unknown,
  envelope: unknown,
  context: InvocationContext
) {
  const adapter = connectionAdapters[
    target.type
  ] as ConnectionAdapter<TransportTarget>
  return adapter.invoke(target, input, envelope, context)
}
