import { z } from "zod"

const id = z.string().trim().min(1).max(200)
const base = {
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).default(""),
}
export const humanScoreInputSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        ...base,
        type: z.literal("numeric"),
        min: z.number().finite().default(0),
        max: z.number().finite().default(1),
        step: z.number().finite().positive().default(0.01),
      })
      .strict(),
    z
      .object({
        ...base,
        type: z.literal("categorical"),
        multiple: z.boolean().default(false),
        options: z
          .array(
            z
              .object({ value: id, label: z.string().trim().min(1).max(120) })
              .strict()
          )
          .min(2)
          .max(50),
      })
      .strict(),
    z
      .object({
        ...base,
        type: z.literal("text"),
        maxLength: z.number().int().min(1).max(16000).default(4000),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if (
      value.type === "numeric" &&
      (value.max <= value.min || value.step > value.max - value.min)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Maximum must exceed minimum, with a step no larger than the range.",
      })
    if (
      value.type === "categorical" &&
      (new Set(value.options.map((o) => o.value)).size !==
        value.options.length ||
        new Set(value.options.map((o) => o.label.toLowerCase())).size !==
          value.options.length)
    )
      ctx.addIssue({
        code: "custom",
        message: "Option values and labels must be unique.",
      })
  })
export type HumanScoreInput = z.input<typeof humanScoreInputSchema>
export type HumanScore = z.output<typeof humanScoreInputSchema> & {
  id: string
  revision: number
  archived: boolean
  createdAt: string
  updatedAt: string
}
export type HumanScoreValue = number | string | string[]
export const humanScoreUpdateSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    score: humanScoreInputSchema,
  })
  .strict()
export const humanScoreCollectionInputSchema = z
  .object({
    ...base,
    scoreIds: z
      .array(id)
      .min(1)
      .max(30)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Select each Human Score once."
      ),
  })
  .strict()
export type HumanScoreCollectionInput = z.input<
  typeof humanScoreCollectionInputSchema
>
export type HumanScoreCollection = z.output<
  typeof humanScoreCollectionInputSchema
> & {
  id: string
  revision: number
  archived: boolean
  createdAt: string
  updatedAt: string
}
export const humanScoreCollectionUpdateSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    collection: humanScoreCollectionInputSchema,
  })
  .strict()
export type HumanScoreLibrary = {
  scores: HumanScore[]
  collections: HumanScoreCollection[]
}
export type HumanScoreCollectionSnapshot = HumanScoreCollection & {
  scores: HumanScore[]
}

export function isHumanScoreValue(
  definition: HumanScore,
  value: unknown
): value is HumanScoreValue {
  if (definition.type === "numeric")
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= definition.min &&
      value <= definition.max
    )
  if (definition.type === "text")
    return (
      typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= definition.maxLength
    )
  const validOption = (item: unknown) =>
    typeof item === "string" &&
    definition.options.some((option) => option.value === item)
  return definition.multiple
    ? Array.isArray(value) &&
        value.length > 0 &&
        new Set(value).size === value.length &&
        value.every(validOption)
    : validOption(value)
}
export function humanScoreValueLabel(
  definition: HumanScore,
  value: HumanScoreValue
) {
  return definition.type === "categorical"
    ? (Array.isArray(value) ? value : [value])
        .map(
          (item) =>
            definition.options.find((option) => option.value === item)?.label ??
            String(item)
        )
        .join(", ")
    : String(value)
}

export function humanScoreTypeLabel(score: HumanScore) {
  return score.type === "numeric"
    ? "Numeric"
    : score.type === "text"
      ? "Free text"
      : score.multiple
        ? "Multiple choice"
        : "Single choice"
}
