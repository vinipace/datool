import { z } from "zod"

const sourceId = z.string().min(1).max(1024)
export const scoreImportSchema = z
  .object({
    source: z
      .object({
        provider: sourceId,
        instance: sourceId,
        projectId: sourceId,
        id: sourceId,
      })
      .strict(),
    // Keep the complete adapter record, including fields we cannot interpret yet.
    record: z.json(),
  })
  .strict()

export const importedScoreSchema = z.object({
  name: z.string().min(1).max(200),
  timestamp: z.string().datetime({ offset: true }),
  target: z.discriminatedUnion("type", [
    z.object({ type: z.literal("trace"), id: sourceId }).strict(),
    z.object({ type: z.literal("span"), id: sourceId }).strict(),
    z.object({ type: z.literal("session"), id: sourceId }).strict(),
    z.object({ type: z.literal("evalRun"), id: sourceId }).strict(),
  ]),
  data: z.discriminatedUnion("type", [
    z
      .object({ type: z.literal("numeric"), value: z.number().finite() })
      .strict(),
    z.object({ type: z.literal("boolean"), value: z.boolean() }).strict(),
    z.object({ type: z.literal("categorical"), value: z.string() }).strict(),
    z.object({ type: z.literal("text"), value: z.string() }).strict(),
  ]),
  // Optional stable producer definition. Never infer compatibility from a display name.
  definition: z
    .object({
      id: sourceId,
      version: sourceId,
      min: z.number().finite().optional(),
      max: z.number().finite().optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.min === undefined ||
        value.max === undefined ||
        value.max > value.min,
      "Maximum must exceed minimum."
    )
    .optional(),
  comment: z.string().optional(),
  author: z.json().optional(),
  metadata: z.record(z.string(), z.json()).optional(),
})

export type ScoreImport = z.infer<typeof scoreImportSchema>
export type ImportedScore = z.infer<typeof importedScoreSchema> & {
  source: ScoreImport["source"]
}
export type ScoreImportResult = {
  id: string
  status: "imported" | "unsupported" | "unresolved"
  reason: string | null
  scoreId: string | null
}

export type ScoreImportDetail = ScoreImportResult & {
  payload: ScoreImport
  score: ImportedScore | null
}
