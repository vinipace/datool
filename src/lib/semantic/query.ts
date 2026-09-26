import { z } from "zod"

import {
  DEFAULT_SEMANTIC_TIME_ZONE,
  semanticTimeZoneSchema,
} from "@/src/lib/semantic/runtime/time"

/** Query contract for Datool semantic models. */
export const SEMANTIC_CONTRACT_VERSION = "datool-semantic-v2" as const

export const DEFAULT_SEMANTIC_LIMIT = 1_000 as const
export const MAX_SEMANTIC_LIMIT = 5_000 as const
export const DEFAULT_SEMANTIC_OFFSET = 0 as const
export const MAX_SEMANTIC_OFFSET = 1_000_000 as const

export const MAX_SEMANTIC_MEASURES = 50 as const
export const MAX_SEMANTIC_DIMENSIONS = 25 as const
export const MAX_SEMANTIC_TIME_DIMENSIONS = 3 as const
export const MAX_SEMANTIC_SEGMENTS = 25 as const
export const MAX_SEMANTIC_ORDER = 50 as const
export const MAX_SEMANTIC_FILTER_VALUES = 100 as const
export const MAX_SEMANTIC_FILTER_DEPTH = 3 as const
export const MAX_SEMANTIC_FILTER_NODES = 25 as const

export const jsonScalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
])
export type JsonScalar = z.infer<typeof jsonScalarSchema>

/** Semantic member names are model-scoped dotted paths, never SQL identifiers. */
export const semanticMemberNameSchema = z
  .string()
  .min(3, "Member name is required.")
  .regex(
    /^[a-z][A-Za-z0-9_]*(?:\.[a-z][A-Za-z0-9_]*)+$/,
    "Member names must be lowercase-leading dotted names such as `scores.meanScore`."
  )

export type SemanticMemberName = z.infer<typeof semanticMemberNameSchema>

export function semanticModelName(member: SemanticMemberName) {
  return member.slice(0, member.indexOf("."))
}

export const semanticFilterOperatorSchema = z.enum([
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "notIn",
  "set",
  "notSet",
])
export type SemanticFilterOperator = z.infer<
  typeof semanticFilterOperatorSchema
>

const unaryFilterOperators = new Set<SemanticFilterOperator>(["set", "notSet"])

const semanticFilterConditionSchema = z
  .object({
    member: semanticMemberNameSchema,
    path: z
      .array(
        z
          .string()
          .min(1)
          .max(256)
          .refine(
            (value) =>
              !["__proto__", "prototype", "constructor"].includes(value),
            "Unsafe JSON path."
          )
      )
      .min(1)
      .max(19)
      .optional(),
    operator: semanticFilterOperatorSchema,
    values: z
      .array(jsonScalarSchema)
      .min(1, "Filter values must not be empty.")
      .max(MAX_SEMANTIC_FILTER_VALUES)
      .optional(),
  })
  .strict()
  .superRefine(({ operator, values }, context) => {
    if (unaryFilterOperators.has(operator)) {
      if (values !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${operator} filters do not accept values.`,
          path: ["values"],
        })
      }
      return
    }
    if (values === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${operator} filters require at least one value.`,
        path: ["values"],
      })
    }
  })

export type SemanticFilterCondition = z.infer<
  typeof semanticFilterConditionSchema
>
export type SemanticFilter =
  SemanticFilterCondition | { and: SemanticFilter[] } | { or: SemanticFilter[] }

const semanticFilterSchemaInternal: z.ZodType<SemanticFilter> = z.lazy(
  () =>
    z.union([
      semanticFilterConditionSchema,
      z
        .object({
          and: z
            .array(semanticFilterSchemaInternal)
            .min(1, "`and` must contain at least one filter.")
            .max(MAX_SEMANTIC_FILTER_NODES),
        })
        .strict(),
      z
        .object({
          or: z
            .array(semanticFilterSchemaInternal)
            .min(1, "`or` must contain at least one filter.")
            .max(MAX_SEMANTIC_FILTER_NODES),
        })
        .strict(),
    ]) as z.ZodType<SemanticFilter>
)
export const semanticFilterSchema = semanticFilterSchemaInternal

