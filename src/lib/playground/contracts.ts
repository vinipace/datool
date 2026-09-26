import { z } from "zod"
import type { PublicAppConnection } from "./connections"

export const appId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_.-]+$/)
export const jsonSchema = z.record(z.string(), z.unknown())
export const definitionSchema = z.object({
  id: appId,
  name: z.string().min(1).max(120),
  mode: z.enum(["input", "agent"]).default("input"),
  inputSchema: jsonSchema,
  outputSchema: jsonSchema,
  codeProvenance: z.object({ source: z.enum(["local-git", "declared", "unknown"]), revision: z.string().max(200).optional(), dirty: z.boolean().optional(), fingerprint: z.string().max(200).optional() }).strict().optional(),
  internalTracing: z.boolean().default(false),
  defaultInput: z.unknown().optional(),
  evaluatorIds: z.array(z.string()).default([]),
})
export type AppDefinition = z.infer<typeof definitionSchema> & {
  revision: number
  connection?: PublicAppConnection
}
export type AvailableApp = AppDefinition & { online: boolean }
export const bindingSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("shared"), path: z.string() }),
  z.object({
    source: z.literal("output"),
    nodeId: z.string(),
    path: z.string(),
  }),
])
export const nodeSchema = z.object({
  id: z.string().min(1),
  appId,
  label: z.string().optional(),
  position: z.object({ x: z.number(), y: z.number() }),
  input: z.record(z.string(), z.unknown()).default({}),
  bindings: z.record(z.string(), bindingSchema).default({}),
  dependsOn: z.array(z.string()).default([]),
  evaluatorIds: z.array(z.string().min(1)).max(10).optional(),
  selectedAttemptId: z.string().optional(),
})
export const playgroundSchema = z.object({
  name: z.string().min(1).max(120),
  shared: z.record(z.string(), z.unknown()).default({}),
  nodes: z.array(nodeSchema).default([]),
})
export type PlaygroundNode = z.infer<typeof nodeSchema>
export type Playground = z.infer<typeof playgroundSchema> & {
  id: string
  revision: number
}
export type Attempt = {
  id: string
  playgroundId: string
  nodeId: string
  appId: string
  appRevision: number
  appDefinition?: AppDefinition
  createdAt: string
  completedAt?: string
  input: unknown
  upstream: Record<string, string>
  signature: string
  status: "running" | "completed" | "error"
  output?: unknown
  error?: string
  evaluatorIds?: string[]
  traceId?: string
  scoringError?: string
  evalRunIds: string[]
}
export type PlaygroundDetail = { playground: Playground; attempts: Attempt[] }

export type HandlerType = "workflow" | "agent"

/** A manifest of callable handlers; implementation code stays in the listener. */
export type AppConfig = {
  apps: Array<
    z.input<typeof definitionSchema> & {
      /** Defaults to workflow. Legacy mode: input is also supported. */
      type?: HandlerType
      flushTelemetry?: () => Promise<void>
      handler: (input: never) => unknown | Promise<unknown>
    }
  >
}
export function defineApps<T extends AppConfig>(config: T): T {
  return config
}
