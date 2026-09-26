import { z } from "zod"
import {
  GATEWAY_PROVIDER,
  OPENAI_PROVIDER,
  isGatewayModelId,
  isOpenAIModelId,
} from "../model-providers"

export const promptMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z
    .string()
    .max(50_000)
    .refine((value) => value.trim().length > 0, "Enter message text."),
})
export const promptConfigSchema = z
  .object({
    provider: z
      .enum([GATEWAY_PROVIDER, OPENAI_PROVIDER])
      .default(GATEWAY_PROVIDER),
    model: z.string().min(1).max(200),
    messages: z.array(promptMessageSchema).min(1).max(50),
    template: z.enum(["mustache", "none"]).default("mustache"),
    output: z.enum(["text", "json"]).default("text"),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(128_000).optional(),
  })
  .refine(
    ({ provider, model }) =>
      provider === OPENAI_PROVIDER
        ? isOpenAIModelId(model)
        : isGatewayModelId(model),
    { message: "Select a model for the prompt.", path: ["model"] }
  )
export const promptInputSchema = promptConfigSchema.safeExtend({
  name: z.string().trim().min(1, "Enter a prompt name.").max(120),
  slug: z
    .string()
    .min(1, "Enter a slug.")
    .max(120)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "Use lowercase letters, numbers and hyphens for the slug."
    ),
  description: z.string().max(10_000).default(""),
  metadata: z.record(z.string().max(120), z.json()).default({}),
})
// Drafts may be saved before a model or message content has been completed.
export const promptDraftSchema = z.object({
  ...promptInputSchema.shape,
  model: z.string().max(200),
  messages: z
    .array(promptMessageSchema.extend({ content: z.string().max(50_000) }))
    .min(1)
    .max(50),
})
export const promptUpdateSchema = promptDraftSchema.extend({
  expectedRevision: z.number().int().positive(),
})
export const promptPublishSchema = z.object({
  expectedRevision: z.number().int().positive(),
})
export type PromptInput = z.infer<typeof promptInputSchema>
export type PromptMessage = z.infer<typeof promptMessageSchema>
export type ManagedPrompt = PromptInput & {
  id: string
  revision: number
  /** The requested published snapshot, or null for the editable draft. */
  version: number | null
  publishedVersion: number | null
  publishedAt: string | null
  hasDraft: boolean
  createdAt: string
  updatedAt: string
}
export function promptPublicationLabel(
  prompt: Pick<ManagedPrompt, "hasDraft" | "publishedVersion">
) {
  return prompt.publishedVersion === null
    ? "Draft"
    : prompt.hasDraft
      ? "Unpublished changes"
      : "Published"
}
export const defaultPrompt: PromptInput = {
  name: "",
  slug: "",
  description: "",
  metadata: {},
  provider: GATEWAY_PROVIDER,
  model: "",
  messages: [{ role: "system", content: "you're helpful assistant" }],
  template: "mustache",
  output: "text",
}

// Deliberately limited to named placeholders: no evaluation or HTML escaping.
const placeholder = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*\}\}/g
export function promptVariables(
  config: Pick<PromptInput, "template" | "messages">
) {
  if (config.template === "none") return []
  return [
    ...new Set(
      config.messages.flatMap((message) =>
        [...message.content.matchAll(placeholder)].map((match) => match[1])
      )
    ),
  ].sort()
}
export function renderPrompt(
  config: Pick<PromptInput, "template" | "messages">,
  variables: Record<string, string>
) {
  const missing = promptVariables(config).filter(
    (name) => !Object.hasOwn(variables, name)
  )
  if (missing.length)
    throw new Error(`Enter values for: ${missing.join(", ")}.`)
  return config.messages.map((message) => ({
    ...message,
    content:
      config.template === "none"
        ? message.content
        : message.content.replace(
            placeholder,
            (_, name: string) => variables[name]
          ),
  }))
}
export const promptTestSchema = z.object({
  config: promptConfigSchema,
  variables: z.record(z.string(), z.string().max(50_000)).default({}),
  messages: z
    .array(promptMessageSchema.extend({ role: z.enum(["user", "assistant"]) }))
    .min(1)
    .max(100),
})
