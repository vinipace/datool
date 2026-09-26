import { z } from "zod"

export const sandboxProviderIds = [
  "datool",
  "local",
  "vercel",
  "modal",
] as const
export type SandboxProviderId = (typeof sandboxProviderIds)[number]
export const sandboxProviderNames: Record<SandboxProviderId, string> = {
  datool: "Datool Sandbox",
  local: "Local container",
  vercel: "Vercel Sandbox",
  modal: "Modal",
}
export const sandboxProviderIdSchema = z.enum(sandboxProviderIds)
const credential = z.string().trim().min(1).max(4096).regex(/^\S+$/)
const identifier = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\w-]+$/)

export const sandboxCredentialsSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("datool") }).strict(),
  z.object({ provider: z.literal("local") }).strict(),
  z
    .object({
      provider: z.literal("vercel"),
      apiKey: credential,
      teamId: identifier,
      projectId: identifier,
    })
    .strict(),
  z
    .object({
      provider: z.literal("modal"),
      tokenId: credential,
      tokenSecret: credential,
    })
    .strict(),
])
export type SandboxCredentials = z.infer<typeof sandboxCredentialsSchema>

/** Omitted secrets preserve the saved value; empty secrets are never accepted. */
export const sandboxProviderInputSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("datool") }).strict(),
  z.object({ provider: z.literal("local") }).strict(),
  z
    .object({
      provider: z.literal("vercel"),
      apiKey: credential.optional(),
      teamId: identifier,
      projectId: identifier,
    })
    .strict(),
  z
    .object({
      provider: z.literal("modal"),
      tokenId: credential.optional(),
      tokenSecret: credential.optional(),
    })
    .strict(),
])
export type SandboxProviderInput = z.infer<typeof sandboxProviderInputSchema>
export type SandboxProviderStatus = {
  id: SandboxProviderId
  configured: boolean
  teamId?: string
  projectId?: string
}
export type SandboxProviderSettings = {
  providers: SandboxProviderStatus[]
  defaultProvider: SandboxProviderId | null
  executionOrder: SandboxProviderId[]
}

/** Remaining configured providers have a stable, visible fallback order. */
export function sandboxExecutionOrder(
  configured: SandboxProviderId[],
  defaultProvider: SandboxProviderId | null
) {
  if (defaultProvider === "datool") return ["datool"] as SandboxProviderId[]
  return [
    ...(defaultProvider && configured.includes(defaultProvider)
      ? [defaultProvider]
      : []),
    ...sandboxProviderIds.filter(
      (id) =>
        id !== "datool" && configured.includes(id) && id !== defaultProvider
    ),
  ]
}
