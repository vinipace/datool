import { z } from "zod"
import type { ReviewProvenance } from "./review-provenance"
import type { TraceSummary } from "./contracts"
import { reviewAnnotationsSchema, type ReviewAnnotation } from "./review-annotations"
import type {
  HumanScore,
  HumanScoreValue,
  HumanScoreCollectionSnapshot,
} from "./human-scores"

const id = z.string().trim().min(1).max(200)
const reviewerIds = z
  .array(id)
  .max(50)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "Reviewer IDs must be unique."
  )
export const DEFAULT_REVIEW_NAME = "Untitled Review"
export const reviewSessionInputSchema = z
  .object({
    idempotencyKey: z.uuid().optional(),
    name: z
      .string()
      .trim()
      .max(200)
      .default(DEFAULT_REVIEW_NAME)
      .transform((name) => name || DEFAULT_REVIEW_NAME),
    prompt: z.string().trim().max(16000).default(""),
    assigneeUserId: id.nullable().default(null),
    reviewerUserIds: reviewerIds.optional(),
    collectionId: id.nullable().default(null),
    traceIds: z
      .array(id)
      .min(1)
      .max(500)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Trace IDs must be unique."
      ),
  })
  .strict()
  .refine(
    (value) => value.reviewerUserIds === undefined || !value.assigneeUserId,
    "Provide reviewerUserIds or assigneeUserId, not both."
  )
export const reviewSessionUpdateSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    collectionId: id.nullable().optional(),
    name: z.string().trim().max(200).optional(),
    prompt: z.string().trim().max(16000).optional(),
    assigneeUserId: id.nullable().optional(),
    reviewerUserIds: reviewerIds.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.reviewerUserIds === undefined || value.assigneeUserId === undefined,
    "Provide reviewerUserIds or assigneeUserId, not both."
  )
export const reviewScoreInputSchema = z
  .object({
    humanScoreId: id,
    humanScoreRevision: z.number().int().positive(),
    value: z
      .union([z.number().finite(), z.string().max(16000), z.array(id).max(50)])
      .nullable(),
    comment: z.string().max(4000).default(""),
  })
  .strict()
export const recordReviewSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    scores: z.array(reviewScoreInputSchema).max(30).optional(),
    notes: z.string().max(16000).optional(),
    annotations: reviewAnnotationsSchema.optional(),
    agent: z.object({
      name: z.string().trim().min(1).max(200).optional(),
      model: z.string().trim().min(1).max(200).optional(),
    }).strict().optional(),
  })
  .strict()
  .refine(
    (value) => value.scores !== undefined || value.notes !== undefined || value.annotations !== undefined,
    "Provide scores, notes or annotations to save."
  )

export type CreateReviewSession = z.input<typeof reviewSessionInputSchema>
export const reviewSelectionSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    action: z.enum(["remove", "skip", "restore"]),
    items: z
      .array(
        z
          .object({
            id,
            expectedRevision: z.number().int().nonnegative(),
          })
          .strict()
      )
      .min(1)
      .max(500)
      .refine(
        (items) => new Set(items.map((item) => item.id)).size === items.length,
        "Review item IDs must be unique."
      ),
  })
  .strict()
export type ReviewSelection = z.infer<typeof reviewSelectionSchema>
export type UpdateReviewSession = z.infer<typeof reviewSessionUpdateSchema>
export type RecordReview = z.input<typeof recordReviewSchema>
export type ReviewMember = {
  id: string
  name: string
  email: string
  image: string | null
}
export type ReviewReviewer = Pick<ReviewMember, "id" | "name" | "image">
export type ReviewSession = {
  id: string
  number: number
  name: string
  prompt: string
  assigneeUserId: string | null
  assigneeName: string | null
  reviewers: ReviewReviewer[]
  createdBy: string | null
  createdAt: string
  updatedAt: string
  revision: number
  collectionId: string | null
  collection: HumanScoreCollectionSnapshot | null
  traceCount: number
  /** Total score-complete items, including AI; not a human verification count. */
  reviewedCount: number
  label?: "AI-labelled" | "Human-reviewed" | "Unreviewed"
  humanReviewedCount?: number
  aiReviewedCount?: number
  aiLabelledCount?: number
  skippedCount: number
  status: "pending" | "in_progress" | "completed"
}
export type ReviewItem = {
  id: string
  sessionId: string
  traceId: string
  traceName: string
  ordinal: number
  notes: string
  notesProvenance?: ReviewProvenance | null
  lastSubmission?: ReviewProvenance | null
  label?: "AI-labelled" | "Human-reviewed" | "Unreviewed" | "Unknown provenance"
  completionKind?: "ai" | "human" | null
  humanVerified?: boolean
  revision: number
  reviewedAt: string | null
  skippedAt: string | null
  reviewedBy: string | null
}
export type ReviewScore = {
  id: string
  itemId: string
  traceId: string
  scorerId: string | null
  scorerRevision: number | null
  name: string
  humanScoreId: string
  definition: HumanScore
  value: HumanScoreValue | null
  comment: string
  reviewerId: string | null
  reviewerName: string | null
  reviewerImage: string | null
  source: "human" | "mcp" | "api"
  provenance?: ReviewProvenance
  editedBy?: ReviewProvenance
  updatedAt: string
}
export type ReviewSessionDetail = ReviewSession & { items: ReviewItem[] }
export type ReviewSessionTable = ReviewSessionDetail & {
  traces: TraceSummary[]
  scoreColumns: Pick<HumanScore, "id" | "name" | "type">[]
  scores: {
    itemId: string
    humanScoreId: string
    value: HumanScoreValue | null
    valueLabel: string | null
    provenance?: ReviewProvenance
  }[]
}
export type ReviewItemDetail = ReviewItem & {
  annotations: ReviewAnnotation[]
  definitions: HumanScore[]
  scores: ReviewScore[]
  nextItemId: string | null
  previousItemId: string | null
}
export type ReviewOptions = {
  members: ReviewMember[]
  currentUserId: string | null
}
