import { planSnapshotQueries } from "./batch-plan"
import {
  ReadBudgetError,
  READ_BATCH_DEADLINE_MS,
  READ_MAX_BYTES,
} from "./read-budget"
import {
  MAX_SEMANTIC_LIMIT,
  parseSemanticQuery,
  semanticModelName,
  type NormalizedSemanticQuery,
  type SemanticFilter,
  type SemanticMemberName,
  type SemanticOrder,
} from "@/src/lib/semantic/query"
import {
  parseSemanticResult,
  semanticDataRowSchema,
  semanticQualitySchema,
  type SemanticMemberAnnotation,
  type SemanticQuality,
  type SemanticResult,
} from "@/src/lib/semantic/result"
import type { SemanticCatalog } from "@/src/lib/semantic/catalog"
import {
  isSemanticModelQueryError,
  type SemanticMemberDefinition,
  type SemanticMemberKind,
  type SemanticModel,
  type SemanticModelExecutionResult,
} from "@/src/lib/semantic/model"
import { parseSemanticWindow } from "@/src/lib/semantic/runtime/time"
import type { SemanticSnapshotRunner } from "@/src/server/semantic/snapshot"

export type SemanticExecutionErrorCode =
  | "INVALID_EXECUTION_OPTIONS"
  | "MODEL_NOT_FOUND"
  | "MEMBER_NOT_FOUND"
  | "MEMBER_KIND_UNSUPPORTED"
  | "FILTER_OPERATOR_UNSUPPORTED"
  | "GRANULARITY_UNSUPPORTED"
  | "MEMBER_NOT_GROUPABLE"
  | "ORDER_MEMBER_NOT_REQUESTED"
  | "MODEL_LIMIT_EXCEEDED"
  | "MODEL_WINDOW_EXCEEDED"
  | "MODEL_QUERY_INVALID"
  | "QUERY_TOO_LARGE"
  | "INVALID_MODEL_RESULT"
  | "INVALID_SNAPSHOT"

export type SemanticExecutionPath = readonly (string | number)[]

/** Stable error shape for all expected semantic query/capability failures. */
export class SemanticExecutionError extends Error {
  readonly code: SemanticExecutionErrorCode
  readonly path: SemanticExecutionPath

  constructor(
    code: SemanticExecutionErrorCode,
    message: string,
    path: SemanticExecutionPath = []
  ) {
    super(message)
    this.name = "SemanticExecutionError"
    this.code = code
    this.path = path
  }
}

export type SemanticExecutionOptions = Readonly<{
  catalog: SemanticCatalog
  requestId: string
  snapshotRunner: SemanticSnapshotRunner
  now?: () => Date
}>

/**
 * Execute a bounded query against exactly one static model and one database
 * snapshot. Models return raw grouped rows; ordering, pagination, metadata,
 * and contract validation remain central so dashboards behave consistently.
 */
/** Validate a saved analytical query without reading facts. */
export function validateSemanticQuery(
  input: unknown,
  catalog: SemanticCatalog
) {
  const query = parseSemanticQuery(input)
  const model = catalog.getModel(semanticModelName(query.measures[0]!))
  if (!model)
    throw new SemanticExecutionError(
      "MODEL_NOT_FOUND",
      "Semantic model is not registered."
    )
  resolveAndValidateQuery(query, model, catalog)
  validateModelBounds(query, model)
  return query
}

