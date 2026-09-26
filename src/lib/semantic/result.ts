import { z } from "zod"

import {
  SEMANTIC_CONTRACT_VERSION,
  jsonScalarSchema,
  semanticMemberNameSchema,
  semanticQuerySchema,
  type NormalizedSemanticQuery,
} from "@/src/lib/semantic/query"
import {
  semanticMeasureAggregations,
  semanticMemberKinds,
  semanticValueTypes,
} from "@/src/lib/semantic/model"

export const semanticDataRowSchema = z.record(
  semanticMemberNameSchema,
  jsonScalarSchema
)
export type SemanticDataRow = z.infer<typeof semanticDataRowSchema>

export const semanticMemberAnnotationSchema = z
  .object({
    name: semanticMemberNameSchema,
    kind: z.enum(semanticMemberKinds),
    type: z.enum(semanticValueTypes),
    title: z.string().min(1),
    description: z.string().min(1),
    format: z.string().min(1).optional(),
    unit: z.string().min(1).optional(),
    basis: z.string().min(1).optional(),
    factIdentity: z.string().optional(),
    eventTime: z.string().optional(),
    denominator: z.string().optional(),
    eligiblePopulation: z.string().optional(),
    attribution: z.string().optional(),
    overlap: z.string().optional(),
    currency: z.string().min(1).optional(),
    estimated: z.boolean().optional(),
    metricVersion: z.string().min(1),
    definition: z.string().min(1),
    limitations: z.array(z.string().min(1)).default([]),
    aggregation: z.enum(semanticMeasureAggregations).optional(),
  })
  .strict()
export type SemanticMemberAnnotation = z.infer<
  typeof semanticMemberAnnotationSchema
>

export const semanticAnnotationSchema = z
  .object({
    measures: z
      .record(semanticMemberNameSchema, semanticMemberAnnotationSchema)
      .default({}),
    dimensions: z
      .record(semanticMemberNameSchema, semanticMemberAnnotationSchema)
      .default({}),
    timeDimensions: z
      .record(semanticMemberNameSchema, semanticMemberAnnotationSchema)
      .default({}),
    segments: z
      .record(semanticMemberNameSchema, semanticMemberAnnotationSchema)
      .default({}),
  })
  .strict()
export type SemanticAnnotation = z.infer<typeof semanticAnnotationSchema>

export const semanticQualitySchema = z
  .object({
    status: z.enum(["complete", "partial"]),
    warnings: z.array(z.string().min(1)).default([]),
    limitations: z.array(z.string().min(1)).default([]),
  })
  .strict()
export type SemanticQuality = z.infer<typeof semanticQualitySchema>

export const semanticPageSchema = z
  .object({
    limit: z.number().int().min(1),
    offset: z.number().int().min(0),
    total: z.number().int().nonnegative().optional(),
  })
  .strict()
export type SemanticPage = z.infer<typeof semanticPageSchema>

export const semanticMetaSchema = z
  .object({
    contractVersion: z.literal(SEMANTIC_CONTRACT_VERSION),
    requestId: z.string().min(1),
    generatedAt: z.string().datetime({ offset: true }),
    asOf: z.string().datetime({ offset: true }),
    metricVersions: z.record(z.string().min(1), z.string().min(1)),
    quality: semanticQualitySchema,
    page: semanticPageSchema,
  })
  .strict()
export type SemanticMeta = z.infer<typeof semanticMetaSchema>

export const semanticResultSchema = z
  .object({
    query: semanticQuerySchema,
    data: z.array(semanticDataRowSchema),
    annotation: semanticAnnotationSchema,
    meta: semanticMetaSchema,
  })
  .strict()
  .superRefine((result, context) => {
    const annotations = annotationEntries(result.annotation)
    const requested = new Set([
      ...result.query.measures,
      ...result.query.dimensions,
      ...result.query.timeDimensions.map(({ dimension }) => dimension),
      ...result.query.segments,
    ])
    const rowMembers = new Set([
      ...result.query.measures,
      ...result.query.dimensions,
      ...result.query.timeDimensions.map(({ dimension }) => dimension),
    ])
    for (const member of requested) {
      if (!annotations.has(member)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Missing annotation for requested member '${member}'.`,
          path: ["annotation"],
        })
      }
    }
    for (const [rowIndex, row] of result.data.entries()) {
      for (const member of rowMembers) {
        if (!(member in row)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Row is missing requested member '${member}'.`,
            path: ["data", rowIndex, member],
          })
        }
      }
      for (const member of Object.keys(row)) {
        const annotation = annotations.get(member)
        if (!annotation) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Row contains member '${member}' without an annotation.`,
            path: ["data", rowIndex, member],
          })
        }
        if (!rowMembers.has(member)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Row contains unrequested member '${member}'.`,
            path: ["data", rowIndex, member],
          })
        }
        const value = row[member]
        if (annotation && value !== null) {
          const valid =
            annotation.type === "number"
              ? typeof value === "number"
              : annotation.type === "boolean"
                ? typeof value === "boolean"
                : typeof value === "string"
          if (!valid) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Row value for '${member}' does not match annotation type '${annotation.type}'.`,
              path: ["data", rowIndex, member],
            })
          }
        }
      }
    }
    for (const [member, annotation] of annotations) {
      if (annotation.name !== member) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Annotation key '${member}' does not match its name.`,
          path: ["annotation", member, "name"],
        })
      }
      if (
        annotation.kind === "measure" &&
        annotation.aggregation === undefined
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Measure annotation '${member}' must declare an aggregation.`,
          path: ["annotation", "measures", member],
        })
      }
      if (
        annotation.kind !== "measure" &&
        annotation.aggregation !== undefined
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Only measures may declare aggregation.`,
          path: ["annotation", member],
        })
      }
    }
  })

export type SemanticResult = z.infer<typeof semanticResultSchema>
export type SemanticResultIssue = Readonly<{
  code: string
  message: string
  path: readonly (string | number)[]
}>

export class SemanticResultValidationError extends Error {
  readonly code = "INVALID_RESULT" as const
  readonly issues: readonly SemanticResultIssue[]

  constructor(issues: readonly SemanticResultIssue[]) {
    super(
      issues.length
        ? `Semantic result validation failed: ${issues[0]!.message}`
        : "Semantic result validation failed."
    )
    this.name = "SemanticResultValidationError"
    this.issues = issues
  }
}

export function parseSemanticResult(input: unknown): SemanticResult {
  const parsed = semanticResultSchema.safeParse(input)
  if (parsed.success) return parsed.data
  throw new SemanticResultValidationError(
    parsed.error.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.path.filter(
        (segment): segment is string | number =>
          typeof segment === "string" || typeof segment === "number"
      ),
    }))
  )
}

function annotationEntries(annotation: SemanticAnnotation) {
  const entries = new Map<string, SemanticMemberAnnotation>()
  for (const group of [
    annotation.measures,
    annotation.dimensions,
    annotation.timeDimensions,
    annotation.segments,
  ]) {
    for (const [member, value] of Object.entries(group))
      entries.set(member, value)
  }
  return entries
}

export type SemanticResultQuery = NormalizedSemanticQuery
