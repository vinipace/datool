import { z } from "zod"

const path = z
  .array(
    z
      .string()
      .min(1)
      .max(200)
      .refine(
        (key) => !["__proto__", "prototype", "constructor"].includes(key),
        "Unsafe label path."
      )
  )
  .min(1)
  .max(12)

/** Paths address immutable eval target snapshots, never current trace output. */
export const classificationOptionsSchema = z
  .object({
    actualPath: path,
    predictedPath: path,
    positiveClass: z.union([
      z.string().max(1000),
      z.number().finite(),
      z.boolean(),
    ]),
  })
  .strict()

const runs = z.array(z.string().min(1).max(200)).min(1).max(20)
export const comparisonOptionsSchema = z
  .object({
    baselineRunIds: runs,
    candidateRunIds: runs,
    evaluatorVersionId: z.string().min(1).max(200),
    lowerIsBetter: z.boolean().optional(),
  })
  .strict()
  .refine((value) => {
    const all = [...value.baselineRunIds, ...value.candidateRunIds]
    return new Set(all).size === all.length
  }, "Baseline and candidate runs must be unique and disjoint.")