export async function executeSemanticQuery(
  input: unknown,
  options: SemanticExecutionOptions
): Promise<SemanticResult> {
  const query = parseSemanticQuery(input)
  const execution = validateExecutionOptions(options)
  const modelName = semanticModelName(query.measures[0]!)
  const model = execution.catalog.getModel(modelName)
  if (!model) {
    throw new SemanticExecutionError(
      "MODEL_NOT_FOUND",
      `Semantic model '${modelName}' is not registered.`,
      ["measures", 0]
    )
  }

  const resolved = resolveAndValidateQuery(query, model, execution.catalog)
  validateModelBounds(query, model)
  const effectiveQuery = freezeQuery({
    ...query,
    order: [...resolveOrder(query, model, resolved.rowMembers)],
  })
  // Compute filter-only measures without exposing extra columns to consumers.
  const measuredQuery = effectiveQuery.having?.length
    ? freezeQuery({
        ...effectiveQuery,
        measures: [
          ...new Set([
            ...effectiveQuery.measures,
            ...effectiveQuery.having.map((filter) => filter.member),
          ]),
        ],
      })
    : effectiveQuery
  const hiddenMeasures = new Set(
    measuredQuery.measures.filter((member) => !query.measures.includes(member))
  )

  return execution.snapshotRunner(async (snapshot, asOf) => {
    const snapshotInstant = parseSnapshotInstant(asOf)
    let raw: SemanticModelExecutionResult
    try {
      raw = await model.execute(measuredQuery, {
        asOf: new Date(snapshotInstant.getTime()),
        requestId: execution.requestId,
        snapshot,
      })
    } catch (error) {
      if (isSemanticModelQueryError(error)) {
        throw new SemanticExecutionError(
          error.code,
          `Semantic model '${model.name}' rejected the query: ${error.message}`,
          error.path.length ? error.path : ["model", model.name]
        )
      }
      throw error
    }

    const result = validateModelResult(raw)
    const page = hiddenMeasures.size
      ? result.rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).filter(
              ([member]) => !hiddenMeasures.has(member)
            )
          )
        )
      : result.rows
    if (
      raw.paged !== true ||
      page.length > effectiveQuery.limit ||
      (effectiveQuery.total &&
        (!Number.isSafeInteger(raw.total) || raw.total! < 0))
    )
      throw new SemanticExecutionError(
        "INVALID_MODEL_RESULT",
        "Models must return a bounded SQL page and requested total."
      )
    const generatedAt = parseGeneratedAt(execution.now())
    return parseSemanticResult({
      annotation: buildAnnotations(resolved),
      data: page,
      meta: {
        asOf: snapshotInstant.toISOString(),
        contractVersion: "datool-semantic-v2" as const,
        generatedAt: generatedAt.toISOString(),
        metricVersions: { [model.name]: model.version },
        page: {
          limit: effectiveQuery.limit,
          offset: effectiveQuery.offset,
          ...(effectiveQuery.total ? { total: raw.total } : {}),
        },
        quality: cloneQuality(result.quality),
        requestId: execution.requestId,
      },
      query: effectiveQuery,
    })
  })
}

