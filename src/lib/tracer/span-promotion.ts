import { z } from "zod"
import type { CreateDatasetItemInput, TraceForEvaluation } from "./contracts"
const jsonValue = z.json()
const jsonObject = z.record(z.string(), jsonValue)

const id = z.string().trim().min(1).max(200)
export const promoteSpansSchema = z
  .object({
    datasetId: id,
    preview: z.boolean().default(true),
    expectedHash: z.string().optional(),
    expectedEvidenceHash: z.string().optional(),
    spans: z
      .array(
        z
          .object({
            traceId: id,
            spanId: id,
            id: id.optional(),
            mappedInput: jsonValue.optional(),
            expectedOutput: jsonValue.optional(),
            copyObservedOutput: z.boolean().default(false),
            metadata: jsonObject.optional(),
          })
          .strict()
      )
      .min(1)
      .max(100),
  })
  .strict()
export type PromoteSpansInput = z.infer<typeof promoteSpansSchema>
export type SpanPromotionResult = {
  preview: boolean
  datasetId: string
  evidenceHash: string
  cases: (CreateDatasetItemInput & {
    sourceSpanEvidence: TraceForEvaluation
    observedOutput: TraceForEvaluation["output"]
  })[]
  created: string[]
}
