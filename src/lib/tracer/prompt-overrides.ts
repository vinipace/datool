import { z } from "zod"

export const promptSlugSchema = z
  .string()
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
export const promptOverrideSchema = z
  .object({
    version: z.number().int().positive().max(2147483647).optional(),
    model: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
export const promptOverridesSchema = z
  .record(promptSlugSchema, promptOverrideSchema)
  .refine(
    (value) => Object.keys(value).length <= 100,
    "Use at most 100 prompt overrides."
  )
export type PromptOverride = z.infer<typeof promptOverrideSchema>
export type PromptOverrides = Record<string, PromptOverride>
export type FrozenPromptConfig = {
  projectId: string
  /** Every published slug at run creation, including lazily discovered prompts. */
  prompts: Record<
    string,
    { id: string; version: number; latestVersion: number; model: string }
  >
  overrides: PromptOverrides
}
export const promptRunScopeSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200),
    baseUrl: z.url().optional(),
  })
  .strict()
export type PromptRunScope = z.infer<typeof promptRunScopeSchema>

export function validatePromptOverrides(input: {
  parentRunId?: string
  promptOverrides?: PromptOverrides
  mode?: string
  datasetId?: string
  sourceRunId?: string
  input?: unknown
  traceIds?: string[]
}) {
  if (input.promptOverrides === undefined) return
  if (
    (input.mode !== "connected" && !input.parentRunId) ||
    (!input.datasetId && !input.parentRunId) ||
    input.sourceRunId ||
    input.input !== undefined ||
    input.traceIds?.length
  )
    throw new Error(
      "promptOverrides requires a connected dataset run without sourceRunId, traceIds or single app input."
    )
  return promptOverridesSchema.parse(input.promptOverrides)
}