/** Execute a bounded batch against one pinned read transaction, not merely one timestamp. */
export async function executeSemanticBatch(
  input: unknown,
  options: SemanticExecutionOptions
): Promise<SemanticResult[]> {
  if (
    !input ||
    typeof input !== "object" ||
    !("queries" in input) ||
    Object.keys(input).length !== 1 ||
    !Array.isArray(input.queries) ||
    input.queries.length < 1 ||
    input.queries.length > 40
  ) {
    throw new SemanticExecutionError(
      "MODEL_QUERY_INVALID",
      "A batch requires 1–40 semantic queries."
    )
  }
  const queries = input.queries.map((query) =>
    validateSemanticQuery(query, options.catalog)
  )
  const execution = validateExecutionOptions(options)
  return execution.snapshotRunner(async (snapshot, asOf) => {
    planSnapshotQueries(snapshot, queries)
    const results: SemanticResult[] = []
    // Sequential statements on the same connection keep the transaction bounded and deterministic.
    const deadline = Date.now() + READ_BATCH_DEADLINE_MS
    let bytes = 0
    const completed = new Map<string, SemanticResult>()
    // Fuse matching scalar measures. Logs and eval quality also permit daily
    // series with identical time ordering and measure-independent quality.
    // Other grouped/top-N panels retain their SQL ordering and page boundaries.
    const fusionKey = (query: NormalizedSemanticQuery) => {
      const model = semanticModelName(query.measures[0]!)
      const timeSeries = query.timeDimensions.some((t) => t.granularity)
      const fuseDaily =
        ["logs", "evalQuality", "evalResults"].includes(model) &&
        timeSeries &&
        query.order.length > 0 &&
        query.order.every(([member]) =>
          query.timeDimensions.some(
            (t) => t.dimension === member && t.granularity
          )
        )
      if (
        ![
          "traces",
          "logs",
          "spans",
          "agents",
          "workflows",
          "evalQuality",
          "evalResults",
        ].includes(model) ||
        query.dimensions.length ||
        query.offset ||
        query.having?.length ||
        (timeSeries && !fuseDaily)
      )
        return JSON.stringify(query)
      const { measures, order, having, ...population } = query
      const costQuality =
        model !== "logs" && measures.some((m) => /cost/i.test(m))
      return JSON.stringify({
        ...population,
        measures: [model, costQuality],
        having: having ?? [],
        order: fuseDaily ? order : [],
      })
    }
    const groups = new Map<string, NormalizedSemanticQuery[]>()
    for (const query of queries) {
      const key = fusionKey(query)
      groups.set(key, [...(groups.get(key) ?? []), query])
    }

    for (const query of queries) {
      if (Date.now() >= deadline)
        throw new ReadBudgetError(
          "READ_TIMEOUT",
          "The dashboard exceeded its read deadline."
        )
      const key = JSON.stringify(query)
      let result = completed.get(key)
      if (!result) {
        const group = groups.get(fusionKey(query))!
        const measures = [...new Set(group.flatMap((item) => item.measures))]
        if (
          group.length > 1 &&
          measures.length > query.measures.length &&
          measures.length <= 50
        ) {
          const combined = await executeSemanticQuery(
            {
              ...query,
              measures,
              order: query.timeDimensions.some((t) => t.granularity)
                ? query.order
                : [],
            },
            {
              ...options,
              snapshotRunner: (callback) => callback(snapshot, asOf),
            }
          )
          const model = options.catalog.getModel(
            semanticModelName(query.measures[0]!)
          )!
          for (const member of group) {
            const projected = await executeSemanticQuery(member, {
              ...options,
              catalog: {
                ...options.catalog,
                getModel: (name) =>
                  name !== model.name
                    ? options.catalog.getModel(name)
                    : {
                        ...model,
                        execute: async () => ({
                          rows: combined.data.map((row) =>
                            Object.fromEntries(
                              Object.entries(row).filter(
                                ([key]) =>
                                  !measures.includes(key) ||
                                  member.measures.includes(key)
                              )
                            )
                          ),
                          paged: true,
                          ...(member.total
                            ? { total: combined.meta.page.total }
                            : {}),
                          quality: combined.meta.quality,
                        }),
                      },
              },
              snapshotRunner: (callback) => callback(snapshot, asOf),
            })
            completed.set(JSON.stringify(member), projected)
          }
          result = completed.get(key)!
        } else {
          result = await executeSemanticQuery(query, {
            ...options,
            snapshotRunner: (callback) => callback(snapshot, asOf),
          })
        }
        completed.set(key, result)
      }
      bytes += Buffer.byteLength(JSON.stringify(result))
      if (bytes > READ_MAX_BYTES)
        throw new ReadBudgetError(
          "READ_RESULT_TOO_LARGE",
          "The dashboard response exceeds 8 MiB. Request fewer widgets or rows."
        )
      results.push(result)
    }
    return results
  })
}

type ValidExecutionOptions = Required<SemanticExecutionOptions>

function validateExecutionOptions(
  options: SemanticExecutionOptions
): ValidExecutionOptions {
  if (!options || typeof options !== "object") {
    throw new SemanticExecutionError(
      "INVALID_EXECUTION_OPTIONS",
      "Semantic execution options are required."
    )
  }
  if (
    !options.catalog ||
    typeof options.catalog.getModel !== "function" ||
    typeof options.catalog.getMember !== "function"
  ) {
    throw new SemanticExecutionError(
      "INVALID_EXECUTION_OPTIONS",
      "A semantic catalog is required.",
      ["catalog"]
    )
  }
  if (typeof options.requestId !== "string" || !options.requestId.trim()) {
    throw new SemanticExecutionError(
      "INVALID_EXECUTION_OPTIONS",
      "A non-empty requestId is required.",
      ["requestId"]
    )
  }
  if (typeof options.snapshotRunner !== "function") {
    throw new SemanticExecutionError(
      "INVALID_EXECUTION_OPTIONS",
      "A semantic snapshot runner is required.",
      ["snapshotRunner"]
    )
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new SemanticExecutionError(
      "INVALID_EXECUTION_OPTIONS",
      "now must be a function.",
      ["now"]
    )
  }
  return {
    catalog: options.catalog,
    now: options.now ?? (() => new Date()),
    requestId: options.requestId,
    snapshotRunner: options.snapshotRunner,
  }
}

