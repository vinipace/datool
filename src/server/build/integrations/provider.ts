import { createHash } from "node:crypto"
import {
  Composio,
  SessionPreset,
  type ComposioRequestOptions,
} from "@composio/core"
import { z } from "zod"
import { TracerError } from "@/src/server/tracer/errors"

const appSchema = z
  .object({
    name: z.string().min(1).max(100),
    authConfigId: z.string().min(1).max(200),
    // A conservative operator-owned charge per attempt, not a provider invoice.
    costNanoUsd: z.number().int().positive().max(1_000_000_000_000),
    connectionCostNanoUsd: z
      .number()
      .int()
      .nonnegative()
      .max(1_000_000_000_000),
    tools: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]+$/))
      .min(1)
      .max(100),
  })
  .strict()
const configSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]+$/), appSchema)
export function integrationConfig() {
  try {
    return configSchema.parse(
      JSON.parse(process.env.DATOOL_COMPOSIO_APPS || "{}")
    )
  } catch {
    throw new TracerError(
      "VALIDATION_ERROR",
      "The installation's app integration configuration is invalid."
    )
  }
}
export function integrationApp(slug: string) {
  const app = integrationConfig()[slug]
  if (!app)
    throw new TracerError(
      "VALIDATION_ERROR",
      "This app is not enabled for this installation."
    )
  return app
}
export function composioUserId(organizationId: string, projectId: string) {
  return `datool_${createHash("sha256")
    .update(JSON.stringify([organizationId, projectId]))
    .digest("hex")}`
}
export function composioClient() {
  const apiKey = process.env.COMPOSIO_API_KEY
  if (!apiKey)
    throw new TracerError(
      "VALIDATION_ERROR",
      "App integrations have not been configured by the administrator."
    )
  return new Composio({
    apiKey,
    userApiKey: null,
    orgApiKey: null,
    allowTracking: false,
    dangerouslyAllowAutoUploadDownloadFiles: false,
  })
}
export function integrationSession(
  userId: string,
  toolkit: string,
  accountId?: string,
  toolSlug?: string
) {
  const app = integrationApp(toolkit)
  if (toolSlug && !app.tools.includes(toolSlug))
    throw new TracerError(
      "VALIDATION_ERROR",
      "This app action is no longer enabled."
    )
  return composioClient().create(
    userId,
    {
      sessionPreset: SessionPreset.DIRECT_TOOLS,
      instant: false,
      toolkits: [toolkit],
      tools: { [toolkit]: { enable: toolSlug ? [toolSlug] : app.tools } },
      authConfigs: { [toolkit]: app.authConfigId },
      ...(accountId ? { connectedAccounts: { [toolkit]: [accountId] } } : {}),
      manageConnections: { enable: false },
      sandbox: { enable: false },
      proxyExecute: false,
    },
    { signal: AbortSignal.timeout(15_000) }
  )
}

// core 0.25 implements cancellation on the session methods, but its returned
// Session interface omits the trailing requestOptions parameter.
type ConnectionRequestOptions = ComposioRequestOptions & { maxRetries: 0 }
type AppSession = Awaited<ReturnType<typeof integrationSession>>
export function authorizeSession(session: AppSession, toolkit: string) {
  const authorize: (
    ...args: [...Parameters<AppSession["authorize"]>, ConnectionRequestOptions?]
  ) => ReturnType<AppSession["authorize"]> = session.authorize.bind(session)
  return authorize(toolkit, undefined, {
    signal: AbortSignal.timeout(15_000),
    maxRetries: 0,
  })
}
export function executeSession(
  session: AppSession,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
) {
  const execute: (
    ...args: [...Parameters<AppSession["execute"]>, ComposioRequestOptions?]
  ) => ReturnType<AppSession["execute"]> = session.execute.bind(session)
  return execute(tool, args, undefined, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  })
}
