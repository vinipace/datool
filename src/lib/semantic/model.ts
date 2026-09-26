import type { SemanticReadTransaction } from "@/src/server/semantic/snapshot"

import type {
  JsonScalar,
  NormalizedSemanticQuery,
  SemanticFilterOperator,
  SemanticGranularity,
  SemanticMemberName,
  SemanticOrder,
} from "@/src/lib/semantic/query"
import {
  MAX_SEMANTIC_LIMIT,
  semanticMemberNameSchema,
} from "@/src/lib/semantic/query"
import type {
  SemanticDataRow,
  SemanticQuality,
} from "@/src/lib/semantic/result"

export const semanticMemberKinds = [
  "measure",
  "dimension",
  "timeDimension",
  "segment",
] as const
export type SemanticMemberKind = (typeof semanticMemberKinds)[number]

export const semanticValueTypes = [
  "number",
  "string",
  "boolean",
  "date",
] as const
export type SemanticValueType = (typeof semanticValueTypes)[number]

export const semanticMeasureAggregations = [
  "sum",
  "count",
  "countDistinct",
  "average",
  "minimum",
  "maximum",
  "percentile",
  "ratio",
] as const
export type SemanticMeasureAggregation =
  (typeof semanticMeasureAggregations)[number]

export type SemanticModelErrorPath = readonly (string | number)[]
export type SemanticModelQueryErrorCode =
  "MODEL_QUERY_INVALID" | "QUERY_TOO_LARGE"

/**
 * Models use this only for deterministic query/capability failures. Database
 * and programming failures remain visible as operational failures instead of
 * being relabelled as a bad user query.
 */
export class SemanticModelQueryError extends Error {
  readonly code: SemanticModelQueryErrorCode
  readonly path: SemanticModelErrorPath

  constructor(
    code: SemanticModelQueryErrorCode,
    message: string,
    path: SemanticModelErrorPath = []
  ) {
    super(message)
    this.name = "SemanticModelQueryError"
    this.code = code
    this.path = path
  }
}

export function isSemanticModelQueryError(
  error: unknown
): error is SemanticModelQueryError {
  return error instanceof SemanticModelQueryError
}

/** Normalize model-owned range/type validation without masking database errors. */
export function throwSemanticModelQueryError(
  error: unknown,
  path: SemanticModelErrorPath = []
): never {
  if (isSemanticModelQueryError(error)) throw error
  if (error instanceof RangeError || error instanceof TypeError) {
    throw new SemanticModelQueryError(
      "MODEL_QUERY_INVALID",
      error.message,
      path
    )
  }
  throw error
}

type SemanticMemberBase = {
  name: SemanticMemberName
  title: string
  description: string
  metricVersion: string
  definition: string
  format?: string
  unit?: string
  basis?: string
  currency?: string
  estimated?: boolean
  limitations?: readonly string[]
  factIdentity?: string
  eventTime?: string
  denominator?: string
  eligiblePopulation?: string
  attribution?: string
  overlap?: string
  requiresDefinition?: boolean
}

export type SemanticMeasureDefinition = SemanticMemberBase & {
  kind: "measure"
  type: "number"
  aggregation: SemanticMeasureAggregation
}

export type SemanticDimensionDefinition = SemanticMemberBase & {
  kind: "dimension"
  type: Exclude<SemanticValueType, "date">
  filterOperators: readonly SemanticFilterOperator[]
  /** A filter-only dimension can narrow facts but cannot become a row grain. */
  groupable?: boolean
  filterValueType?: "json" | "date"
  source?: string
  missingBehavior?: string
  cardinality?: "low" | "high"
  multiplicity?: "one" | "many"
  unavailableReason?: string
}

export type SemanticTimeDimensionDefinition = SemanticMemberBase & {
  kind: "timeDimension"
  type: "date"
  granularities: readonly SemanticGranularity[]
}

export type SemanticSegmentDefinition = SemanticMemberBase & {
  kind: "segment"
  type: "boolean"
}

export type SemanticMemberDefinition =
  | SemanticMeasureDefinition
  | SemanticDimensionDefinition
  | SemanticTimeDimensionDefinition
  | SemanticSegmentDefinition

export type SemanticExecutionContext = Readonly<{
  requestId: string
  snapshot: SemanticReadTransaction
  asOf: Date
}>

export type SemanticModelExecutionResult = Readonly<{
  /** SQL-ordered page; models must never return the complete grouped relation. */
  rows: readonly SemanticDataRow[]
  quality: SemanticQuality
  paged: true
  total?: number
}>