type ResolvedQuery = Readonly<{
  measures: readonly SemanticMemberDefinition[]
  dimensions: readonly SemanticMemberDefinition[]
  timeDimensions: readonly SemanticMemberDefinition[]
  segments: readonly SemanticMemberDefinition[]
  rowMembers: readonly SemanticMemberName[]
}>

function resolveAndValidateQuery(
  query: NormalizedSemanticQuery,
  model: SemanticModel,
  catalog: SemanticCatalog
): ResolvedQuery {
  const resolve = (
    name: SemanticMemberName,
    path: SemanticExecutionPath
  ): SemanticMemberDefinition => {
    const definition = catalog.getMember(name)
    if (!definition || semanticModelName(name) !== model.name) {
      throw new SemanticExecutionError(
        "MEMBER_NOT_FOUND",
        `Semantic member '${name}' is not available.`,
        path
      )
    }
    return definition
  }

  const measures = query.measures.map((member, index) => {
    const definition = resolve(member, ["measures", index])
    requireKind(definition, "measure", ["measures", index])
    return definition
  })
  const dimensions = query.dimensions.map((member, index) => {
    const definition = resolve(member, ["dimensions", index])
    requireKind(definition, "dimension", ["dimensions", index])
    if (definition.groupable === false) {
      throw new SemanticExecutionError(
        "MEMBER_NOT_GROUPABLE",
        `Semantic dimension '${member}' is filter-only.`,
        ["dimensions", index]
      )
    }
    return definition
  })
  const timeDimensions = query.timeDimensions.map((entry, index) => {
    const definition = resolve(entry.dimension, [
      "timeDimensions",
      index,
      "dimension",
    ])
    requireKind(definition, "timeDimension", [
      "timeDimensions",
      index,
      "dimension",
    ])
    if (
      entry.granularity !== undefined &&
      !definition.granularities.includes(entry.granularity)
    ) {
      throw new SemanticExecutionError(
        "GRANULARITY_UNSUPPORTED",
        `Granularity '${entry.granularity}' is not supported by '${entry.dimension}'.`,
        ["timeDimensions", index, "granularity"]
      )
    }
    return definition
  })
  const segments = query.segments.map((member, index) => {
    const definition = resolve(member, ["segments", index])
    requireKind(definition, "segment", ["segments", index])
    return definition
  })

  for (const [index, [member]] of query.order.entries()) {
    const definition = resolve(member, ["order", index, 0])
    if (definition.kind === "segment") {
      throw new SemanticExecutionError(
        "MEMBER_KIND_UNSUPPORTED",
        `Segment '${member}' cannot be used for ordering.`,
        ["order", index, 0]
      )
    }
  }
  validateFilters(query.filters, resolve)
  query.having?.forEach((filter, index) => {
    const path = ["having", index, "member"]
    const definition = resolve(filter.member, path)
    requireKind(definition, "measure", path)
  })

  const rowMembers = Object.freeze([
    ...query.measures,
    ...query.dimensions,
    ...query.timeDimensions.map(({ dimension }) => dimension),
  ])
  const requested = new Set(rowMembers)
  for (const [index, [member]] of query.order.entries()) {
    if (!requested.has(member)) {
      throw new SemanticExecutionError(
        "ORDER_MEMBER_NOT_REQUESTED",
        `Order member '${member}' must also be requested as a measure or dimension.`,
        ["order", index, 0]
      )
    }
  }
  return Object.freeze({
    dimensions: Object.freeze(dimensions),
    measures: Object.freeze(measures),
    rowMembers,
    segments: Object.freeze(segments),
    timeDimensions: Object.freeze(timeDimensions),
  })
}

function requireKind<Expected extends SemanticMemberKind>(
  definition: SemanticMemberDefinition,
  expected: Expected,
  path: SemanticExecutionPath
): asserts definition is Extract<SemanticMemberDefinition, { kind: Expected }> {
  if (definition.kind === expected) return
  throw new SemanticExecutionError(
    "MEMBER_KIND_UNSUPPORTED",
    `Member '${definition.name}' is a ${definition.kind}; expected a ${expected}.`,
    path
  )
}