/** Numeric limits on aggregated measures, evaluated after grouping. */
export const semanticMeasureFilterSchema =
  semanticFilterConditionSchema.superRefine((filter, context) => {
    if (
      filter.path ||
      ![
        "gt",
        "gte",
        "lt",
        "lte",
        "equals",
        "notEquals",
        "set",
        "notSet",
      ].includes(filter.operator)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Measure filters require a numeric comparison without a JSON path.",
      })
    }
    if (
      !unaryFilterOperators.has(filter.operator) &&
      (filter.values?.length !== 1 || typeof filter.values[0] !== "number")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Measure comparisons require exactly one finite number.",
        path: ["values"],
      })
    }
  })

export const semanticGranularitySchema = z.enum(["day", "week", "month"])
export type SemanticGranularity = z.infer<typeof semanticGranularitySchema>

export const semanticTimeDimensionQuerySchema = z
  .object({
    dimension: semanticMemberNameSchema,
    dateRange: z.tuple([
      z.string().datetime({ offset: true }),
      z.string().datetime({ offset: true }),
    ]),
    granularity: semanticGranularitySchema.optional(),
  })
  .strict()
  .superRefine(({ dateRange }, context) => {
    if (new Date(dateRange[1]).getTime() <= new Date(dateRange[0]).getTime()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`dateRange` must be a non-empty half-open window.",
        path: ["dateRange", 1],
      })
    }
  })

export type SemanticTimeDimensionQuery = z.infer<
  typeof semanticTimeDimensionQuerySchema
>

export const semanticOrderDirectionSchema = z.enum(["asc", "desc"])
export type SemanticOrderDirection = z.infer<
  typeof semanticOrderDirectionSchema
>
export const semanticOrderSchema = z.tuple([
  semanticMemberNameSchema,
  semanticOrderDirectionSchema,
])
export type SemanticOrder = z.infer<typeof semanticOrderSchema>

const semanticQuerySchemaBase = z
  .object({
    measures: z
      .array(semanticMemberNameSchema)
      .min(1, "At least one measure is required.")
      .max(MAX_SEMANTIC_MEASURES),
    dimensions: z
      .array(semanticMemberNameSchema)
      .max(MAX_SEMANTIC_DIMENSIONS)
      .default([]),
    filters: z
      .array(semanticFilterSchema)
      .max(MAX_SEMANTIC_FILTER_NODES)
      .default([]),
    having: z
      .array(semanticMeasureFilterSchema)
      .max(MAX_SEMANTIC_FILTER_NODES)
      .optional(),
    timeDimensions: z
      .array(semanticTimeDimensionQuerySchema)
      .max(MAX_SEMANTIC_TIME_DIMENSIONS)
      .default([]),
    segments: z
      .array(semanticMemberNameSchema)
      .max(MAX_SEMANTIC_SEGMENTS)
      .default([]),
    order: z.array(semanticOrderSchema).max(MAX_SEMANTIC_ORDER).default([]),
    timezone: semanticTimeZoneSchema.default(DEFAULT_SEMANTIC_TIME_ZONE),
    limit: z
      .number()
      .int("limit must be an integer.")
      .min(1, "limit must be at least 1.")
      .max(MAX_SEMANTIC_LIMIT),
    offset: z
      .number()
      .int("offset must be an integer.")
      .min(DEFAULT_SEMANTIC_OFFSET, "offset must not be negative.")
      .max(MAX_SEMANTIC_OFFSET),
    total: z.boolean().default(false),
  })
  .strict()