export type SemanticSourcePresentation = Readonly<{
  title: string
  description: string
  grain: string
  visibility: "primary" | "legacy"
  order?: number
  replacement?: string
  unavailable?: readonly Readonly<{ title: string; reason: string }>[]
}>

export type SemanticModel = Readonly<{
  source?: SemanticSourcePresentation
  name: string
  version: string
  members: readonly SemanticMemberDefinition[]
  defaultMeasures?: readonly SemanticMemberName[]
  maxWindowDays?: number
  maxLimit?: number
  defaultOrder?: readonly SemanticOrder[]
  execute: (
    query: NormalizedSemanticQuery,
    context: SemanticExecutionContext
  ) => Promise<SemanticModelExecutionResult>
}>

export type SemanticModelMemberValue = JsonScalar

/** Validate and freeze a static model declaration at catalog construction time. */
export function defineSemanticModel<const Model extends SemanticModel>(
  model: Model
): Readonly<Model> {
  if (!/^[a-z][A-Za-z0-9_]*$/.test(model.name)) {
    throw new TypeError(
      "Semantic model names must be lowercase-leading alphanumeric identifiers."
    )
  }
  if (!model.version.trim())
    throw new TypeError("Semantic model version is required.")
  if (model.members.length === 0)
    throw new TypeError(`Semantic model '${model.name}' must define members.`)

  const names = new Set<string>()
  const byName = new Map<string, SemanticMemberDefinition>()
  for (const member of model.members) {
    if (!semanticMemberNameSchema.safeParse(member.name).success) {
      throw new TypeError(
        `Member '${member.name}' must be a valid namespaced semantic member name.`
      )
    }
    if (!member.name.startsWith(`${model.name}.`)) {
      throw new TypeError(
        `Member '${member.name}' does not belong to model '${model.name}'.`
      )
    }
    if (names.has(member.name))
      throw new TypeError(`Member '${member.name}' is defined more than once.`)
    names.add(member.name)
    byName.set(member.name, member)
    if (!member.title.trim())
      throw new TypeError(`Member '${member.name}' must have a title.`)
    if (!member.description.trim())
      throw new TypeError(`Member '${member.name}' must have a description.`)
    if (!member.metricVersion.trim())
      throw new TypeError(
        `Member '${member.name}' must declare a metric version.`
      )
    if (!member.definition.trim())
      throw new TypeError(`Member '${member.name}' must declare a definition.`)
  }

  if (
    model.maxWindowDays !== undefined &&
    (!Number.isInteger(model.maxWindowDays) || model.maxWindowDays <= 0)
  ) {
    throw new TypeError("maxWindowDays must be a positive integer.")
  }
  if (
    model.maxLimit !== undefined &&
    (!Number.isInteger(model.maxLimit) ||
      model.maxLimit <= 0 ||
      model.maxLimit > MAX_SEMANTIC_LIMIT)
  ) {
    throw new TypeError(
      `maxLimit must be a positive integer no greater than ${MAX_SEMANTIC_LIMIT}.`
    )
  }
  for (const member of model.defaultMeasures ?? []) {
    if (byName.get(member)?.kind !== "measure") {
      throw new TypeError(
        `Default measure '${member}' must be a measure in model '${model.name}'.`
      )
    }
  }
  for (const [member] of model.defaultOrder ?? []) {
    if (!byName.has(member)) {
      throw new TypeError(
        `Default order member '${member}' is not defined in model '${model.name}'.`
      )
    }
  }

  return Object.freeze({
    ...model,
    ...(model.source ? { source: Object.freeze({ ...model.source }) } : {}),
    ...(model.defaultMeasures
      ? { defaultMeasures: Object.freeze([...model.defaultMeasures]) }
      : {}),
    members: Object.freeze(
      model.members.map((member) =>
        Object.freeze({
          ...member,
          ...(member.limitations
            ? { limitations: Object.freeze([...member.limitations]) }
            : {}),
          ...("filterOperators" in member
            ? { filterOperators: Object.freeze([...member.filterOperators]) }
            : {}),
          ...("granularities" in member
            ? { granularities: Object.freeze([...member.granularities]) }
            : {}),
        })
      )
    ),
    ...(model.defaultOrder
      ? {
          defaultOrder: Object.freeze(
            model.defaultOrder.map(
              ([member, direction]) => [member, direction] as SemanticOrder
            )
          ),
        }
      : {}),
  }) as Readonly<Model>
}