function validateFilters(
  filters: readonly SemanticFilter[],
  resolve: (
    name: SemanticMemberName,
    path: SemanticExecutionPath
  ) => SemanticMemberDefinition
) {
  const visit = (filter: SemanticFilter, path: SemanticExecutionPath): void => {
    if ("member" in filter) {
      const definition = resolve(filter.member, [...path, "member"])
      requireKind(definition, "dimension", [...path, "member"])
      if (filter.path && definition.filterValueType !== "json") {
        throw new SemanticExecutionError(
          "MODEL_QUERY_INVALID",
          "JSON paths require a JSON filter member.",
          [...path, "path"]
        )
      }
      if (!definition.filterOperators.includes(filter.operator)) {
        throw new SemanticExecutionError(
          "FILTER_OPERATOR_UNSUPPORTED",
          `Operator '${filter.operator}' is not supported by '${filter.member}'.`,
          [...path, "operator"]
        )
      }
      return
    }
    if ("and" in filter)
      filter.and.forEach((child, index) =>
        visit(child, [...path, "and", index])
      )
    else
      filter.or.forEach((child, index) => visit(child, [...path, "or", index]))
  }
  filters.forEach((filter, index) => visit(filter, ["filters", index]))
}

function validateModelBounds(
  query: NormalizedSemanticQuery,
  model: SemanticModel
) {
  const maxLimit = Math.min(
    model.maxLimit ?? MAX_SEMANTIC_LIMIT,
    MAX_SEMANTIC_LIMIT
  )
  if (query.limit > maxLimit) {
    throw new SemanticExecutionError(
      "MODEL_LIMIT_EXCEEDED",
      `Limit cannot exceed ${maxLimit} for semantic model '${model.name}'.`,
      ["limit"]
    )
  }
  if (model.maxWindowDays === undefined) return
  for (const [index, dimension] of query.timeDimensions.entries()) {
    try {
      parseSemanticWindow(
        {
          from: dimension.dateRange[0],
          to: dimension.dateRange[1],
          timezone: query.timezone,
        },
        { maxDays: model.maxWindowDays }
      )
    } catch (error) {
      if (error instanceof RangeError) {
        throw new SemanticExecutionError(
          "MODEL_WINDOW_EXCEEDED",
          error.message,
          ["timeDimensions", index, "dateRange"]
        )
      }
      throw error
    }
  }
}

function resolveOrder(
  query: NormalizedSemanticQuery,
  model: SemanticModel,
  rowMembers: readonly SemanticMemberName[]
): readonly SemanticOrder[] {
  const requested = new Set(rowMembers)
  const source = query.order.length ? query.order : (model.defaultOrder ?? [])
  const order: SemanticOrder[] = []
  const seen = new Set<string>()
  for (const [member, direction] of source) {
    if (!requested.has(member) || seen.has(member)) continue
    seen.add(member)
    order.push([member, direction])
  }
  for (const member of [...rowMembers].sort(compareNames)) {
    if (seen.has(member)) continue
    seen.add(member)
    order.push([member, "asc"])
  }
  return Object.freeze(
    order.map(([member, direction]) => [member, direction] as SemanticOrder)
  )
}

function freezeQuery(query: NormalizedSemanticQuery): NormalizedSemanticQuery {
  const filters = freezeFilters(query.filters)
  return Object.freeze({
    ...query,
    dimensions: Object.freeze([...query.dimensions]),
    filters: Object.freeze(filters),
    ...(query.having
      ? { having: Object.freeze(freezeFilters(query.having)) }
      : {}),
    measures: Object.freeze([...query.measures]),
    order: Object.freeze(
      query.order.map(
        ([member, direction]) => [member, direction] as SemanticOrder
      )
    ),
    segments: Object.freeze([...query.segments]),
    timeDimensions: Object.freeze(
      query.timeDimensions.map((entry) =>
        Object.freeze({
          ...entry,
          dateRange: Object.freeze([...entry.dateRange] as [string, string]),
        })
      )
    ),
  }) as NormalizedSemanticQuery
}