/** Parse once so all transports and model executors receive the same defaults. */
export const semanticQuerySchema = semanticQuerySchemaBase
  .extend({
    limit: semanticQuerySchemaBase.shape.limit.default(DEFAULT_SEMANTIC_LIMIT),
    offset: semanticQuerySchemaBase.shape.offset.default(
      DEFAULT_SEMANTIC_OFFSET
    ),
  })
  .superRefine((query, context) => {
    addDuplicateIssues(query.measures, "measures", context)
    addDuplicateIssues(query.dimensions, "dimensions", context)
    addDuplicateIssues(
      query.timeDimensions.map(({ dimension }) => dimension),
      "timeDimensions",
      context
    )
    addDuplicateIssues(query.segments, "segments", context)
    addDuplicateIssues(
      query.order.map(([member]) => member),
      "order",
      context
    )

    const names = [
      ...query.measures,
      ...query.dimensions,
      ...query.timeDimensions.map(({ dimension }) => dimension),
      ...query.segments,
      ...query.order.map(([member]) => member),
      ...collectFilterMembers(query.filters),
      ...(query.having ?? []).map((filter) => filter.member),
    ]
    if (new Set(names.map(semanticModelName)).size > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A query may reference one semantic model only.",
        path: ["measures"],
      })
    }
    if (
      new Set([
        ...query.measures,
        ...(query.having ?? []).map((filter) => filter.member),
      ]).size > MAX_SEMANTIC_MEASURES
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `A query cannot compute more than ${MAX_SEMANTIC_MEASURES} measures, including measure filters.`,
        path: ["having"],
      })
    }
    const stats = inspectFilters(query.filters)
    if (stats.depth > MAX_SEMANTIC_FILTER_DEPTH) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Filter nesting cannot exceed ${MAX_SEMANTIC_FILTER_DEPTH} levels.`,
        path: ["filters"],
      })
    }
    if (stats.nodes > MAX_SEMANTIC_FILTER_NODES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `A query cannot contain more than ${MAX_SEMANTIC_FILTER_NODES} filter nodes.`,
        path: ["filters"],
      })
    }
  })

export type SemanticQueryInput = z.input<typeof semanticQuerySchema>
export type NormalizedSemanticQuery = z.output<typeof semanticQuerySchema>

export type SemanticQueryIssue = Readonly<{
  code: string
  message: string
  path: readonly (string | number)[]
}>

export class SemanticQueryValidationError extends Error {
  readonly code = "INVALID_QUERY" as const
  readonly issues: readonly SemanticQueryIssue[]

  constructor(issues: readonly SemanticQueryIssue[]) {
    super(
      issues.length
        ? `Semantic query validation failed: ${issues[0]!.message}`
        : "Semantic query validation failed."
    )
    this.name = "SemanticQueryValidationError"
    this.issues = issues
  }
}

export function parseSemanticQuery(input: unknown): NormalizedSemanticQuery {
  const parsed = semanticQuerySchema.safeParse(input)
  if (parsed.success) return parsed.data
  throw new SemanticQueryValidationError(
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

function addDuplicateIssues(
  values: readonly string[],
  path: string,
  context: z.RefinementCtx
) {
  const seen = new Set<string>()
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${path} must not contain duplicate members.`,
        path: [path, index],
      })
    }
    seen.add(value)
  }
}

function collectFilterMembers(filters: readonly SemanticFilter[]): string[] {
  const members: string[] = []
  for (const filter of filters) {
    if ("member" in filter) members.push(filter.member)
    else if ("and" in filter) members.push(...collectFilterMembers(filter.and))
    else members.push(...collectFilterMembers(filter.or))
  }
  return members
}

function inspectFilters(filters: readonly SemanticFilter[]) {
  let depth = 0
  let nodes = 0
  function visit(filter: SemanticFilter, currentDepth: number) {
    nodes += 1
    depth = Math.max(depth, currentDepth)
    if ("and" in filter)
      filter.and.forEach((child) => visit(child, currentDepth + 1))
    else if ("or" in filter)
      filter.or.forEach((child) => visit(child, currentDepth + 1))
  }
  filters.forEach((filter) => visit(filter, 1))
  return { depth, nodes }
}
