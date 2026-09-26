import type { PromptRunScope } from "../tracer/prompt-overrides"
import { z } from "zod"

export const connectionTypes = [
  { id: "bridge", name: "Local bridge" },
  { id: "webhook", name: "HTTP webhook" },
] as const

const headers = z
  .record(
    z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
    z
      .string()
      .max(4096)
      .regex(/^[^\r\n]*$/)
  )
  .refine((value) => Object.keys(value).length <= 20, "Use at most 20 headers.")
  .refine(
    (value) =>
      !Object.keys(value).some((name) =>
        /^(host|content-length|connection|transfer-encoding|proxy-.*|x-datool-.*|traceparent)$/i.test(
          name
        )
      ),
    "This header is managed by Datool."
  )

export const webhookConnectionSchema = z
  .object({
    type: z.literal("webhook"),
    url: z
      .url()
      .max(4096)
      .refine((value) => {
        const url = new URL(value)
        return (
          ["https:", "http:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.hash
        )
      }, "Use an HTTP(S) URL without embedded credentials or a fragment."),
    method: z.enum(["POST", "PUT", "PATCH"]).default("POST"),
    body: z.enum(["input", "envelope"]).default("input"),
    timeoutMs: z.number().int().min(1000).max(60000).default(60000),
    // Omitted on update preserves credentials; {} explicitly clears them.
    headers: headers.optional(),
  })
  .strict()
export const appConnectionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bridge") }).strict(),
  webhookConnectionSchema,
])
export type AppConnection = z.infer<typeof appConnectionSchema>
export type WebhookConnection = z.infer<typeof webhookConnectionSchema>
export type PublicAppConnection =
  | { type: "bridge" }
  | (Omit<WebhookConnection, "headers"> & { headerNames: string[] })

export type BridgeJob = {
  executionTimeoutMs?: number
  promptScope?: PromptRunScope
  id: string
  appId: string
  callId: string
  traceId?: string
  input: unknown
  deadline: number
}
export type BridgeResult =
  | { ok: true; output: unknown; telemetryComplete: boolean }
  | { ok: false; error: string }