function freezeFilters(
  filters: readonly SemanticFilter[]
): readonly SemanticFilter[] {
  return filters.map((filter) => {
    if ("member" in filter) {
      return Object.freeze({
        ...filter,
        ...(filter.values ? { values: Object.freeze([...filter.values]) } : {}),
        ...(filter.path ? { path: Object.freeze([...filter.path]) } : {}),
      }) as SemanticFilter
    }
    if ("and" in filter)
      return Object.freeze({
        and: Object.freeze(freezeFilters(filter.and)),
      }) as SemanticFilter
    return Object.freeze({
      or: Object.freeze(freezeFilters(filter.or)),
    }) as SemanticFilter
  })
}

function validateModelResult(
  result: SemanticModelExecutionResult
): SemanticModelExecutionResult {
  if (!result || typeof result !== "object" || !Array.isArray(result.rows)) {
    throw new SemanticExecutionError(
      "INVALID_MODEL_RESULT",
      "Semantic model must return an array of rows.",
      ["rows"]
    )
  }
  for (const [index, row] of result.rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new SemanticExecutionError(
        "INVALID_MODEL_RESULT",
        "Semantic model rows must be objects.",
        ["rows", index]
      )
    }
    if (!semanticDataRowSchema.safeParse(row).success) {
      throw new SemanticExecutionError(
        "INVALID_MODEL_RESULT",
        "Semantic model rows must contain only JSON scalar values and member names.",
        ["rows", index]
      )
    }
  }
  const quality = semanticQualitySchema.safeParse(result.quality)
  if (!quality.success) {
    throw new SemanticExecutionError(
      "INVALID_MODEL_RESULT",
      "Semantic model quality metadata is invalid.",
      ["quality"]
    )
  }
  return { ...result, quality: quality.data, rows: result.rows }
}

function buildAnnotations(resolved: ResolvedQuery) {
  return {
    dimensions: buildAnnotationGroup(resolved.dimensions),
    measures: buildAnnotationGroup(resolved.measures),
    segments: buildAnnotationGroup(resolved.segments),
    timeDimensions: buildAnnotationGroup(resolved.timeDimensions),
  }
}

function buildAnnotationGroup(
  definitions: readonly SemanticMemberDefinition[]
): Record<string, SemanticMemberAnnotation> {
  const group: Record<string, SemanticMemberAnnotation> = {}
  for (const definition of [...definitions].sort((left, right) =>
    compareNames(left.name, right.name)
  )) {
    group[definition.name] = {
      ...(definition.basis ? { basis: definition.basis } : {}),
      ...(definition.currency ? { currency: definition.currency } : {}),
      ...(definition.estimated !== undefined
        ? { estimated: definition.estimated }
        : {}),
      ...(definition.format ? { format: definition.format } : {}),
      ...(definition.kind === "measure"
        ? { aggregation: definition.aggregation }
        : {}),
      ...(definition.unit ? { unit: definition.unit } : {}),
      definition: definition.definition,
      description: definition.description,
      kind: definition.kind,
      limitations: [...(definition.limitations ?? [])],
      ...Object.fromEntries(
        [
          "factIdentity",
          "eventTime",
          "denominator",
          "eligiblePopulation",
          "attribution",
          "overlap",
        ].flatMap((key) => {
          const value = definition[key as keyof typeof definition]
          return typeof value === "string" ? [[key, value]] : []
        })
      ),
      metricVersion: definition.metricVersion,
      name: definition.name,
      title: definition.title,
      type: definition.type,
    }
  }
  return group
}

function cloneQuality(quality: SemanticQuality): SemanticQuality {
  return {
    limitations: [...quality.limitations],
    status: quality.status,
    warnings: [...quality.warnings],
  }
}

function parseSnapshotInstant(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new SemanticExecutionError(
      "INVALID_SNAPSHOT",
      "Snapshot asOf must be a valid Date.",
      ["asOf"]
    )
  }
  return new Date(value.getTime())
}

function parseGeneratedAt(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new SemanticExecutionError(
      "INVALID_EXECUTION_OPTIONS",
      "now must return a valid Date.",
      ["now"]
    )
  }
  return new Date(value.getTime())
}

function compareNames(left: string, right: string) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
